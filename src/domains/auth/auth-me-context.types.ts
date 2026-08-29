import type { GlobalRole } from '@/shared/constants/roles.constants.js';
import type { UserOutput } from '@/domains/user/user.types.js';
import type { OrganizationOutput } from '@/domains/tenancy/sub-domains/organization/organization.types.js';

/** Aggregated, pre-serialization context assembled by `AuthMeContextService.getContext`. */
export interface AuthMeContextData {
  user: UserOutput;
  activeOrganization: OrganizationOutput | null;
  activeOrganizationPublicId: string | null;
  myPermissions: string[];
  globalRole: GlobalRole | null;
  organizations: OrganizationOutput[];
}

/** An organization in the switcher list: the public organization shape plus whether it is the caller's active organization. */
export interface AuthMeContextOrganization extends OrganizationOutput {
  is_active: boolean;
}

/** Public response body for `GET /api/v1/auth/me/context`. */
export interface AuthMeContextOutput {
  /** The authenticated caller's own profile (same shape as `GET /users/me`). */
  user: UserOutput;
  /** The active organization (with type-derived `capabilities`), or `null` when no organization is in scope. */
  active_organization: OrganizationOutput | null;
  /** Permission codes the caller holds in the active organization (e.g. `["organization:read", …]`). */
  my_permissions: string[];
  /** The caller's platform-wide role, or `null` for a standard user. */
  global_role: GlobalRole | null;
  /** Organizations the caller belongs to (organization-switcher source); each flagged `is_active`. */
  organizations: AuthMeContextOrganization[];
}
