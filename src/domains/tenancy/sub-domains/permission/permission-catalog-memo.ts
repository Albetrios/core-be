import { CATALOG_MEMO_TTL_MILLISECONDS } from '@/shared/constants/ttl.constants.js';
import type { PermissionOutput } from './permission.types.js';

let memoizedPermissionCatalog: { value: PermissionOutput[]; expiresAt: number } | null = null;
let permissionCatalogLoadInFlight: Promise<PermissionOutput[]> | null = null;

/**
 * Serves the permission catalog from process memory for {@link CATALOG_MEMO_TTL_MILLISECONDS}.
 *
 * @remarks
 * - **Algorithm:** return the unexpired memo; otherwise run `load` once — concurrent callers join
 *   the same in-flight promise — and memoize the result. A rejected load is never memoized.
 * - **Failure modes:** none of its own; a `load` rejection propagates to every joined caller.
 * - **Side effects:** module-level state, per process.
 * - **Notes — read this before moving it.** This memoizes `PermissionService.list()`, the HTTP
 *   catalog read, and it must not be pushed down into `PermissionRepository.findAll()`.
 *   `assert-grantable-permissions.util.ts` calls that same repository method to build the set of
 *   known permission codes and **refuses any code outside it** — the privilege-escalation backstop
 *   on role-permission writes. That check is deliberately live (its sibling caller-permission read
 *   already bypasses the five-minute Redis permission cache for the same reason), and a memo
 *   underneath it would decide authorization from stale data. Memoizing the service leaves the
 *   guard on Postgres by construction, because it does not go through the service.
 *
 *   Otherwise the reasoning matches the plan catalog: the data is global, not scope-keyed, and
 *   cannot change while the process runs — `seedPermissions` is a CLI script in a different
 *   process and there is no runtime writer anywhere in `src/`. So this follows
 *   `migration-version.ts`, not the Redis read-cache pattern: nothing to key on, nothing to
 *   invalidate, no write choke point to hook.
 *
 *   Memoized **after** serialization, so the stored shape is JSON-safe (the raw row carries a
 *   `Date`) and repeat reads skip the per-request serialize as well.
 */
export async function memoizePermissionCatalog(
  load: () => Promise<PermissionOutput[]>,
): Promise<PermissionOutput[]> {
  const now = Date.now();
  if (memoizedPermissionCatalog && memoizedPermissionCatalog.expiresAt > now) {
    return memoizedPermissionCatalog.value;
  }
  if (permissionCatalogLoadInFlight) return permissionCatalogLoadInFlight;

  permissionCatalogLoadInFlight = load()
    .then((value) => {
      memoizedPermissionCatalog = { value, expiresAt: Date.now() + CATALOG_MEMO_TTL_MILLISECONDS };
      return value;
    })
    .finally(() => {
      permissionCatalogLoadInFlight = null;
    });
  return permissionCatalogLoadInFlight;
}

/**
 * Test-only: drop the memoized catalog so the next read goes to Postgres.
 *
 * @remarks
 * Called from `cleanupDatabase`. `permissions` is one of the two tables that wipe deliberately
 * skips, so a suite reseeding it relies on `ON CONFLICT DO NOTHING` rather than a truncate — but a
 * suite that adds a code and asserts it is listed would still read the previous file's memo.
 */
export function resetPermissionCatalogMemoForTests(): void {
  memoizedPermissionCatalog = null;
  permissionCatalogLoadInFlight = null;
}
