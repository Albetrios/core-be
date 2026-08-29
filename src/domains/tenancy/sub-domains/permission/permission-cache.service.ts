import { randomInt, randomUUID } from 'node:crypto';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { PERMISSION_CACHE_STAMPEDE_POLL_MS } from '@/shared/constants/limits.constants.js';
import {
  PERMISSION_CACHE_DEFAULT_TTL_SECONDS,
  PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS,
} from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { captureException } from '@/infrastructure/observability/sentry/sentry.js';

const PERMISSION_CACHE_PREFIX = 'perm';
const PERMISSION_CACHE_ORGANIZATION_VERSION_PREFIX = 'perm:org';

/** Upper bound (exclusive) for the 0..60s jitter smeared over permission-cache expirations. */
const PERMISSION_CACHE_JITTER_MAX_SECONDS = 61;

/**
 * Number of stampede poll iterations before a waiter falls through to its own
 * recompute (audit-#9).
 *
 * @remarks
 * Sized to ~90% of the recompute-lock TTL (was a fixed 40 ≈ 2s) so waiters wait
 * for the lock holder's recompute — which can exceed 2s for a large organization or a DB
 * under load — instead of stampeding into N concurrent uncached 5-table joins.
 * Only a genuinely dead holder (lock expired at its TTL) makes a waiter recompute.
 * Waiters still exit the moment the cache populates, so the common fast-recompute
 * path is unaffected.
 */
const STAMPEDE_POLL_ATTEMPTS = Math.ceil(
  (PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS * 1000 * 0.9) / PERMISSION_CACHE_STAMPEDE_POLL_MS,
);

/**
 * Atomic "commit cache write only if we still own the recompute lock". Closes the
 * read-then-write invalidation race: a concurrent `invalidatePermissions` deletes the
 * lock key (single `DEL`), so a stale in-flight recompute that already read the old DB
 * rows finds `GET lock != nonce` and skips the write. Redis runs this script and the
 * invalidation `DEL` serially, so there is no interleaving window.
 */
const PERMISSION_CACHE_COMMIT_IF_LOCK_HELD_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]); return 1 end; return 0";

/** Releases the recompute lock only when its value still matches our nonce (compare-and-del). */
const PERMISSION_CACHE_RELEASE_LOCK_IF_HELD_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0";

/**
 * Atomically bumps the organization cache-version (`INCR`) and (re)sets its TTL in one round-trip.
 * The TTL prevents the version key from lingering forever (audit-#T3 Redis hygiene) while
 * staying far longer than any data-key TTL, so a version-key expiry can never resurrect a
 * stale versioned entry — every data key from that epoch expired long before.
 */
const PERMISSION_CACHE_BUMP_VERSION_LUA =
  "local v = redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[1]); return v";

/**
 * TTL for the per-organization cache-version key. Must comfortably exceed the maximum data-key TTL
 * ({@link PERMISSION_CACHE_DEFAULT_TTL_SECONDS} + jitter ≈ 6 min) so the invariant
 * "version-key TTL ≫ data-key TTL" holds: by the time an idle org's version key could expire,
 * every `perm:<version>:*` entry it namespaced has already expired, making a reset to 0 harmless.
 */
const PERMISSION_CACHE_ORGANIZATION_VERSION_TTL_SECONDS = 24 * 60 * 60;

function buildOrganizationVersionKey(organizationId: string): string {
  return `${PERMISSION_CACHE_ORGANIZATION_VERSION_PREFIX}:${organizationId}:v`;
}

/**
 * Read the organization cache version. Absent/empty means "never invalidated" and maps to version 0
 * (a legitimate value). A Redis error or a corrupt (non-integer) value THROWS rather than
 * masquerading as `0`: security-critical callers ({@link invalidatePermissions}) must surface
 * the failure to Sentry instead of silently deleting the wrong `perm:0:*` key, and read callers
 * catch the throw and degrade to a safe cache-miss (audit-#T0).
 */
async function getOrganizationCacheVersion(organizationId: string): Promise<number> {
  const raw = await redisConnection.get(buildOrganizationVersionKey(organizationId));
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error('permission-cache.version.corrupt');
  }
  return parsed;
}

/** Atomically bumps the organization cache-version and refreshes its TTL (see {@link PERMISSION_CACHE_BUMP_VERSION_LUA}). */
async function bumpOrganizationCacheVersion(organizationId: string): Promise<void> {
  await redisConnection.eval(
    PERMISSION_CACHE_BUMP_VERSION_LUA,
    1,
    buildOrganizationVersionKey(organizationId),
    String(PERMISSION_CACHE_ORGANIZATION_VERSION_TTL_SECONDS),
  );
}

