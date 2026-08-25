import { setTimeout as delay } from 'node:timers/promises';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS } from '@/shared/constants/security.constants.js';

/**
 * Minimum wall-clock duration (milliseconds) that email-dispatch endpoints with a
 * silent-success anti-enumeration response (magic-link request, forgot-password) spend
 * before replying, regardless of whether the target account exists.
 *
 * @remarks
 * The unknown-account branch of these endpoints returns immediately after the user lookup,
 * while the known-account branch performs extra database writes (invalidate prior tokens +
 * insert a verification row) before responding. That work delta is observable in response
 * latency and turns the deliberately-identical success body into a timing oracle that defeats
 * the anti-enumeration design. Holding both branches to a common floor masks the delta.
 *
 * Chosen to comfortably exceed the typical two-write known-account path under normal load
 * while adding only sub-second latency to a low-frequency, unauthenticated endpoint.
 *
 * Configurable via `AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS` so local work and load tests can
 * lower it and measure what these endpoints actually cost rather than measuring the padding. The
 * env schema refuses anything below {@link DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS} in
 * production, so a deployed runtime can only ever raise it.
 */
export const ANTI_ENUMERATION_MINIMUM_DURATION_MS = DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS;

/**
 * Holds the current request to a constant minimum duration so that the existing-account and
 * unknown-account branches of a silent-success endpoint are statistically indistinguishable
 * by response latency.
 *
 * @remarks
 * Algorithm: compute elapsed time since `startedAtMillis`; if it is below `minimumMillis`,
 * await the remainder via a timer (non-blocking I/O wait, never busy-spin). If the branch has
 * already spent longer than the floor, return immediately.
 *
 * Failure modes: none — the helper only delays and never throws. It bounds the *minimum* time;
 * it cannot mask a branch that legitimately runs slower than the floor, so the floor must exceed
 * the slower (known-account) path's typical duration to be effective.
 *
 * Side effects: introduces up to `minimumMillis` of added latency on the calling path.
 */
export async function enforceMinimumDuration(
  startedAtMillis: number,
  minimumMillis: number = env.AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS,
): Promise<void> {
  const remainingMillis = minimumMillis - (Date.now() - startedAtMillis);
  if (remainingMillis > 0) {
    await delay(remainingMillis);
  }
}
