import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
  type PrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { ConfigurationError } from '@/shared/errors/index.js';

/** Org-bearing payload → org-narrowed scope (optionally carrying the user too). */
export function resolveJobPrincipalScope(payload: {
  organizationPublicId: string;
  userPublicId?: string;
}): OrganizationPrincipalDatabaseScope;
/** User-only payload → user-narrowed scope. */
export function resolveJobPrincipalScope(payload: {
  userPublicId: string;
  organizationPublicId?: undefined;
}): UserPrincipalDatabaseScope;
/** Discriminator-optional payload (generic runners) → unnarrowed scope. */
export function resolveJobPrincipalScope(payload: {
  organizationPublicId?: string | undefined;
  userPublicId?: string | undefined;
}): PrincipalDatabaseScope;
/**
 * Mints the `job`-source {@link PrincipalDatabaseScope} for a BullMQ processor —
 * the worker-runtime counterpart of `REQUEST_SCOPE.organization`.
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
