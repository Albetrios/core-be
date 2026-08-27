import {
  withPrincipalDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
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
    scope: UserPrincipalDatabaseScope;
    globalRole: GlobalRole | undefined;
  }): Promise<AuthMeContextData> {
    const { scope, globalRole } = options;
    const userPublicId = scope.userPublicId;
    const activeOrganizationPublicId: string | undefined = scope.organizationPublicId;

    // The four reads are independent — every input comes from `options`, and none consumes
    // another's result — but they do NOT all want the same database context, and that, not
    // their ordering, is what this route costs.
    //
    // `getMe`, `list` and `getByPublicId` each open the user-scoped principal context:
    // the SAME guc, the SAME value. Called separately that is three transactions, three
    // `SELECT set_config(...)` round trips and three pooled checkouts held at once — measured
    // at six BEGINs for one request. Opening the user context ONCE lets all three take the
    // reuse branch in `withPrincipalDatabaseContext` and share a single checkout, which is the
    // amplification that made a 50-connection pool starve at 50 users.
    //
    // They serialize on that one connection, so this trades a little latency at low load for a
    // 3x cut in connections held per request — the resource that actually runs out first.
    // `resolveUserOrganizationPermissions` stays outside: it drives a DIFFERENT guc
    // (`app.current_organization_id`), so it must keep its own transaction and can still
    // overlap with the block below.
    const [userScoped, myPermissions] = await Promise.all([
      withPrincipalDatabaseContext(scope, async () => ({
        user: await this.userService.getMe(scope),
        organizationsPage: await this.organizationService.list({}, userPublicId, globalRole),
        activeOrganization: activeOrganizationPublicId
          ? await this.organizationService.getByPublicId(
              activeOrganizationPublicId,
              userPublicId,
              globalRole,
            )
          : null,
      })),
      activeOrganizationPublicId
        ? this.authorizationService.resolveUserOrganizationPermissions(
            userPublicId,
            activeOrganizationPublicId,
          )
        : Promise.resolve<string[]>([]),
    ]);
    const { user, organizationsPage, activeOrganization } = userScoped;

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
