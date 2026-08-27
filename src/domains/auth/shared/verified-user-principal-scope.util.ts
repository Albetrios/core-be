import {
  createPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';

/**
 * Mints the pre-token user scope for auth flows — the `provisioning`-source
 * counterpart of `requireUserPrincipalDatabaseScope` for the moments BEFORE a
 * JWT exists: the flow itself just verified (password/OAuth/WebAuthn/MFA) or
 * created the user, and that verification IS the authority.
 *
 * @remarks
 * - **Algorithm:** wraps the freshly verified/created user public id in a
 *   user-only scope, `source: 'provisioning'`.
 * - **Failure modes:** none beyond the factory's empty-scope guard.
 * - **Side effects:** none.
 * - **Notes:** confined to the auth domain by the principal-scope minting
 *   policy test — request handlers with a token must use the request minters.
 */
export function resolveVerifiedUserPrincipalScope(
  userPublicId: string,
): UserPrincipalDatabaseScope {
  return createPrincipalDatabaseScope({
    userPublicId,
    source: 'provisioning',
  }) as UserPrincipalDatabaseScope;
}
