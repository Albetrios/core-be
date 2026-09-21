import { resolveRedisKeyPrefix } from '@/infrastructure/cache/redis-prefix.util.js';
import { connectRedis, redisConnection } from '@/infrastructure/cache/redis.client.js';
import { env } from '@/shared/config/env.config.js';

/** Redis key prefixes cleared between integration tests (Postgres truncate does not touch Redis). */
/** Logical prefixes (ioredis `keyPrefix: 'core:'` is applied by redisConnection). */
const TEST_REDIS_PREFIXES = [
  'perm:',
  'idempotency:',
  'oauth:state:',
  'session:tok:',
  // Auth OTP/send cooldowns + verify-attempt counters. `TRUNCATE ... RESTART IDENTITY` resets the
  // user-id sequence, so user-keyed cooldowns/counters (and email-keyed send cooldowns when a test
  // reuses an address) would otherwise leak across cases and nondeterministically skip a send.
  'auth:email_code_send_cooldown:',
  'auth:password_reset_cooldown:',
  'auth:email_verify_resend_cooldown:',
  'auth:email_code_verify_attempts:',
  'auth:email_otp_verify_attempts:',
  // Read caches keyed on a public id. `TRUNCATE ... RESTART IDENTITY` recycles ids, so one case's
  // cached count (or its invalidation tombstone, which blocks the next `SET NX`) would otherwise
  // be served to the next case's user of the same id.
  'notify:unread-count:',
  // Not a cache — the once-a-minute claim that gates the API-key `last_used_at` write. A leftover
  // claim makes the next case's key skip its write and fail an assertion about `last_used_at`.
  'apikey:last-used:',
] as const;

/**
 * Whether flushing test-scoped Redis keys is acceptable (the same gate as the Postgres wipe): the
 * single `TEST_MODE` flag. It defaults false and a schema refine forbids `true` in production, so a
 * deployed store is never flushed.
 */
function isRedisWipeAllowed(): boolean {
  return env.TEST_MODE;
}

/**
 * `@fastify/rate-limit` stores counters under `<keyPrefix>fastify-rate-limit-<key>`. Every
 * test injects from the same socket, so the global limiter and the per-route presets all key on
 * IP `127.0.0.1`; on a fast machine a single 60s window accumulates enough requests across cases
 * to trip the cap and emit nondeterministic 429s (which cascade into 401s on dependent requests).
 * Clearing these between tests gives each case a fresh budget.
 *
 * The match pattern uses a leading wildcard because ioredis does NOT apply its `keyPrefix` to a
 * SCAN `MATCH` argument; SCAN returns fully-qualified keys, which are then stripped of the prefix
 * before DEL (which re-applies it). This stays correct whether or not a prefix is configured.
 */
async function clearRateLimitCounters(): Promise<void> {
  const keyPrefix = resolveRedisKeyPrefix();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redisConnection.scan(
      cursor,
      'MATCH',
      '*fastify-rate-limit-*',
      'COUNT',
      500,
    );
    cursor = nextCursor;
    if (keys.length > 0) {
      const unprefixedKeys = keys.map((key) =>
        keyPrefix && key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key,
      );
      await redisConnection.del(...unprefixedKeys);
    }
  } while (cursor !== '0');
}

/**
 * Delete test-scoped Redis keys so permission cache, idempotency, and OAuth state
 * do not leak across Vitest cases in the same worker process.
 */
export async function cleanupTestRedis(): Promise<void> {
  if (!isRedisWipeAllowed()) {
    throw new Error(
      'cleanupTestRedis is disabled: it requires TEST_MODE=true. ' +
        'The Vitest harness sets it; for a manual run set it in .env.local (NODE_ENV=local/development). ' +
        'TEST_MODE is refine-forbidden in production, so this can never flush a deployed Redis.',
    );
  }

  try {
    await connectRedis();
  } catch {
    return;
  }

  if (redisConnection.status !== 'ready') {
    return;
  }

  for (const prefix of TEST_REDIS_PREFIXES) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redisConnection.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        200,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await redisConnection.del(...keys);
      }
    } while (cursor !== '0');
  }

  await clearRateLimitCounters();
}
