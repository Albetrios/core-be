import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import {
  getOrganizationRequestDatabaseSession,
  runWithPinnedDatabaseHandle,
  runWithPinnedOrganizationDatabaseSession,
  setLocalDatabaseConfig,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/request-database.context.js';
import {
  isWorkerRuntime,
  runWithWorkerDatabaseContext,
  workerDatabaseContextForOrganization,
  workerDatabaseContextForUser,
} from '@/infrastructure/database/contexts/worker-database.context.js';
import { applyWorkerStatementTimeout } from '@/infrastructure/database/contexts/worker-statement-timeout.util.js';
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
 * transaction, sets the identity GUCs the scope carries (`app.current_user_id`
 * and/or `app.current_organization_id`) in a single `set_config` statement, pins the
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
          'app.current_user_id',
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
        'app.current_user_id',
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
    return drizzleSql`SELECT set_config('app.current_user_id', ${userPublicId}, true), set_config('app.current_organization_id', ${organizationPublicId}, true)`;
  }
  if (organizationPublicId !== undefined) {
    return drizzleSql`SELECT set_config('app.current_organization_id', ${organizationPublicId}, true)`;
  }
  return drizzleSql`SELECT set_config('app.current_user_id', ${userPublicId as string}, true)`;
}
