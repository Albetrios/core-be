import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import {
  resetChaosTestingListeningProxyFailuresGloballyViaToxiproxy,
  withTemporaryListeningProxyAdministrativelyDisabledForChaosAssertion,
} from '@/tests/chaos/helpers/toxiproxy.client.js';
import { CHAOS_REDIS_PROXY_NAME } from '@/tests/chaos/chaos.constants.js';
import { createListeningChaosTestApplicationHarness } from '@/tests/chaos/helpers/chaos-app.js';
import { resetPlanCatalogMemoForTests } from '@/domains/billing/sub-domains/plan/plan-catalog-memo.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';

describe('Chaos resilience: Redis outage for Redis-backed billing rate-limit store', () => {
  let chaosListeningFastifyApplicationAwaitingIsolation: FastifyInstance;

  beforeAll(async () => {
    const harnessObservationAwaitingPublicCatalogueTraffic =
      await createListeningChaosTestApplicationHarness();
    chaosListeningFastifyApplicationAwaitingIsolation =
      harnessObservationAwaitingPublicCatalogueTraffic.chaosApplicationListeningInstance;
  });

  afterAll(async () => {
    await chaosListeningFastifyApplicationAwaitingIsolation.close();
    await resetChaosTestingListeningProxyFailuresGloballyViaToxiproxy();
  });

  it('still serves authenticated catalogue reads without unexpected 500 errors', async () => {
    const userAwaitingRedisOutage = await createTestUser();
    const tokenAwaitingRedisOutage = await generateTestToken({
      userId: userAwaitingRedisOutage.public_id,
    });

    await withTemporaryListeningProxyAdministrativelyDisabledForChaosAssertion(
      CHAOS_REDIS_PROXY_NAME,
      async () => {
        // Without this the catalog memo answers from memory and the assertion holds trivially,
        // whatever the rate limiter does with Redis gone — which is the thing under test.
        resetPlanCatalogMemoForTests();
        const catalogueResponseAwaitingIsolation =
          await chaosListeningFastifyApplicationAwaitingIsolation.inject({
            method: 'GET',
            url: testApiPath('/billing/plans'),
            headers: {
              authorization: `Bearer ${tokenAwaitingRedisOutage}`,
            },
          });

        expect(catalogueResponseAwaitingIsolation.statusCode).toBeLessThan(500);
      },
    );
  });
});
