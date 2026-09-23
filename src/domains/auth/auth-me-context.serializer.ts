import type { AuthMeContextData, AuthMeContextOutput } from './auth-me-context.types.js';

/**
 * Serializes the aggregated {@link AuthMeContextData} into the public
 * `GET /auth/me/context` response. Every field is already a public shape and
 * passes through unchanged.
 *
 * @remarks
 * The organization LIST is not part of this response — it lives at
 * `GET /users/me/organizations`, which pages. Embedded here it was a flat array
 * with no cursor, so a caller in more than 25 organizations was silently
 * truncated.
 */
export function serializeAuthMeContext(data: AuthMeContextData): AuthMeContextOutput {
  return {
    user: data.user,
    active_organization: data.activeOrganization,
    my_permissions: data.myPermissions,
    global_role: data.globalRole,
  };
}