/**
 * Build the Redis key for a user's organization permissions, scoped by the organization cache version
 * so we can invalidate per-organization with a single INCR (no SCAN sweep).
 */
function buildKey(version: number, userId: string, organizationId: string): string {
  return `${PERMISSION_CACHE_PREFIX}:${version}:${userId}:${organizationId}`;
}

function buildRecomputeLockKey(userId: string, organizationId: string): string {
  return `${PERMISSION_CACHE_PREFIX}:lock:${userId}:${organizationId}`;
}

/**
 * Get cached permission codes for a user in an organization.
 * Returns null if not cached.
 *
 * @remarks
 * - **Algorithm:** reads the organization cache version (defaulting to 0 if unset),
 *   then `GET`s the versioned key built by {@link buildKey} and `JSON.parse`s
 *   the value.
 * - **Failure modes:** Redis errors are caught, logged
 *   (`permission-cache.get.failed`), and surface as `null` so the caller
 *   falls back to a fresh database resolution.
 * - **Side effects:** none — read-only Redis lookups; never blocks the
 *   request path.
 * - **Notes:** versioned keys are why
 *   {@link invalidateOrganizationPermissions} can purge an entire organization with a
 *   single `INCR` instead of a SCAN.
 */
export async function getCachedPermissions(
  userId: string,
  organizationId: string,
): Promise<string[] | null> {
  try {
    const version = await getOrganizationCacheVersion(organizationId);
    const cached = await redisConnection.get(buildKey(version, userId, organizationId));
    if (!cached) return null;
    return JSON.parse(cached) as string[];
  } catch (error) {
    logger.warn({ error }, 'permission-cache.get.failed');
    return null;
  }
}

/**
 * Cache permission codes for a user in an organization.
 *
 * @remarks
 * - **Algorithm:** reads the current organization cache version and writes the JSON
 *   array under the versioned key with a TTL of
 *   `ttlSeconds + jitter (0..60s)` so a stampede of expirations is smeared
 *   across a minute.
 * - **Failure modes:** Redis errors are caught and logged
 *   (`permission-cache.set.failed`); the call resolves successfully so a
 *   cache write failure never blocks the request.
 * - **Side effects:** single Redis `SET ... EX` under `perm:<version>:...`.
 * - **Notes:** the default TTL is
 *   {@link PERMISSION_CACHE_DEFAULT_TTL_SECONDS} (5 minutes); callers
 *   typically rely on the default.
 */
export async function setCachedPermissions(
  userId: string,
  organizationId: string,
  codes: string[],
  ttlSeconds = PERMISSION_CACHE_DEFAULT_TTL_SECONDS,
): Promise<void> {
  try {
    const version = await getOrganizationCacheVersion(organizationId);
    /** Small jitter so many users do not expire and recompute in the same second. */
    const jitterSeconds = randomInt(PERMISSION_CACHE_JITTER_MAX_SECONDS);
    await redisConnection.set(
      buildKey(version, userId, organizationId),
      JSON.stringify(codes),
      'EX',
      ttlSeconds + jitterSeconds,
    );
  } catch (error) {
    logger.warn({ error }, 'permission-cache.set.failed');
  }
}

interface CommitCachedPermissionsOptions {
  userId: string;
  organizationId: string;
  /** Org cache version captured BEFORE the recompute's DB read — see {@link withPermissionCacheRecomputeLock}. */
  version: number;
  lockKey: string;
  lockNonce: string;
  codes: string[];
}

/**
 * Writes freshly recomputed permission codes to the cache only if the recompute lock is
 * still held by this caller, atomically (see {@link PERMISSION_CACHE_COMMIT_IF_LOCK_HELD_LUA}).
 *
 * @remarks
 * - **Algorithm:** builds the versioned key from the `version` captured at recompute START
 *   (NOT re-read here) and runs the compare-and-set Lua so the `SET ... EX` only lands when
 *   `GET lockKey == lockNonce`. TTL is `default + jitter (0..60s)` to smear expirations.
 * - **Failure modes:** Redis errors are caught and logged (`permission-cache.commit.failed`);
 *   the call resolves so a cache write failure never blocks the request.
 * - **Side effects:** at most one Redis `SET` under `perm:<version>:...`.
 * - **Notes:** two guards prevent re-caching stale permissions — the lock-nonce compare-and-set
 *   (a concurrent per-user {@link invalidatePermissions} deleted the lock → this write is a
 *   no-op), and the captured `version` (a concurrent organization-wide
 *   {@link invalidateOrganizationPermissions} bumped the version during the recompute → this
 *   write lands in the now-orphaned old namespace instead of the live one). The latter closes
 *   audit-#H1, where re-reading the version at commit time let a stale set be published under
 *   the post-invalidation version and served for the full TTL.
 */
