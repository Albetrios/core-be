/**
 * THE database-context module — the three RLS scope patterns behind one roof:
 * principal (minted identity), session (pre-auth artifacts), and maintenance
 * (registry-dispatched bypasses), plus the common {@link withDatabaseContext}
 * dispatcher that accepts any scope and routes it to its pattern wrapper.
 *
 * @remarks
 * - **Notes:** this file and `database-context-runtime.ts` (plumbing) are the
 *   ONLY files allowed in `contexts/` — pinned by
 *   `context-directory-standard.policy.unit.test.ts`. A new way to open an
 *   RLS-scoped context is a new KIND in one of the three registries here,
 *   never a new file or wrapper.
 */
import { sql as drizzleSql } from 'drizzle-orm';
import * as databaseConnection from '@/infrastructure/database/connection.js';
import { database } from '@/infrastructure/database/connection.js';

/**
 * Pool selector for maintenance (bypass) contexts: the dedicated maintenance
 * pool when `DATABASE_MAINTENANCE_URL` is provisioned, else the shared pool.
 * Accessed via the module namespace with an optional call so unit tests that
 * mock `connection.js` with only `database` keep working unchanged.
 */
function resolveMaintenancePool(): typeof database {
  // try/catch (not just optional call): a Vitest module mock THROWS on access to
  // an export its factory did not define, and many suites mock connection.js with
  // only `database` — they must keep the historical shared-pool behavior.
  try {
    return (
      (databaseConnection.getMaintenanceDatabase?.() as typeof database | undefined) ?? database
    );
  } catch {
    return database;
  }
}
import {
  applyWorkerStatementTimeout,
  getOrganizationRequestDatabaseSession,
  isWorkerRuntime,
  runWithPinnedDatabaseHandle,
  runWithPinnedOrganizationDatabaseSession,
  runWithWorkerDatabaseContext,
  setLocalDatabaseConfig,
  workerDatabaseContextForOrganization,
  workerDatabaseContextForUser,
  type RequestScopedPostgresDatabase,
  type WorkerDatabaseContextKind,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  decrementOrganizationRlsCheckoutCount,
  incrementOrganizationRlsCheckoutCount,
  observeOrganizationRlsCheckoutHold,
} from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import {
  brandWorkerContextDatabaseHandle,
  type WorkerContextDatabaseHandle,
} from '@/infrastructure/database/utils/database-handle.types.js';
import { ConfigurationError } from '@/shared/errors/index.js';

declare const PRINCIPAL_SCOPE_BRAND: unique symbol;

/**
 * Where a {@link PrincipalDatabaseScope} was minted — the legitimate "tops" of a call
 * chain. `token` = authenticated HTTP request (JWT or API key), `job` = validated
 * BullMQ job payload, `provisioning` = a row the current flow just created (e.g. a
 * personal organization during signup, before any claim can exist for it).
 */
export type PrincipalScopeSource = 'token' | 'job' | 'provisioning';

/**
 * Unforgeable identity scope for one unit of database work: the verified user and/or
 * organization public ids a policy-visible GUC may be set to, plus the provenance of
 * those values.
 *
 * @remarks
 * The brand is compile-time only — services and repositories can relay a scope but
 * cannot construct one from raw strings. Only the confined minters build it:
 * `resolvePrincipalDatabaseScope` / `requireUserPrincipalDatabaseScope`
 * (request layer, claim-precedence) and, in later phases, the worker-payload and
 * provisioning minters. Enforced by
 * `src/tests/unit/infrastructure/database/principal-scope-minting.policy.unit.test.ts`.
 */
export interface PrincipalDatabaseScope {
  readonly userPublicId?: string;
  readonly organizationPublicId?: string;
  readonly source: PrincipalScopeSource;
  readonly [PRINCIPAL_SCOPE_BRAND]: true;
}

/**
 * A {@link PrincipalDatabaseScope} guaranteed to carry an organization — what
 * org-scoped service methods accept. Under the personal/team organization model
 * every authenticated principal has an active organization, so this is what the
 * single request minter `resolvePrincipalDatabaseScope` returns.
 */
export type OrganizationPrincipalDatabaseScope = PrincipalDatabaseScope & {
  readonly organizationPublicId: string;
};

