import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Redis cache for the organization → default-locale resolution used by the
 * i18n preHandler (sec-M1).
 *
 * @remarks
 * The i18n preHandler runs on EVERY unauthenticated request that supplies an
 * authenticated request without `Accept-Language` — the most exposed
 * surface in the app. Without a cache, each such request fires the
 * SECURITY DEFINER function `tenancy.resolve_organization_default_locale`,
 * which lets a distributed attacker drive thousands of pre-auth Postgres
 * round-trips per second and use the differential locale response as an
 * organization-existence oracle.
 *
 * This cache stores the resolved locale (the canonical `'en'` fallback
 * included) under a short-lived key so a repeated lookup short-circuits to
 * Redis. Cache-miss-on-Redis-error is the bail-out: never block the request
 * on a cache outage — fall back to the DB, log, and move on.
 */
const I18N_LOCALE_CACHE_PREFIX = 'i18n:locale';
const I18N_LOCALE_CACHE_TTL_SECONDS = 300;

function buildKey(organizationPublicId: string): string {
  return `${I18N_LOCALE_CACHE_PREFIX}:${organizationPublicId}`;
}

/**
 * Returns the cached default locale for an organization, or `null` when the
 * cache holds no value (or Redis is unreachable). Callers must fall back to
 * the DB resolver on `null`.
 */
export async function getCachedOrganizationDefaultLocale(
  organizationPublicId: string,
): Promise<string | null> {
  try {
    return await redisConnection.get(buildKey(organizationPublicId));
  } catch (error) {
    logger.warn({ error, organizationPublicId }, 'i18n-locale.cache.get.failed');
    return null;
  }
}

/**
 * Stores the resolved default locale for an organization with a 5-minute TTL.
 * Best-effort: a Redis outage logs at `warn` and does NOT propagate, so the
 * resolution path returns the freshly-computed value regardless.
 */
export async function setCachedOrganizationDefaultLocale(
  organizationPublicId: string,
  locale: string,
): Promise<void> {
  try {
    await redisConnection.set(
      buildKey(organizationPublicId),
      locale,
      'EX',
      I18N_LOCALE_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn({ error, organizationPublicId }, 'i18n-locale.cache.set.failed');
  }
}

/**
 * Drops the cached default locale for an organization. Called from the
 * organization-settings mutation paths that change the default locale, so a
 * dashboard switch from `'en' → 'es'` reflects in the next request rather
 * than waiting up to {@link I18N_LOCALE_CACHE_TTL_SECONDS}. Best-effort.
 */
export async function invalidateCachedOrganizationDefaultLocale(
  organizationPublicId: string,
): Promise<void> {
  try {
    await redisConnection.del(buildKey(organizationPublicId));
  } catch (error) {
    logger.warn({ error, organizationPublicId }, 'i18n-locale.cache.invalidate.failed');
  }
}
