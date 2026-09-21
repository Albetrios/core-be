import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import {
  CHAOS_POSTGRES_PROXY_NAME,
  CHAOS_REDIS_PROXY_NAME,
} from '@/tests/chaos/chaos.constants.js';
import {
  addToxinOntoListeningChaosTestingProxyDefinition,
  removeEveryToxinAttachedToListeningChaosTestingProxyDefinition,
  resetChaosTestingListeningProxyFailuresGloballyViaToxiproxy,
  setChaosTestingListeningProxyEnabledAdministrativeSwitch,
} from '@/tests/chaos/helpers/toxiproxy.client.js';
import { createListeningChaosTestApplicationHarness } from '@/tests/chaos/helpers/chaos-app.js';
import { resetPlanCatalogMemoForTests } from '@/domains/billing/sub-domains/plan/plan-catalog-memo.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/**
 * The suite overview has always CLAIMED "combined-failure scenarios (Postgres slow +
 * Redis flapping)" — this file makes the claim true. Every existing chaos test degrades
 * ONE dependency; production incidents rarely oblige. The invariant under a combined
 * fault is graceful boundedness, not success: every response is a structured JSON
 * envelope (the error handler stays in charge — no socket resets, no hangs past the
 * injected latency, no HTML stack pages), and the instant both faults lift the same
 * route serves 200s again with no restart.
 */
describe('Chaos resilience: combined Postgres latency + Redis outage stays bounded and heals', () => {
  let chaosListeningFastifyApplication: FastifyInstance;

  beforeAll(async () => {
    const harnessForCombinedDegradationObservation =
      await createListeningChaosTestApplicationHarness();
    chaosListeningFastifyApplication =
      harnessForCombinedDegradationObservation.chaosApplicationListeningInstance;
  });

  afterAll(async () => {
    await chaosListeningFastifyApplication.close();
    await resetChaosTestingListeningProxyFailuresGloballyViaToxiproxy();
  });

  /**
   * `GET /billing/plans` is served from a one-minute in-process memo, and every probe below is
   * inside that window. Without dropping it first, the baseline 200 would fill the memo and every
   * later probe — degraded AND recovered — would be answered from memory without touching Postgres
   * or Redis at all. The test would stay green while proving nothing about either.
   *
   * So each probe clears it. The memo is production behaviour and stays; what this test asserts is
   * the behaviour of the path underneath it.
   */
  function probeThePlansRouteThroughTheDatabase() {
    resetPlanCatalogMemoForTests();
    return chaosListeningFastifyApplication.inject({
      method: 'GET',
      url: testApiPath('/billing/plans'),
    });
  }

  it('serves structured responses during the combined fault and recovers to 200 after it lifts', async () => {
    // Healthy baseline first, so a later 200 provably means "recovered", not "never hurt".
    const baselineResponseBeforeCombinedFault = await probeThePlansRouteThroughTheDatabase();
    expect(baselineResponseBeforeCombinedFault.statusCode).toBe(200);

    try {
      // Fault A: every Postgres round trip pays 350ms both ways (slow, not down).
      await addToxinOntoListeningChaosTestingProxyDefinition(CHAOS_POSTGRES_PROXY_NAME, {
        name: 'combined_degradation_postgres_latency_observer',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1,
        attributes: { latency: 350, jitter: 50 },
      });
      // Fault B: Redis is administratively unreachable (rate-limit store + caches gone).
      await setChaosTestingListeningProxyEnabledAdministrativeSwitch(CHAOS_REDIS_PROXY_NAME, false);

      for (let probeIndex = 0; probeIndex < 3; probeIndex++) {
        const degradedResponseDuringCombinedFault = await probeThePlansRouteThroughTheDatabase();

        // Bounded degradation: any structured outcome is acceptable — a slow 200 (Redis
        // rate limiter failed open, Postgres merely slow), a 429 (limiter failing
        // closed), or a 5xx from the error handler. What is NOT acceptable is a
        // non-JSON body: that would mean an unhandled crash escaped the envelope.
        expect([200, 429, 500, 503]).toContain(degradedResponseDuringCombinedFault.statusCode);
        expect(() => JSON.parse(degradedResponseDuringCombinedFault.body)).not.toThrow();
      }
    } finally {
      await removeEveryToxinAttachedToListeningChaosTestingProxyDefinition(
        CHAOS_POSTGRES_PROXY_NAME,
      );
      await setChaosTestingListeningProxyEnabledAdministrativeSwitch(CHAOS_REDIS_PROXY_NAME, true);
      await resetChaosTestingListeningProxyFailuresGloballyViaToxiproxy();
    }

    // Recovery: the same process serves 200 again without any restart. Allow a short
    // window for pooled connections to re-establish after the faults lift.
    const recoveryDeadline = Date.now() + 15_000;
    let recoveredResponseStatusCode = 0;
    while (Date.now() < recoveryDeadline) {
      const responseAfterFaultsLifted = await probeThePlansRouteThroughTheDatabase();
      recoveredResponseStatusCode = responseAfterFaultsLifted.statusCode;
      if (recoveredResponseStatusCode === 200) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
    expect(recoveredResponseStatusCode).toBe(200);
  });
});