/**
 * The common token scope narrowed to a real end user: `userPublicId` guaranteed,
 * organization OPTIONAL — produced by `requireUserPrincipalDatabaseScope` for
 * user-owned resources (API keys rejected).
 *
 * @remarks
 * The organization stays optional here because user-scoped routes are the
 * self-heal surface of the personal/team-organization invariant: `GET /users/me`
 * provisions a missing personal organization on demand, so an org-less token is
 * a legitimate TRANSITIONAL state on this family (and only this family — the
 * org-scoped minter still rejects it).
 */
export type UserPrincipalDatabaseScope = PrincipalDatabaseScope & {
  readonly userPublicId: string;
};

/**
 * Minting primitive for {@link PrincipalDatabaseScope} — do NOT import outside the
 * confined minters (`request.util.ts`, worker-runtime, provisioning) and tests.
 *
 * @remarks
 * - **Algorithm:** validates that at least one identity is present and stamps the
 *   provenance; the brand exists only at the type level.
 * - **Failure modes:** throws {@link ConfigurationError} for an empty scope — an
 *   empty scope would open a transaction whose queries all fail closed, which is
 *   always a programming error at the minting site.
 * - **Side effects:** none.
 * - **Notes:** confinement is enforced by the principal-scope-minting policy test;
 *   adding a new importer requires extending that test's allowlist deliberately.
 */
export function createPrincipalDatabaseScope(input: {
  userPublicId?: string | undefined;
  organizationPublicId?: string | undefined;
  source: PrincipalScopeSource;
}): PrincipalDatabaseScope {
  if (input.userPublicId === undefined && input.organizationPublicId === undefined) {
    throw new ConfigurationError(
      'PrincipalDatabaseScope requires at least one of userPublicId / organizationPublicId.',
    );
  }
  return {
    userPublicId: input.userPublicId,
    organizationPublicId: input.organizationPublicId,
    source: input.source,
  } as PrincipalDatabaseScope;
}

/**
 * The common unit-of-work wrapper for principal-scoped database access: opens one
 * transaction, sets the identity GUCs the scope carries (`app.current_user_public_id`
 * and/or `app.current_organization_public_id`) in a single `set_config` statement, pins the
 * handle in ALS, and releases everything at COMMIT/ROLLBACK.
 *
 * @remarks
 * - **Algorithm:** when a pinned session for the SAME organization is already active
 *   (an outer principal/organization unit of work), the existing handle is reused —
 *   the user GUC is layered onto it and no new transaction or pool checkout is
 *   opened. Otherwise a fresh transaction is opened and both GUCs are set in one
 *   round trip.
 * - **Failure modes:** any error from the callback rolls the transaction back; the
 *   GUCs die with the transaction (`SET LOCAL` semantics — nothing to unset).
 * - **Side effects:** organization-bearing scopes take one pooled checkout, counted
 *   for the pool-exhaustion alerter and the `database_rls_checkout_hold_seconds`
 *   histogram.
 * - **Notes:** this wrapper lifts the HTTP statement/lock timeouts only in worker
 *   runtime (job-scope units of work); HTTP paths keep the connection-level caps and can only ever set the two identity
 *   GUCs — bypass GUCs (`app.global_*`, retention, audit-drain) have no path through
 *   it, pinned by its unit tests. External I/O (Stripe, S3, Resend) must not run
 *   inside the callback.
 */
