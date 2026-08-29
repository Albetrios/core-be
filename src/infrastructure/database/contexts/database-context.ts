/**
 * THE database-context module — the three RLS scope patterns behind one roof:
 * principal (minted identity), session (pre-auth artifacts), and maintenance
 * (registry-dispatched bypasses). Callers use the pattern wrapper matching their
 * scope; a generic any-scope dispatcher was deliberately removed as unused API.
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
 * chain. `request` = authenticated HTTP request (JWT or API key), `job` = validated
 * BullMQ job payload, `verified` = an id the calling flow proved itself (invitation
 * match, Stripe-signed event, a row the flow just created).
 */
export type PrincipalScopeSource = 'request' | 'job' | 'verified';

/**
 * Unforgeable identity scope for one unit of database work: the verified user and/or
 * organization public ids a policy-visible GUC may be set to, plus the provenance of
 * those values.
 *
 * @remarks
 * The brand is compile-time only — services and repositories can relay a scope but
 * cannot construct one from raw strings. Only the {@link PRINCIPAL_SCOPE}
 * members build it, each confined to its boundary. Enforced by
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
 * every authenticated principal has an active organization; controllers narrow
 * to this via `requireOrganizationScope(request)`.
 */
export type OrganizationPrincipalDatabaseScope = PrincipalDatabaseScope & {
  readonly organizationPublicId: string;
};

/**
 * The common token scope narrowed to a real end user: `userPublicId` guaranteed,
 * organization OPTIONAL — controllers narrow to this via
 * `requireUserScope(request)` for user-owned resources (API keys rejected).
 *
 * @remarks
 * The organization stays optional here because user-scoped routes are the
 * self-heal surface of the personal/team-organization invariant: `GET /users/me`
 * provisions a missing personal organization on demand, so an org-less token is
 * a legitimate TRANSITIONAL state on this family (and only this family — the
 * org-scoped accessor still 403s it).
 */
export type UserPrincipalDatabaseScope = PrincipalDatabaseScope & {
  readonly userPublicId: string;
};

