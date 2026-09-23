import type { GlobalRole } from '@/shared/constants/roles.constants.js';
import type { UserOutput } from '@/domains/user/user.types.js';
import type { OrganizationOutput } from '@/domains/tenancy/sub-domains/organization/organization.types.js';

/** Aggregated, pre-serialization context assembled by `AuthMeContextService.getContext`. */
export interface AuthMeContextData {
  user: UserOutput;
  activeOrganization: OrganizationOutput | null;
  myPermissions: string[];
  globalRole: GlobalRole | null;
}

/** Public response body for `GET /api/v1/auth/me/context`. */
export interface AuthMeContextOutput {
  /** The authenticated caller's own profile (same shape as `GET /users/me`). */
  user: UserOutput;
  /** The active organization (with type-derived `capabilities`), or `null` when no organization is in scope. */
  active_organization: OrganizationOutput | null;
  /** Permission codes the caller holds in the active organization (e.g. `["organization:read", …]`). */
  my_permissions: string[];
  /**
   * The caller's platform-wide role, or `null` for a standard user.
   *
   * @remarks
   * The organization LIST is deliberately not here — it lives at
   * `GET /users/me/organizations`. Embedded, it was a flat array with no cursor,
   * filled by a default-paginated read: a caller in more than 25 organizations
   * got a silently truncated switcher and no way to ask for the rest. The
   * dedicated endpoint pages properly, and the client can fetch it alongside
   * this call rather than behind it.
   */
  global_role: GlobalRole | null;
}