export async function withPrincipalDatabaseContext<T>(
  scope: PrincipalDatabaseScope,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  const { userPublicId, organizationPublicId } = scope;
  const workerContext =
    organizationPublicId !== undefined
      ? workerDatabaseContextForOrganization(organizationPublicId)
      : workerDatabaseContextForUser(userPublicId as string);

  const activeSession = getOrganizationRequestDatabaseSession();
  if (
    activeSession !== undefined &&
    organizationPublicId !== undefined &&
    activeSession.organizationPublicId === organizationPublicId
  ) {
    return runWithWorkerDatabaseContext(workerContext, async () => {
      if (userPublicId !== undefined) {
        await setLocalDatabaseConfig(
          activeSession.databaseHandle,
          'app.current_user_public_id',
          userPublicId,
        );
      }
      return callback(brandWorkerContextDatabaseHandle(activeSession.databaseHandle));
    });
  }

  // USER-ONLY scopes reuse ANY pinned handle (carried over from the legacy user
  // context): under FORCE RLS, auth.users / auth.auth_methods / auth.sessions FK
  // and RLS-subquery a user row that may be UNCOMMITTED in the surrounding
  // transaction (OAuth find-or-create), so a second pooled connection could
  // neither see it nor preserve atomicity. Only the user GUC is layered — the
  // pinned session's org GUC (if any) is left untouched, so an outer org scope
  // is never overwritten.
  if (
    activeSession !== undefined &&
    organizationPublicId === undefined &&
    userPublicId !== undefined
  ) {
    return runWithWorkerDatabaseContext(workerContext, async () => {
      await setLocalDatabaseConfig(
        activeSession.databaseHandle,
        'app.current_user_public_id',
        userPublicId,
      );
      return callback(brandWorkerContextDatabaseHandle(activeSession.databaseHandle));
    });
  }

  const countsAsOrganizationCheckout = organizationPublicId !== undefined;
  if (countsAsOrganizationCheckout) {
    incrementOrganizationRlsCheckoutCount();
  }
  const checkoutStartedAtNanoseconds = process.hrtime.bigint();
  try {
    return await runWithWorkerDatabaseContext(workerContext, () =>
      database.transaction(async (transaction) => {
        const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
        // Worker runtime only: lift the HTTP statement/lock caps to the worker
        // budget for job-scope units of work (sec-re-16 semantics). HTTP paths
        // keep the connection-level caps — see PR #1122's rationale.
        if (isWorkerRuntime()) {
          await applyWorkerStatementTimeout(databaseHandle);
        }
        await databaseHandle.execute(
          buildIdentityGucStatement({ userPublicId, organizationPublicId }),
        );
        const runCallback = () => callback(brandWorkerContextDatabaseHandle(databaseHandle));
        return organizationPublicId !== undefined
          ? runWithPinnedOrganizationDatabaseSession(
              organizationPublicId,
              databaseHandle,
              runCallback,
            )
          : runWithPinnedDatabaseHandle(databaseHandle, runCallback);
      }),
    );
  } finally {
    if (countsAsOrganizationCheckout) {
      decrementOrganizationRlsCheckoutCount();
      observeOrganizationRlsCheckoutHold({
        path: 'scoped_context',
        durationSeconds:
          Number(process.hrtime.bigint() - checkoutStartedAtNanoseconds) / 1_000_000_000,
      });
    }
  }
}

/**
 * Builds the single `SELECT set_config(...)` statement for the identity GUCs a scope
 * carries — one round trip whether the scope has one identity or both. The two GUC
 * keys named here are the ONLY keys this module can ever set.
 */
function buildIdentityGucStatement(identity: {
  userPublicId?: string | undefined;
  organizationPublicId?: string | undefined;
}) {
  const { userPublicId, organizationPublicId } = identity;
  if (userPublicId !== undefined && organizationPublicId !== undefined) {
    return drizzleSql`SELECT set_config('app.current_user_public_id', ${userPublicId}, true), set_config('app.current_organization_public_id', ${organizationPublicId}, true)`;
  }
  if (organizationPublicId !== undefined) {
    return drizzleSql`SELECT set_config('app.current_organization_public_id', ${organizationPublicId}, true)`;
  }
  return drizzleSql`SELECT set_config('app.current_user_public_id', ${userPublicId as string}, true)`;
}

/**
 * THE registry of pre-auth session database contexts — the single source of
 * truth for the session-artifact GUCs: each kind names the `app.*` GUC that
 * lets RLS resolve exactly one `auth.sessions` row by that artifact.
 *
 * @remarks
 * - **Notes:** session contexts run BEFORE a verified identity exists — the
 *   artifact (cookie session public id, or a token hash) IS the identity being
 *   verified, which is why this family is separate from the principal scope and
 *   must never gain user/organization kinds. The policy arm for
 *   `app.current_session_refresh_token_hash` exists in migrations but has no
 *   kind here because no code path sets it — add the row only together with a
 *   real minting call site (or drop the arm in a migration).
 */
export const SESSION_CONTEXTS = {
  public_id: { guc: 'app.current_session_public_id' },
  token_hash: { guc: 'app.current_session_token_hash' },
} as const satisfies Record<string, { readonly guc: string }>;

/** Derived — the closed set of session-context kinds. */
export type SessionContextKind = keyof typeof SESSION_CONTEXTS;

declare const SESSION_SCOPE_BRAND: unique symbol;

