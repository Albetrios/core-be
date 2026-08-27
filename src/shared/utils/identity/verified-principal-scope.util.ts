import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';

/**
 * Mints a user-only principal scope from an id the calling flow has itself
 * verified or derived from an owned record — the pre-token / port-family
 * counterpart of the request minters (`source: 'provisioning'`).
 *
 * @remarks
 * - **Algorithm:** wraps the verified user public id in a user-only scope.
 * - **Failure modes:** the factory's empty-scope guard only.
 * - **Side effects:** none.
 * - **Notes:** every importer is enumerated in
 *   `verified-scope-usage.policy.unit.test.ts` — the ledger of port-family
 *   sites still pending full scope-threading. Adding an importer is a
 *   deliberate policy-test edit, never casual.
 */
export function resolveVerifiedUserPrincipalScope(
  userPublicId: string,
): UserPrincipalDatabaseScope {
  return createPrincipalDatabaseScope({
    userPublicId,
    source: 'provisioning',
  }) as UserPrincipalDatabaseScope;
}

/**
 * Mints an organization-only principal scope from an id the calling flow
 * derived from an owned/authorized record (an invitation row, an API key row, a
 * just-provisioned organization, a Stripe mapping) — authority comes from that
 * record, not a token (`source: 'provisioning'`).
 *
 * @remarks
 * Same per-importer ledger discipline as
 * {@link resolveVerifiedUserPrincipalScope}.
 */
export function resolveVerifiedOrganizationPrincipalScope(
  organizationPublicId: string,
): OrganizationPrincipalDatabaseScope {
  return createPrincipalDatabaseScope({
    organizationPublicId,
    source: 'provisioning',
  }) as OrganizationPrincipalDatabaseScope;
}
