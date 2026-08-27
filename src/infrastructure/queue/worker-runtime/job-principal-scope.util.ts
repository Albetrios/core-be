import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
  type PrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { ConfigurationError } from '@/shared/errors/index.js';

/**
 * Mints the `job`-source {@link PrincipalDatabaseScope} for a BullMQ processor —
 * the worker-runtime counterpart of `resolvePrincipalDatabaseScope`.
 *
 * @remarks
 * - **Algorithm:** trusts the validated job payload discriminators
 *   (`organizationPublicId` / `userPublicId`) that the enqueue site — itself
 *   running inside an already-scoped request — was required to include, and
 *   stamps `source: 'job'`.
 * - **Failure modes:** throws {@link ConfigurationError} when neither identity is
 *   present — a scope-less job is always an enqueue-site bug.
 * - **Side effects:** none.
 * - **Notes:** confined to worker-runtime/worker paths by the principal-scope
 *   minting policy test; HTTP code must never mint job-source scopes.
 */
export function resolveJobPrincipalScope(payload: {
  organizationPublicId?: string | undefined;
  userPublicId?: string | undefined;
}): PrincipalDatabaseScope {
  if (payload.organizationPublicId === undefined && payload.userPublicId === undefined) {
    throw new ConfigurationError(
      'resolveJobPrincipalScope requires organizationPublicId and/or userPublicId in the job payload.',
    );
  }
  return createPrincipalDatabaseScope({
    organizationPublicId: payload.organizationPublicId,
    userPublicId: payload.userPublicId,
    source: 'job',
  });
}

/** {@link resolveJobPrincipalScope} narrowed to organization-scoped jobs. */
export function resolveOrganizationJobScope(
  organizationPublicId: string,
): OrganizationPrincipalDatabaseScope {
  return resolveJobPrincipalScope({ organizationPublicId }) as OrganizationPrincipalDatabaseScope;
}

/** {@link resolveJobPrincipalScope} narrowed to user-scoped jobs. */
export function resolveUserJobScope(userPublicId: string): UserPrincipalDatabaseScope {
  return resolveJobPrincipalScope({ userPublicId }) as UserPrincipalDatabaseScope;
}