/**
 * Unforgeable pre-auth session scope: which artifact kind identifies the
 * session, and the artifact value itself.
 *
 * @remarks
 * Minted only by {@link createSessionDatabaseScope}, whose importers are
 * confined to the auth domain by the session-context confinement policy test.
 */
export interface SessionDatabaseScope<K extends SessionContextKind = SessionContextKind> {
  readonly kind: K;
  readonly value: string;
  readonly [SESSION_SCOPE_BRAND]: true;
}

/**
 * Mints a {@link SessionDatabaseScope} from a session artifact — do NOT import
 * outside the auth domain (pinned by the confinement policy test).
 *
 * @remarks
 * - **Failure modes:** throws {@link ConfigurationError} for an empty artifact
 *   value — an empty GUC would silently match no session row.
 * - **Side effects:** none.
 */
export function createSessionDatabaseScope<K extends SessionContextKind>(
  kind: K,
  value: string,
): SessionDatabaseScope<K> {
  if (value.length === 0) {
    throw new ConfigurationError('SessionDatabaseScope requires a non-empty artifact value.');
  }
  return { kind, value } as SessionDatabaseScope<K>;
}

/**
 * The single wrapper for pre-auth session database contexts: opens one
 * transaction, sets the scope's session-artifact GUC, pins the handle in ALS,
 * and releases everything at COMMIT/ROLLBACK.
 *
 * @remarks
 * - **Algorithm:** dispatches on `scope.kind` through {@link SESSION_CONTEXTS};
 *   RLS then admits exactly the one `auth.sessions` row matching the artifact.
 * - **Failure modes:** callback errors roll the transaction back; the GUC dies
 *   with the transaction.
 * - **Side effects:** one Postgres transaction per call; HTTP statement/lock
 *   timeouts stay (these are request-path flows).
 */
export async function withSessionDatabaseContext<T>(
  scope: SessionDatabaseScope,
  callback: (databaseHandle: RequestScopedPostgresDatabase) => Promise<T>,
): Promise<T> {
  const definition = SESSION_CONTEXTS[scope.kind];
  incrementOrganizationRlsCheckoutCount();
  const checkoutStartedAtNanoseconds = process.hrtime.bigint();
  try {
    return await database.transaction(async (transaction) => {
      const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await setLocalDatabaseConfig(databaseHandle, definition.guc, scope.value);
      return runWithPinnedDatabaseHandle(databaseHandle, () => callback(databaseHandle));
    });
  } finally {
    decrementOrganizationRlsCheckoutCount();
    observeOrganizationRlsCheckoutHold({
      path: 'session_context',
      durationSeconds:
        Number(process.hrtime.bigint() - checkoutStartedAtNanoseconds) / 1_000_000_000,
    });
  }
}

/** One row of the maintenance-context registry — the GUC it arms and how its transaction is tuned. */
interface MaintenanceContextDefinition {
  /** The `app.*` GUC this kind sets to `'true'` — `null` for system-table kinds (non-RLS tables, no GUC). */
  readonly guc: string | null;
  /** Open a Postgres transaction (default behavior). `false` = pin the shared pool handle without a transaction — for callbacks that perform external I/O and must not hold a checkout across network calls. */
  readonly opensTransaction: boolean;
  /** ALS context kind pinned for worker-runtime assertions. */
  readonly workerContextKind: WorkerDatabaseContextKind;
  /** Lift the HTTP statement/lock timeouts to the worker budget (bulk background work). */
  readonly appliesWorkerStatementTimeout: boolean;
  /** Human-readable statement of what the RLS policies grant under this GUC. */
  readonly grants: string;
}

/**
 * THE registry of maintenance (bypass) database contexts — the single source of
 * truth for every `app.*` bypass GUC: which GUC each kind arms, how its
 * transaction is tuned, and (via {@link MAINTENANCE_SCOPE}) the only values that
 * can enter {@link withMaintenanceDatabaseContext}.
 *
 * @remarks
 * - **Notes:** every kind here is an RLS escape hatch — scopes are static frozen
 *   singletons (there is nothing per-request about maintenance authority), and
 *   which files may use each kind is pinned by
 *   `maintenance-context-confinement.policy.unit.test.ts`. Adding a kind means
 *   adding a row here, a policy arm in a migration, and a confinement entry —
 *   nothing else.
 */
