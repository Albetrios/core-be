import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
  type PrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/** Org shape → org-narrowed scope (optionally carrying the user too). */
export function resolveVerifiedPrincipalScope(input: {
  organizationPublicId: string;
  userPublicId?: string;
}): OrganizationPrincipalDatabaseScope;
/** User-only shape → user-narrowed scope. */
export function resolveVerifiedPrincipalScope(input: {
  userPublicId: string;
  organizationPublicId?: undefined;
}): UserPrincipalDatabaseScope;
/**
 * THE common verified/port-family minter (`source: 'verified'`): pass what the
 * calling flow has itself verified — the other identity stays empty, and the wrapper
 * later sets only the GUCs the scope carries. Overloads narrow the return type from
 * the shape you pass, so org-required / user-required signatures still typecheck.
 *
 * @remarks
 * - **Algorithm:** wraps the verified id(s) in a principal scope with verified
 *   provenance; the factory's empty-scope guard is the only failure mode.
 * - **Notes:** authority comes from a record the caller owns or just authorized (an
 *   invitation row, an API key row, a just-provisioned organization, a Stripe
 *   mapping) — never from a token. Every importer is enumerated in
 *   `verified-scope-usage.policy.unit.test.ts`; adding one is a deliberate
 *   policy-test edit, never casual.
 */
export function resolveVerifiedPrincipalScope(input: {
  organizationPublicId?: string | undefined;
  userPublicId?: string | undefined;
}): PrincipalDatabaseScope {
  return createPrincipalDatabaseScope({
    organizationPublicId: input.organizationPublicId,
    userPublicId: input.userPublicId,
    source: 'verified',
  });
}
