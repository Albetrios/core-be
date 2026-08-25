import type { GlobalRole } from '@/shared/constants/roles.constants.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { OrganizationOutput } from '@/domains/tenancy/sub-domains/organization/organization.types.js';
import type { AuthMeContextData } from './auth-me-context.types.js';

/**
 * Aggregates the authenticated caller's "effective context" in one read: their
 * self profile, the active organization (with type-derived capabilities), the
 * permission codes they hold in that org, their global role, and the
 * organizations they belong to (for an org switcher).
 *
 * @remarks
 * - **Algorithm:** sequential cross-domain reads through services (never
 *   repositories) — `UserService.getMe`, `OrganizationService.list`, and, when an
 *   active org is in scope, `OrganizationService.getByPublicId` +
 *   `AuthorizationService.resolveUserOrganizationPermissions`.
 * - **Failure modes:** propagates `NotFoundError` when the user or active org is
 *   not accessible to the caller; an absent active-org claim yields
 *   `activeOrganization: null` and empty permissions rather than an error.
 * - **Side effects:** none (read-only); permission resolution is Redis-cached.
 * - **Notes:** owns no tables — it composes the existing `/users/me`,
 *   `/tenancy/organization(s)`, and permission-resolution reads behind one call so
 *   the surface stays identical for personal and team organizations.
 */
export class AuthMeContextService {
  constructor(
    private readonly userService: UserService,
    private readonly organizationService: OrganizationService,
    private readonly authorizationService: AuthorizationService,
  ) {}

  /** Assembles the caller's effective context for `GET /auth/me/context`. */
  async getContext(options: {
    userPublicId: string;
    activeOrganizationPublicId: string | undefined;
    globalRole: GlobalRole | undefined;
  }): Promise<AuthMeContextData> {
    const { userPublicId, activeOrganizationPublicId, globalRole } = options;

    // All four reads are independent — every input comes from `options` (the caller's public id,
    // the active-org claim, the global role), and none consumes another's result. Issued
    // sequentially this route paid four round trips back to back; batched it pays one wall-clock
    // wait. That matters disproportionately here because `/auth/me/context` is on the critical
    // path of every page load, so its latency is multiplied across the whole session.
    const [user, organizationsPage, activeOrganization, myPermissions] = await Promise.all([
      this.userService.getMe(userPublicId),
      this.organizationService.list({}, userPublicId, globalRole),
      activeOrganizationPublicId
        ? this.organizationService.getByPublicId(
            activeOrganizationPublicId,
            userPublicId,
            globalRole,
          )
        : Promise.resolve<OrganizationOutput | null>(null),
      activeOrganizationPublicId
        ? this.authorizationService.resolveUserOrganizationPermissions(
            userPublicId,
            activeOrganizationPublicId,
          )
        : Promise.resolve<string[]>([]),
    ]);

    return {
      user,
      activeOrganization,
      activeOrganizationPublicId: activeOrganizationPublicId ?? null,
      myPermissions,
      globalRole: globalRole ?? null,
      organizations: organizationsPage.items,
    };
  }

  /**
   * Resolves the active-org slice of the context for one organization — the
   * `active_organization` (with capabilities) and the caller's `my_permissions`
   * in it — without the heavier `user` / `organizations[]` payload.
   *
   * @remarks
   * - **Algorithm:** the same two reads `getContext` performs for the active org —
   *   `OrganizationService.getByPublicId` + `AuthorizationService.resolveUserOrganizationPermissions`
   *   — issued concurrently, since neither consumes the other's result.
   * - **Failure modes:** propagates `NotFoundError` when the organization is not
   *   accessible to the caller.
   * - **Side effects:** none (read-only); permission resolution is Redis-cached.
   * - **Notes:** returned inline by `POST /auth/switch-to-organization` and
   *   `POST /auth/switch-to-personal` so the client repaints the dashboard for the
   *   newly active org without a follow-up `GET /auth/me/context`. The omitted
   *   `user` and `organizations[]` are stable across a switch, so the client reuses
   *   the values from its initial `/me/context` and only flips `is_active` locally.
   */
  async getActiveOrganizationContext(options: {
    userPublicId: string;
    organizationPublicId: string;
    globalRole: GlobalRole | undefined;
  }): Promise<{
    active_organization: OrganizationOutput;
    my_permissions: string[];
    global_role: GlobalRole | null;
  }> {
    const { userPublicId, organizationPublicId, globalRole } = options;
    // Independent of each other — both read from `options` only — so they go out together
    // rather than one after the other. This runs inline on every organization switch.
    const [activeOrganization, myPermissions] = await Promise.all([
      this.organizationService.getByPublicId(organizationPublicId, userPublicId, globalRole),
      this.authorizationService.resolveUserOrganizationPermissions(
        userPublicId,
        organizationPublicId,
      ),
    ]);
    return {
      active_organization: activeOrganization,
      my_permissions: myPermissions,
      global_role: globalRole ?? null,
    };
  }
}