// Minting primitive — file-private: the ONLY constructor of the branded scope.
// Reachable exclusively through the PRINCIPAL_SCOPE members below.
function createPrincipalDatabaseScope(input: {
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
 * Raw pre-proven identity ids accepted by every {@link PRINCIPAL_SCOPE} member —
 * always an object, whichever ids are present get armed by the app wrapper.
 */
export interface PrincipalScopeIdentityInput {
  readonly userPublicId?: string | undefined;
  readonly organizationPublicId?: string | undefined;
}

/**
 * One {@link PRINCIPAL_SCOPE} member — overloads narrow the returned scope from
 * the identity shape passed (org-bearing → organization scope, user-only → user
 * scope), matching the service signatures that demand one or the other.
 */
export interface PrincipalScopeMinter {
  (identity: {
    organizationPublicId: string;
    userPublicId?: string;
  }): OrganizationPrincipalDatabaseScope;
  (identity: {
    userPublicId: string;
    organizationPublicId?: undefined;
  }): UserPrincipalDatabaseScope;
  (identity: PrincipalScopeIdentityInput): PrincipalDatabaseScope;
}

/**
 * THE principal-scope family namespace — one member per legitimate source of
 * pre-proven raw ids, each stamping its own provenance:
 *
 * - `PRINCIPAL_SCOPE.REQUEST` — ids read off the verified JWT / API key by the
 *   auth middleware, which attaches the minted scope as `request.principalScope`.
 *   Mintable ONLY from the auth middleware (and the test request helper).
 * - `PRINCIPAL_SCOPE.JOB` — ids from a zod-validated BullMQ job payload, written
 *   at enqueue time by already-scoped code. Mintable ONLY from worker-runtime.
 * - `PRINCIPAL_SCOPE.VERIFIED` — ids the calling flow proved itself (invitation
 *   match, Stripe-signed event, row the flow just created). Every caller is
 *   enumerated in the verified-usage ledger test.
 *
 * @remarks
 * Per-member usage allowlists are pinned by
 * `principal-scope-minting.policy.unit.test.ts` and
 * `verified-scope-usage.policy.unit.test.ts`. Members verify nothing — proof
 * happens once, upstream, per boundary; an empty identity throws
 * {@link ConfigurationError} via the private factory.
 */
export const PRINCIPAL_SCOPE: {
  readonly REQUEST: PrincipalScopeMinter;
  readonly JOB: PrincipalScopeMinter;
  readonly VERIFIED: PrincipalScopeMinter;
} = Object.freeze({
  REQUEST: ((identity: PrincipalScopeIdentityInput) =>
    createPrincipalDatabaseScope({ ...identity, source: 'request' })) as PrincipalScopeMinter,
  JOB: ((identity: PrincipalScopeIdentityInput) =>
    createPrincipalDatabaseScope({ ...identity, source: 'job' })) as PrincipalScopeMinter,
  VERIFIED: ((identity: PrincipalScopeIdentityInput) =>
    createPrincipalDatabaseScope({ ...identity, source: 'verified' })) as PrincipalScopeMinter,
});

// The principal branch of withAppDatabaseContext: same-org reuse, user-GUC
// layering, and a fresh transaction with both identity GUCs in one round trip
// otherwise. Only reachable through the exported app wrapper.
async function runPrincipalDatabaseContext<T>(
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
  sessionPublicId: { guc: 'app.current_session_public_id' },
  sessionTokenHash: { guc: 'app.current_session_token_hash' },
} as const satisfies Record<string, { readonly guc: string }>;

/** Derived — the closed set of session-artifact field names (each names its GUC). */
export type SessionContextKind = keyof typeof SESSION_CONTEXTS;

declare const SESSION_SCOPE_BRAND: unique symbol;

/**
 * Unforgeable pre-auth session scope — named artifact fields, exactly one
 * present, mirroring the principal grammar (`sessionPublicId` →
 * `app.current_session_public_id`, `sessionTokenHash` →
 * `app.current_session_token_hash`).
 *
 * @remarks
 * Minted only by {@link SESSION_SCOPE}.ARTIFACT, whose usage is confined to the
 * auth domain by the session-context confinement policy test.
 */
export interface SessionDatabaseScope {
  readonly sessionPublicId?: string;
  readonly sessionTokenHash?: string;
  readonly [SESSION_SCOPE_BRAND]: true;
}

/**
 * The session-artifact input — exactly one named field, the artifact the
 * pre-auth flow holds. The field name selects the GUC; the value fills it.
 */
export type SessionArtifactInput =
  | { readonly sessionPublicId: string; readonly sessionTokenHash?: undefined }
  | { readonly sessionTokenHash: string; readonly sessionPublicId?: undefined };

/**
 * The session-scope family namespace — one member, because session scopes have
 * one source: the artifact itself (`SESSION_SCOPE.ARTIFACT({ sessionPublicId })`
 * or `({ sessionTokenHash })`; the field passed decides which GUC is armed).
 * The ONLY way to obtain a {@link SessionDatabaseScope}; usage is confined to
 * the auth domain by `session-context-confinement.policy.unit.test.ts`.
 */
export const SESSION_SCOPE: {
  readonly ARTIFACT: (artifact: SessionArtifactInput) => SessionDatabaseScope;
} = Object.freeze({
  ARTIFACT: (artifact: SessionArtifactInput): SessionDatabaseScope => {
    const { sessionPublicId, sessionTokenHash } = artifact;
    if ((sessionPublicId === undefined) === (sessionTokenHash === undefined)) {
      throw new ConfigurationError(
        'SessionDatabaseScope requires exactly one of sessionPublicId / sessionTokenHash.',
      );
    }
    if ((sessionPublicId ?? sessionTokenHash ?? '').length === 0) {
      throw new ConfigurationError('SessionDatabaseScope requires a non-empty artifact value.');
    }
    return { sessionPublicId, sessionTokenHash } as SessionDatabaseScope;
  },
});

// The session branch of withAppDatabaseContext: exactly one session-artifact
// GUC (the field present names it), always a fresh transaction (pre-auth flows
// never nest), HTTP timeouts kept. Only reachable through the exported app wrapper.
async function runSessionDatabaseContext<T>(
  scope: SessionDatabaseScope,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  const armed =
    scope.sessionPublicId !== undefined
      ? { guc: SESSION_CONTEXTS.sessionPublicId.guc, value: scope.sessionPublicId }
      : { guc: SESSION_CONTEXTS.sessionTokenHash.guc, value: scope.sessionTokenHash as string };
  incrementOrganizationRlsCheckoutCount();
  const checkoutStartedAtNanoseconds = process.hrtime.bigint();
  try {
    return await database.transaction(async (transaction) => {
      const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await setLocalDatabaseConfig(databaseHandle, armed.guc, armed.value);
      return runWithPinnedDatabaseHandle(databaseHandle, () =>
        callback(brandWorkerContextDatabaseHandle(databaseHandle)),
      );
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

/**
 * A scope accepted by {@link withAppDatabaseContext} — a verified principal
 * (organization/user identity) or a pre-auth session artifact. Both run on the
 * shared `core_be_app` pool; the scope alone decides which GUCs are armed.
 */
export type AppDatabaseScope = PrincipalDatabaseScope | SessionDatabaseScope;

/**
 * THE unit-of-work wrapper for the application (`core_be_app`) pool: opens one
 * transaction, arms exactly the GUCs the scope carries, pins the handle in ALS,
 * and releases everything at COMMIT/ROLLBACK. The name states the connection
 * role; the scope states the identity — principal scopes arm
 * `app.current_user_public_id` / `app.current_organization_public_id`, session
 * scopes arm their single session-artifact GUC.
 *
 * @remarks
 * - **Algorithm:** dispatches on the scope brand. Principal scopes reuse a
 *   pinned same-organization unit of work (user GUC layered, no second
 *   checkout) and otherwise open a fresh transaction setting both identity
 *   GUCs in one round trip; session scopes always open a fresh transaction
 *   (pre-auth flows never nest) and set the artifact GUC via
 *   {@link SESSION_CONTEXTS}.
 * - **Failure modes:** any callback error rolls the transaction back; the GUCs
 *   die with the transaction (`SET LOCAL` semantics — nothing to unset).
 * - **Side effects:** organization-bearing and session scopes take one pooled
 *   checkout, counted for the pool-exhaustion alerter and the
 *   `database_rls_checkout_hold_seconds` histogram.
 * - **Notes:** worker runtime lifts the HTTP statement/lock timeouts for
 *   job-scope units of work; HTTP paths keep the connection-level caps. This
 *   wrapper can only ever set identity/session GUCs — bypass GUCs
 *   (`app.global_*`, retention, audit-drain) have no path through it, pinned by
 *   its unit tests. External I/O (Stripe, S3, Resend) must not run inside the
 *   callback. The callback shape is deliberate — release is impossible to
 *   forget, commit-vs-rollback is automatic, and nesting reuses the transaction
 *   (see rls-architecture.md).
 */
export async function withAppDatabaseContext<T>(
  scope: AppDatabaseScope,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return 'source' in scope
    ? runPrincipalDatabaseContext(scope, callback)
    : runSessionDatabaseContext(scope, callback);
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
  GLOBAL_RETENTION_CLEANUP: {
    guc: 'app.global_retention_cleanup',
    opensTransaction: true,
    workerContextKind: 'global_retention_cleanup',
    appliesWorkerStatementTimeout: true,
    grants: 'cross-tenant read/delete via the USING bypass arms on tenant policies',
  },
  SESSION_RETENTION_CLEANUP: {
    guc: 'app.session_retention_cleanup',
    opensTransaction: true,
    workerContextKind: 'session_retention_cleanup',
    appliesWorkerStatementTimeout: true,
    grants: 'cross-user delete on auth.sessions',
  },
  GLOBAL_ADMIN: {
    guc: 'app.global_admin',
    opensTransaction: true,
    workerContextKind: 'global_admin',
    appliesWorkerStatementTimeout: false,
    grants: 'cross-user/cross-tenant reads on auth.users, auth.auth_methods, audit.logs',
  },
  SYSTEM_AUDIT_INSERT: {
    guc: 'app.system_audit_insert',
    opensTransaction: true,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: false,
    grants: 'tenantless INSERT into audit.logs (organization_id IS NULL only)',
  },
  AUDIT_OUTBOX_DRAIN: {
    guc: 'app.audit_outbox_drain',
    opensTransaction: true,
    workerContextKind: 'audit_outbox_drain',
    appliesWorkerStatementTimeout: true,
    grants: 'exclusive SELECT/UPDATE/DELETE on audit.outbox',
  },
  SYSTEM_TABLE_RETENTION: {
    guc: null,
    opensTransaction: true,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: true,
    grants: 'pure-DB bulk retention on non-RLS tables (e.g. billing.stripe_webhook_events)',
  },
  SYSTEM_TABLE_WORKER: {
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
