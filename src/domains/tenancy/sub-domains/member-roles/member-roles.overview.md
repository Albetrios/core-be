`src/domains/tenancy/sub-domains/member-roles/`

# Member roles

Parent: [tenancy](../../tenancy.overview.md)

## Purpose

Per-organization role definitions and the role ↔ permission join table. A `member_role` is a named bundle of permissions an organization owner can assign to memberships (e.g. "Owner", "Admin", "Viewer"). The nested [member-role-permission](src/domains/tenancy/sub-domains/member-roles/member-role-permission/) resource is the join table that ties roles to the catalog of permission constants.

## Key invariants

- **Roles are organization-scoped**: every role row carries `organization_id`; cross-organization reads are forbidden by RLS.
- **Permission catalog is global, role assignments are scoped**: the permission constants (`TENANCY_PERMISSIONS`, `BILLING_PERMISSIONS`, etc.) are platform-defined; what a role grants is per-organization.
- **Updating a role's permissions invalidates every member's cache**: role-permission replacement and role deletion bump the organization permission cache version (`invalidateOrganizationPermissions`), orphaning every `(user, organization)` cache key in the organization in O(1) — a role change can affect many members, so the whole organization namespace is invalidated rather than enumerating holders.
- **Built-in roles are uneditable**: provisioning creates "Owner" in every organization and additionally "Admin" / "Member" / "Viewer" in a TEAM one ([`organization-provisioning.ts`](src/domains/tenancy/sub-domains/organization/organization-provisioning.ts)), all `is_system` — they can be cloned but not edited or deleted in place. Owner holds every permission code; Admin holds every code except `organization:delete`, which is what keeps the two tiers distinct.
- **Role reads project a live `member_count`**: the list / get / create / update role responses include `member_count` — the number of `ACTIVE` or `INVITED` memberships assigned the role (a `SUSPENDED` member is excluded, matching the seat count), resolved per request from a single membership aggregate (`GROUP BY role_id`), never stored. The organization owner is a normal membership on the `Owner` role, so it counts naturally. `PUT /roles/:role_id/permissions` returns the permission set (not a role object), so it carries no `member_count`.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> role_created: admin creates role
  role_created --> role_active: at least one permission attached
  role_active --> role_active: permission added/removed (caches invalidated)
  role_active --> tombstoned: soft delete (no members assigned)
  tombstoned --> [*]: retention purges
```

## Failure modes

- **Soft-deleting a role with active members** → 409; admin must reassign members first.
- **Granting a permission constant that doesn't exist** → 400.
- **Concurrent role-permission writes** → second write merges; the organization permission cache version is bumped so every affected member re-resolves.
