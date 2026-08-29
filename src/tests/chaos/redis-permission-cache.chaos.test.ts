import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { CHAOS_REDIS_PROXY_NAME } from '@/tests/chaos/chaos.constants.js';
import { createListeningChaosTestApplicationHarness } from '@/tests/chaos/helpers/chaos-app.js';
import {
  resetChaosTestingListeningProxyFailuresGloballyViaToxiproxy,
  withTemporaryListeningProxyAdministrativelyDisabledForChaosAssertion,
} from '@/tests/chaos/helpers/toxiproxy.client.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

describe('Chaos resilience: Redis permission-cache miss', () => {
  let chaosFastifyApplicationInstance: FastifyInstance;

  beforeAll(async () => {
    const harnessObservationAwaitingIsolation = await createListeningChaosTestApplicationHarness();
    chaosFastifyApplicationInstance =
      harnessObservationAwaitingIsolation.chaosApplicationListeningInstance;
  });

  afterAll(async () => {
    await chaosFastifyApplicationInstance.close();
    await resetChaosTestingListeningProxyFailuresGloballyViaToxiproxy();
  });

  beforeEach(async () => {
    await seedPermissions([
      ...Object.values(TENANCY_PERMISSIONS),
      ...Object.values(NOTIFY_PERMISSIONS),
    ]);
  });

  it('falls through to Postgres joins when Redis cache reads fail outright', async () => {
    const permissionCacheObservationSpyListening = vi.spyOn(logger, 'warn');

    const userWaitingForIsolation = await createTestUser();
    const organizationWaitingForIsolation = await createTestOrganization({
      ownerUserId: userWaitingForIsolation.id,
    });

    const tenancyRoleWaitingForIsolation = await createRoleWithPermissions({
      organizationId: organizationWaitingForIsolation.id,
      permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
    });

    await createMembership({
      userId: userWaitingForIsolation.id,
      organizationId: organizationWaitingForIsolation.id,
      roleId: tenancyRoleWaitingForIsolation.id,
    });

    const authenticationTokenWaitingForIsolation = await generateTestToken({
      userId: userWaitingForIsolation.public_id,
      organizationPublicId: organizationWaitingForIsolation.public_id,
    });

    try {
      await withTemporaryListeningProxyAdministrativelyDisabledForChaosAssertion(
        CHAOS_REDIS_PROXY_NAME,
        async () => {
          const membershipsHttpRouteResponseListening =
            await chaosFastifyApplicationInstance.inject({
              method: 'GET',
              url: testApiPath('/tenancy/organization/memberships'),
              headers: {
                authorization: `Bearer ${authenticationTokenWaitingForIsolation}`,
              },
            });

          expect(membershipsHttpRouteResponseListening.statusCode).toBeGreaterThanOrEqual(200);
          expect(membershipsHttpRouteResponseListening.statusCode).toBeLessThan(500);

          expect(
            permissionCacheObservationSpyListening.mock.calls.some(
              ([, messageAwaitingIsolation]) =>
                messageAwaitingIsolation === 'permission-cache.get.failed',
            ),
          ).toBe(true);
        },
      );
    } finally {
      permissionCacheObservationSpyListening.mockRestore();
    }
  });
});
