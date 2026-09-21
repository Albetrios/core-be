import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { API_KEY_LAST_USED_THROTTLE_TTL_SECONDS } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/** Logical key prefix. ioredis prepends the deployment prefix; never include it here. */
const LAST_USED_THROTTLE_PREFIX = 'apikey:last-used';

/**
 * Claims the right to record `last_used_at` for this key, once per throttle window.
 *
 * @remarks
 * - **Algorithm:** `SET apikey:last-used:<apiKeyPublicId> 1 EX <window> NX`. The first caller in a
 *   window gets `OK` and does the write; everyone else gets `null` and skips it.
 * - **Failure modes:** a Redis error returns `true` — the caller then behaves exactly as it did
 *   before this throttle existed. That is deliberate: under a Redis outage the safe degradation is
 *   today's cost (one transaction per request), not a silent change to what gets written. Logged
 *   at `warn`, never thrown into authentication.
 * - **Side effects:** one short-lived Redis key per API key per window.
 * - **Notes:** this is **not** a cache, and deliberately not a tombstone — in this sub-domain
 *   "tombstone" already means a soft-deleted row awaiting
 *   `organization-api-key-tombstone-retention.processor.ts`. Nothing is ever read back from this
 *   key; only its presence matters, so there is no staleness to reason about and no invalidation.
 *
 *   Keyed on the API key's **public id**, not its hash. The public id is already the key's external
 *   identity and carries no secret, so nothing sensitive reaches Redis even as a key name.
 *
 *   The SQL `UPDATE` is *also* throttled to a minute (audit-#8, `touchLastUsedAt`), and that stays:
 *   it is the correctness backstop when several processes claim different windows. What it could
 *   not do is stop the `BEGIN` / `set_config` / `COMMIT` around it, which happened on every
 *   authenticated API-key request whether or not the statement touched a row — and that transaction
 *   was the only one such a request opened.
 */
export async function claimApiKeyLastUsedWrite(apiKeyPublicId: string): Promise<boolean> {
  try {
    const claimed = await redisConnection.set(
      `${LAST_USED_THROTTLE_PREFIX}:${apiKeyPublicId}`,
      '1',
      'EX',
      API_KEY_LAST_USED_THROTTLE_TTL_SECONDS,
      'NX',
    );
    return claimed !== null;
  } catch (error) {
    logger.warn({ error, apiKeyPublicId }, 'api_key.last_used_throttle.claim.failed');
    return true;
  }
}