async function commitCachedPermissionsIfLockHeld(
  options: CommitCachedPermissionsOptions,
): Promise<void> {
  const { userId, organizationId, version, lockKey, lockNonce, codes } = options;
  try {
    /** Small jitter so many users do not expire and recompute in the same second. */
    const jitterSeconds = randomInt(PERMISSION_CACHE_JITTER_MAX_SECONDS);
    await redisConnection.eval(
      PERMISSION_CACHE_COMMIT_IF_LOCK_HELD_LUA,
      2,
      lockKey,
      buildKey(version, userId, organizationId),
      lockNonce,
      JSON.stringify(codes),
      String(PERMISSION_CACHE_DEFAULT_TTL_SECONDS + jitterSeconds),
    );
  } catch (error) {
    logger.warn({ error }, 'permission-cache.commit.failed');
  }
}

/**
 * Runs a cache-miss recompute under a short Redis lock. Waiters poll for the cached value
 * so only one request per (user, organization) hits the database during a stampede.
 *
 * @remarks
 * - **Algorithm:** `SET key <nonce> EX <ttl> NX` to claim the lock with a unique
 *   per-call nonce; on success runs `recompute()`, then commits the result via
 *   {@link commitCachedPermissionsIfLockHeld} (a compare-and-set guarded on the
 *   nonce) and returns. Waiters poll up to `STAMPEDE_POLL_ATTEMPTS` ×
 *   `PERMISSION_CACHE_STAMPEDE_POLL_MS` (≈2s) for the cache to populate; if still empty, they fall
 *   through to a fresh recompute as a safety net (without caching, since they do
 *   not own the lock).
 * - **Failure modes:** Redis `SET` failure is logged
 *   (`permission-cache.lock.acquire.failed`) and the caller falls back to a
 *   direct `recompute()` without locking — the database carries the load.
 *   `recompute()` errors propagate to the caller.
 * - **Side effects:** Redis SET/DEL on `perm:lock:<user>:<organization>`; one
 *   Postgres-hitting `recompute()` per stampede on the happy path; cache
 *   write through {@link commitCachedPermissionsIfLockHeld}.
 * - **Notes:** the lock TTL is
 *   {@link PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS}; the lock is released in a
 *   `finally` block via compare-and-del so an uncaught exception never strands it
 *   and we never delete a lock re-acquired by another recompute. Holding the lock
 *   nonce closes the read-then-write invalidation race: a concurrent
 *   {@link invalidatePermissions} deletes the lock key, so this caller's commit
 *   becomes a no-op instead of re-caching stale permissions.
 */
export async function withPermissionCacheRecomputeLock(
  userId: string,
  organizationId: string,
  recompute: () => Promise<string[]>,
): Promise<string[]> {
  const lockKey = buildRecomputeLockKey(userId, organizationId);
  const lockNonce = randomUUID();
  let acquiredLock = false;
  try {
    let lockResult: string | null;
    try {
      lockResult = await redisConnection.set(
        lockKey,
        lockNonce,
        'EX',
        PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS,
        'NX',
      );
    } catch (error) {
      logger.warn({ error }, 'permission-cache.lock.acquire.failed');
      return await recompute();
    }
    acquiredLock = lockResult === 'OK';

    if (!acquiredLock) {
      for (let attempt = 0; attempt < STAMPEDE_POLL_ATTEMPTS; attempt++) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, PERMISSION_CACHE_STAMPEDE_POLL_MS),
        );
        const waiterCached = await getCachedPermissions(userId, organizationId);
        if (waiterCached !== null) {
          return waiterCached;
        }
      }
    }

    const doubleCheck = await getCachedPermissions(userId, organizationId);
    if (doubleCheck !== null) {
      return doubleCheck;
    }

    if (!acquiredLock) {
      // audit-#9: a waiter polled out the full budget without the cache populating
      // (lock holder dead or recompute slower than the lock TTL) and is now doing
      // its own uncached recompute. Surface it so a real stampede is observable
      // rather than silently amplifying DB load.
      logger.warn(
        { userId, organizationId },
        'permission-cache.stampede.waiter_fell_through_to_recompute',
      );
    }

    // Bind the organization cache version captured BEFORE the recompute's DB read (audit-#H1). If a
    // concurrent organization-wide invalidation INCRs the version during the recompute, this captured
    // value is now stale, so the commit lands in the orphaned old namespace (harmless) instead
    // of publishing the pre-invalidation set under the live version. A version-read failure
    // means we cannot bind safely, so we skip caching and just serve the fresh result.
    let capturedVersion: number | null;
    try {
      capturedVersion = await getOrganizationCacheVersion(organizationId);
    } catch (error) {
      logger.warn({ error }, 'permission-cache.version.read.failed');
      capturedVersion = null;
    }

    const fresh = await recompute();
    if (capturedVersion !== null) {
      await commitCachedPermissionsIfLockHeld({
        userId,
        organizationId,
        version: capturedVersion,
        lockKey,
        lockNonce,
        codes: fresh,
      });
    }
    return fresh;
  } finally {
    if (acquiredLock) {
      try {
        await redisConnection.eval(
          PERMISSION_CACHE_RELEASE_LOCK_IF_HELD_LUA,
          1,
          lockKey,
          lockNonce,
        );
      } catch (error) {
        logger.warn({ error }, 'permission-cache.lock.release.failed');
      }
    }
  }
}

