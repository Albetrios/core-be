`src/domains/tenancy/sub-domains/permission/`

# Permission

Parent: [tenancy](../../tenancy.overview.md)

## Purpose

Resolves "is user X allowed to perform permission P in organization O?" — backed by a Redis cache for read performance and a SETNX lock to prevent thundering-herd recomputes. The three services here (`authorization.service`, `permission-cache.service`, `permission.service`) back the `requireOrganizationPermission(...)` Fastify preHandler used across the API.

## Key invariants

- **Single resolver**: `authorization.service.ts` is the only path that answers permission checks. Routes never read permissions directly from Postgres.
- **Cache TTL ≤ 5 min**: `PERMISSION_CACHE_DEFAULT_TTL_SECONDS = 300`. Revoked permissions auto-expire within five minutes even if the explicit invalidation is missed (multi-process drift safety net).
- **Explicit invalidation on every permission write, AFTER commit** (audit R11): any change to a user's role / membership / role-permission assignment invalidates the `(user, organization)` cache key once the write transaction has committed — never inside the `withAppDatabaseContext` block. Invalidating pre-commit races a concurrent recompute that reads the old committed set and re-caches it before the write lands, so a downgraded/removed member would keep access until TTL. Enforced by `src/tests/unit/api/permission-cache-post-commit.policy.unit.test.ts`.
- **Org-wide invalidation via a version key**: a change that can affect many users (role-permission set replaced, role deleted, organization soft-deleted) bumps `perm:organization:<organization>:v` with a single `INCR` (+`EXPIRE`, audit-#T3) instead of a SCAN sweep; every cached key is scoped by that version, so the bump instantly orphans them all. The recompute lock's commit binds to the version **captured before the recompute's DB read** (audit-#H1) — if a concurrent organization-wide bump lands mid-recompute, the stale commit writes into the now-orphaned old namespace instead of re-publishing revoked permissions under the live version.
- **Fail-closed version reads**: a corrupt/errored organization-version read throws rather than silently returning `0` (which would delete the wrong `perm:0:*` key); the per-user invalidator surfaces the failure to Sentry and bumps the organization version as a backstop so a stale entry cannot survive to its TTL (audit-#T0/#T1).
- **SETNX lock on recompute**: while a process recomputes a missed entry, others wait or recompute on lock expiry (`PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS = 15`).
- **Permission set is per-`(user, organization)`**, not per-role. A user with two organizations gets two cache entries.
- **ORG-only RLS on recompute**: `findPermissionCodesForUserInOrganization` resolves `public_id` → internal id via `auth.resolve_user_id_by_public_id` (SECURITY DEFINER), not a direct `auth.users` join — permission checks run with `app.current_organization_public_id` set but not `app.current_user_public_id`, and joining `auth.users` would return zero rows under `core_be_app`.
- **Grant guard reads fresh, never cached** (sec-r5-L3): the privilege-escalation backstop `assertCallerCanGrantPermissionCodes` resolves the caller's held codes via `resolveUserOrganizationPermissionsFromDatabase` (no Redis read or write), so a code revoked from the caller seconds ago cannot still be granted to a role/API key during the ≤5-min cache window. Hot-path authorization checks keep using the cached resolver.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> cache_miss: requireOrganizationPermission entry
  cache_miss --> recomputing: SETNX lock acquired
  cache_miss --> waiting: another process holds the lock
  recomputing --> cached: SET cache key, release lock
  waiting --> cached: GET succeeds
  cached --> hit: subsequent permission checks
  hit --> hit
  cached --> invalidated: permission write
  invalidated --> cache_miss: next check
```

## Failure modes

- **Lock holder crashes** → lock auto-expires after 15 s; another process recomputes.
- **Postgres slow during recompute** → callers under SETNX wait briefly; if the lock expires, they recompute themselves.
- **Permission cache desync after multi-region failover** → bounded by 5-min TTL; revocation in flight cannot persist longer.

## Policy constants

- `PERMISSION_CACHE_DEFAULT_TTL_SECONDS = 300`
- `PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS = 15`