export const MAINTENANCE_CONTEXTS = {
  global_retention_cleanup: {
    guc: 'app.global_retention_cleanup',
    opensTransaction: true,
    workerContextKind: 'global_retention_cleanup',
    appliesWorkerStatementTimeout: true,
    grants: 'cross-tenant read/delete via the USING bypass arms on tenant policies',
  },
  session_retention_cleanup: {
    guc: 'app.session_retention_cleanup',
    opensTransaction: true,
    workerContextKind: 'session_retention_cleanup',
    appliesWorkerStatementTimeout: true,
    grants: 'cross-user delete on auth.sessions',
  },
  global_admin: {
    guc: 'app.global_admin',
    opensTransaction: true,
    workerContextKind: 'global_admin',
    appliesWorkerStatementTimeout: false,
    grants: 'cross-user/cross-tenant reads on auth.users, auth.auth_methods, audit.logs',
  },
  system_audit_insert: {
    guc: 'app.system_audit_insert',
    opensTransaction: true,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: false,
    grants: 'tenantless INSERT into audit.logs (organization_id IS NULL only)',
  },
  audit_outbox_drain: {
    guc: 'app.audit_outbox_drain',
    opensTransaction: true,
    workerContextKind: 'audit_outbox_drain',
    appliesWorkerStatementTimeout: true,
    grants: 'exclusive SELECT/UPDATE/DELETE on audit.outbox',
  },
  system_table_retention: {
    guc: null,
    opensTransaction: true,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: true,
    grants: 'pure-DB bulk retention on non-RLS tables (e.g. billing.stripe_webhook_events)',
  },
  system_table_worker: {
    guc: null,
    opensTransaction: false,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: false,
    grants:
      'non-RLS table access from workers doing external I/O (mail outbox, ledgers) — no transaction held across network calls',
  },
} as const satisfies Record<string, MaintenanceContextDefinition>;

/** Derived — the closed set of maintenance-context kinds; never declared separately. */
export type MaintenanceContextKind = keyof typeof MAINTENANCE_CONTEXTS;

declare const MAINTENANCE_SCOPE_BRAND: unique symbol;

/**
 * Unforgeable static scope for one maintenance (bypass) context — generic over
 * the kind so code can demand one specific authority at the type level.
 *
 * @remarks
 * The only instances are the frozen singletons in {@link MAINTENANCE_SCOPE};
 * the brand is compile-time only and `Object.freeze` prevents runtime mutation
 * of `kind` (which would otherwise be an authority-escalation vector).
 */
export interface MaintenanceDatabaseScope<
  K extends MaintenanceContextKind = MaintenanceContextKind,
> {
  readonly kind: K;
  readonly [MAINTENANCE_SCOPE_BRAND]: true;
}

/**
 * The static maintenance scopes — one frozen singleton per kind, derived from
 * {@link MAINTENANCE_CONTEXTS}. These are the ONLY values accepted by
 * {@link withMaintenanceDatabaseContext}; which files may reference each kind is
 * pinned by the confinement policy test.
 */
export const MAINTENANCE_SCOPE: {
  readonly [K in MaintenanceContextKind]: MaintenanceDatabaseScope<K>;
} = Object.freeze(
  Object.fromEntries(
    (Object.keys(MAINTENANCE_CONTEXTS) as MaintenanceContextKind[]).map((kind) => [
      kind,
      Object.freeze({ kind }),
    ]),
  ),
) as never;

/** Options for {@link withMaintenanceDatabaseContext}. */
export type MaintenanceDatabaseContextOptions = {
  /** When true, `SET LOCAL ROLE core_be_app` so tests connected as the privileged owner role exercise production RLS. */
  useApplicationDatabaseRole?: boolean;
};

/**
 * The single wrapper for every maintenance (bypass) database context: opens one
 * transaction, arms exactly the scope's GUC (`set_config(<guc>, 'true', true)`),
 * pins the handle in ALS, and releases everything at COMMIT/ROLLBACK.
 *
 * @remarks
 * - **Algorithm:** dispatches on `scope.kind` through {@link MAINTENANCE_CONTEXTS}
 *   — worker-timeout tuning and the ALS context kind come from the same table
 *   row, so behavior per kind is declarative and undriftable.
 * - **Failure modes:** any callback error rolls the transaction back; the GUC
 *   dies with the transaction.
 * - **Side effects:** one Postgres transaction per call; bulk kinds lift the
 *   HTTP statement/lock timeouts to the worker budget.
 * - **SECURITY:** every kind bypasses tenant/user isolation on the tables its
 *   policies name. Enter it only from the paths the confinement policy test
 *   allows for that kind — worker processors, admin-authorized routes, and
 *   trusted system flows. Never on a self-service request path.
 */
