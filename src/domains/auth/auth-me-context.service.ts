import {
  withAppDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import type { GlobalRole } from '@/shared/constants/roles.constants.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { OrganizationOutput } from '@/domains/tenancy/sub-domains/organization/organization.types.js';
import type { AuthMeContextData } from './auth-me-context.types.js';

/**
 * Aggregates the authenticated caller's "effective context" in one read: their
 * self profile, the active organization (with type-derived capabilities), the
 * permission codes they hold in that organization, their global role, and the
 * organizations they belong to (for an organization switcher).
 *
 * @remarks
 * - **Algorithm:** sequential cross-domain reads through services (never
 *   repositories) — `UserService.getMe`, `OrganizationService.list`, and, when an
 *   active organization is in scope, `OrganizationService.getByPublicId` +
 *   `AuthorizationService.resolveUserOrganizationPermissions`.
 * - **Failure modes:** propagates `NotFoundError` when the user or active organization is
 *   not accessible to the caller; an absent active-organization claim yields
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
    scope: UserPrincipalDatabaseScope;
    globalRole: GlobalRole | undefined;
  }): Promise<AuthMeContextData> {
    const { scope, globalRole } = options;
    const userPublicId = scope.userPublicId;
    const activeOrganizationPublicId: string | undefined = scope.organizationPublicId;

    // `getMe` and `getByPublicId` both open the user-scoped principal context: the
    // SAME guc, the SAME value. Called separately that is two transactions, two
    // `SELECT set_config(...)` round trips and two pooled checkouts held at once.
    // Opening the user context ONCE lets both take the reuse branch in
    // `withAppDatabaseContext` and share a single checkout — the amplification that
    // made a 50-connection pool starve at 50 users. They serialize on that one
    // connection, trading a little latency at low load for connections, the resource
    // that runs out first.
    //
    // `resolveUserOrganizationPermissions` stays outside: it drives a DIFFERENT guc
    // (`app.current_organization_public_id`), so it must keep its own transaction and
    // can still overlap with the block below.
    const [userScoped, myPermissions] = await Promise.all([
      withAppDatabaseContext(scope, async () => ({
        user: await this.userService.getMe(scope),
        activeOrganization: activeOrganizationPublicId
          ? await this.organizationService.getByPublicId(activeOrganizationPublicId, userPublicId)
          : null,
      })),
      activeOrganizationPublicId
        ? this.authorizationService.resolveUserOrganizationPermissions(
            userPublicId,
            activeOrganizationPublicId,
          )
        : Promise.resolve<string[]>([]),
    ]);
    const { user, activeOrganization } = userScoped;

    return {
      user,
      activeOrganization,
      myPermissions,
      globalRole: globalRole ?? null,
    };
  }

  /**
   * Resolves the active-organization slice of the context for one organization — the
   * `active_organization` (with capabilities) and the caller's `my_permissions`
   * in it — without the heavier `user` / `organizations[]` payload.
   *
   * @remarks
   * - **Algorithm:** the same two reads `getContext` performs for the active organization —
   *   `OrganizationService.getByPublicId` + `AuthorizationService.resolveUserOrganizationPermissions`
   *   — issued concurrently, since neither consumes the other's result.
   * - **Failure modes:** propagates `NotFoundError` when the organization is not
   *   accessible to the caller.
   * - **Side effects:** none (read-only); permission resolution is Redis-cached.
   * - **Notes:** returned inline by `POST /auth/switch-to-organization` and
   *   `POST /auth/switch-to-personal` so the client repaints the dashboard for the
   *   newly active organization without a follow-up `GET /auth/me/context`. The omitted
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
      this.organizationService.getByPublicId(organizationPublicId, userPublicId),
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