/**
 * Invalidate cached permissions for a specific user in an organization.
 * Call this when roles/permissions change.
 *
 * @remarks
 * - **Algorithm:** issues a single Redis `DEL` for both the versioned cache
 *   entry and the recompute lock for `(user, organization)`.
 * - **Failure modes:** Redis errors are caught and logged
 *   (`permission-cache.invalidate.failed`); the function still resolves so
 *   callers (membership create/update) never block on cache invalidation.
 * - **Side effects:** Redis `DEL` of two keys.
 * - **Notes:** for organization-wide changes (e.g. role-permission set replaced),
 *   prefer {@link invalidateOrganizationPermissions}, which bumps the organization
 *   version with a single `INCR` and orphans every per-user key at once.
 */
export async function invalidatePermissions(userId: string, organizationId: string): Promise<void> {
  try {
    const version = await getOrganizationCacheVersion(organizationId);
    await redisConnection.del(
      buildKey(version, userId, organizationId),
      buildRecomputeLockKey(userId, organizationId),
    );
  } catch (error) {
    // A failed invalidation leaves the OLD (over-broad) permission set cached until its TTL — a
    // privilege-retention window after a role/membership change. Fail-open is deliberate (callers
    // must not block on cache), but surface it to Sentry so the operational risk is VISIBLE, not
    // buried in a warn log.
    logger.warn({ error }, 'permission-cache.invalidate.failed');
    captureException(error, {
      userId,
      organizationId,
      tags: { subsystem: 'permission-cache', operation: 'invalidate' },
    });
    // Backstop (audit-#T1): we could not target the user's key (version read or DEL failed, e.g.
    // a transient blip that returned a wrong/`0` version). Best-effort bump the organization version so
    // the stale per-user entry is orphaned organization-wide rather than served until its TTL. This
    // over-invalidates the organization (everyone recomputes once) — the security-favouring tradeoff. If
    // Redis is fully down this also fails, harmlessly.
    try {
      await bumpOrganizationCacheVersion(organizationId);
    } catch (backstopError) {
      logger.warn({ error: backstopError }, 'permission-cache.invalidate.backstop.failed');
    }
  }
}

/**
 * Invalidate all cached permissions for an organization via INCR on the version key.
 *
 * No SCAN: existing keys are simply orphaned and expire via TTL, while new reads/writes
 * see the bumped version and operate on a fresh namespace.
 *
 * @remarks
 * - **Algorithm:** atomically bumps `perm:org:<organization>:v` via `INCR` and refreshes its
 *   TTL in one Lua round-trip ({@link bumpOrganizationCacheVersion}). All subsequent
 *   reads/writes go through {@link buildKey} with the new version, so every previously
 *   cached entry for the organization is instantly unreachable.
 * - **Failure modes:** Redis errors are caught and logged
 *   (`permission-cache.invalidate-organization.failed`); the function still
 *   resolves so callers (role/permission edits) never block on cache
 *   invalidation.
 * - **Side effects:** single Redis `INCR` + `EXPIRE`; orphans existing keys which
 *   expire naturally via their TTL — keeps invalidation O(1).
 * - **Notes:** use this whenever a change can affect many users in the organization
 *   (e.g. a role's permission set is replaced); per-user changes can use the
 *   narrower {@link invalidatePermissions}.
 */
export async function invalidateOrganizationPermissions(organizationId: string): Promise<void> {
  try {
    await bumpOrganizationCacheVersion(organizationId);
  } catch (error) {
    // Same privilege-retention risk as invalidatePermissions, organization-wide: a failed version bump
    // leaves every user's cached permission set live until TTL. Surface to Sentry.
    logger.warn({ error }, 'permission-cache.invalidate-organization.failed');
    captureException(error, {
      organizationId,
      tags: { subsystem: 'permission-cache', operation: 'invalidate-organization' },
    });
  }
}
