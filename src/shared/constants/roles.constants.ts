/**
 * Global (cross-organization) role codes; checked by `requireRole` and seed data.
 *
 * @remarks
 * Two values, because two are issued. `super_admin` comes from the `GLOBAL_ADMIN_EMAILS`
 * allowlist and is re-derived against live account state on every request; `user` is every other
 * active account and no guard tests for it. A third code, `admin`, sat here unissued: no mint path
 * produced it, the auth middleware downgraded it on sight, and nine route guards accepted a value
 * that could not occur — an authorization surface that read as real and was not. Adding a second
 * staff tier means adding it here **and** the code that issues it, in the same change.
 *
 * This is the PLATFORM role, and it is not a tenant one: it grants nothing inside an organization.
 * Organization permissions come from `tenancy.roles` through `requireOrganizationPermission`, and
 * the organization role named "Admin" is unrelated to anything here.
 */
export const GLOBAL_ROLES = {
  SUPER_ADMIN: 'super_admin',
  USER: 'user',
} as const;

/** String-literal union of every value in {@link GLOBAL_ROLES}. */
export type GlobalRole = (typeof GLOBAL_ROLES)[keyof typeof GLOBAL_ROLES];