export async function withMaintenanceDatabaseContext<T>(
  scope: MaintenanceDatabaseScope,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
  options?: MaintenanceDatabaseContextOptions,
): Promise<T> {
  const definition = MAINTENANCE_CONTEXTS[scope.kind];
  if (!definition.opensTransaction) {
    // Non-transactional kinds pin the shared pool handle so getRequestDatabase()
    // resolves in worker runtime WITHOUT holding a checkout across the callback's
    // external I/O (mail sends, BullMQ re-enqueues). Outside worker runtime the
    // handle is passed straight through with no ALS pinning — an HTTP caller
    // (stripe-webhook service, commit-dispatch executor) must not have its
    // request-pinned transaction handle shadowed by the bare pool.
    const maintenancePool = resolveMaintenancePool();
    if (!isWorkerRuntime()) {
      return callback(
        brandWorkerContextDatabaseHandle(
          maintenancePool as unknown as RequestScopedPostgresDatabase,
        ),
      );
    }
    return runWithWorkerDatabaseContext({ kind: definition.workerContextKind }, () =>
      runWithPinnedDatabaseHandle(maintenancePool as unknown as RequestScopedPostgresDatabase, () =>
        callback(
          brandWorkerContextDatabaseHandle(
            maintenancePool as unknown as RequestScopedPostgresDatabase,
          ),
        ),
      ),
    );
  }
  incrementOrganizationRlsCheckoutCount();
  const checkoutStartedAtNanoseconds = process.hrtime.bigint();
  try {
    return await runWithWorkerDatabaseContext({ kind: definition.workerContextKind }, () =>
      resolveMaintenancePool().transaction(async (transaction) => {
        const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
        if (options?.useApplicationDatabaseRole === true) {
          await databaseHandle.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
        }
        if (definition.appliesWorkerStatementTimeout) {
          await applyWorkerStatementTimeout(databaseHandle);
        }
        if (definition.guc !== null) {
          await setLocalDatabaseConfig(databaseHandle, definition.guc, 'true');
        }
        return runWithPinnedDatabaseHandle(databaseHandle, () =>
          callback(brandWorkerContextDatabaseHandle(databaseHandle)),
        );
      }),
    );
  } finally {
    decrementOrganizationRlsCheckoutCount();
    observeOrganizationRlsCheckoutHold({
      path: 'maintenance_context',
      durationSeconds:
        Number(process.hrtime.bigint() - checkoutStartedAtNanoseconds) / 1_000_000_000,
    });
  }
}

/** Any scope accepted by {@link withDatabaseContext} — one of the three patterns. */
export type DatabaseScope =
  | PrincipalDatabaseScope
  | SessionDatabaseScope
  | MaintenanceDatabaseScope;

/**
 * The ONE common entry point for every database context: dispatches the scope
 * to its pattern wrapper (principal / session / maintenance).
 *
 * @remarks
 * - **Algorithm:** principal scopes carry `source`; maintenance scopes carry a
 *   `kind` present in {@link MAINTENANCE_CONTEXTS}; everything else is a session
 *   scope. All three scope types are unforgeable (branded, minted only by their
 *   confined factories), so dispatch never needs to validate authority — the
 *   scope IS the authority.
 * - **Notes:** the per-pattern wrappers stay exported for callers that want the
 *   narrower signature (e.g. maintenance options); this dispatcher exists so
 *   generic plumbing can take "a scope" without knowing its pattern.
 */
export async function withDatabaseContext<T>(
  scope: DatabaseScope,
  callback: (databaseHandle: never) => Promise<T>,
): Promise<T> {
  if ('source' in scope) {
    return withPrincipalDatabaseContext(scope, callback as never);
  }
  if (scope.kind in MAINTENANCE_CONTEXTS) {
    return withMaintenanceDatabaseContext(scope as MaintenanceDatabaseScope, callback as never);
  }
  return withSessionDatabaseContext(scope as SessionDatabaseScope, callback as never);
}
