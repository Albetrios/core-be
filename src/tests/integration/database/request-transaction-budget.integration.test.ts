import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateCachedUnreadNotificationCount } from '@/domains/notify/sub-domains/notification/notification-unread-count.cache.js';
import { database } from '@/infrastructure/database/connection.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';

/**
 * A budget on how many database TRANSACTIONS a single authenticated read may open.
 *
 * Not a style rule — a capacity one. The measured ceiling of this service (~1,000 req/s on one
 * instance with a 50-connection pool) is set by the pool, not by CPU, and every non-nested
 * `withAppDatabaseContext` opens a transaction and holds one pooled connection from BEGIN to
 * COMMIT. A handler that resolves `user.id` in its own transaction before opening the one it
 * actually reads in therefore burns two connections to serve one request, and the ceiling halves.
 * That is not hypothetical: `/auth/me/context` was measured at six BEGINs for a single request
 * before its reads were folded together, and `GET /notify/notifications/unread-count` spent two
 * checkouts and eight round trips to return a single integer.
 *
 * Reads here are worth one transaction each. If a change pushes one of these over budget, the
 * likely cause is a lookup that should have happened INSIDE the context the handler already opens
 * — see `UserService.resolveInternalIdByPublicId`.
 *
 * **Why an organization-scoped row is worth its extra fixture.** `GET /billing/subscriptions` makes
 * TWO `withAppDatabaseContext` calls and still costs one transaction, and the reason is three files
 * away from the route. `SubscriptionService.decorateWithSeatCounts` reaches across into
 * `MembershipService.countActiveMembers`, which mints a fresh
 * `PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId })`; the reuse predicate in
 * `database-context.ts` matches on the **organization public id alone**, not on scope kind, so the
 * nested call reuses the handle the outer context pinned rather than taking a second checkout.
 * (That outer pin is the service's own — `organization-rls-transaction.middleware.ts` is a no-op
 * stub today and pins nothing.) Narrow that predicate, move the seat count outside the context, or
 * have it resolve a different organization, and this route silently doubles its pool cost with
 * nothing else objecting. Hence the row.
 */
const TRANSACTIONS_PER_READ = 1;

const ORGANIZATION_SCOPED_PERMISSIONS = ['subscription:read'];

describe('Integration: per-request database transaction budget', () => {
  let app: FastifyInstance;
  let token: string;
  let userPublicId: string;
  let organizationToken: string;
  let organizationPublicId: string;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    const user = await createTestUser({ isEmailVerified: true });
    userPublicId = user.public_id;
    // The user-only token stays exactly as it was, so the user-scoped rows keep measuring what
    // they measured before the organization fixture existed.
    token = await generateTestToken({ userId: user.public_id });

    await seedPermissions(ORGANIZATION_SCOPED_PERMISSIONS);
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ORGANIZATION_SCOPED_PERMISSIONS,
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    organizationPublicId = organization.public_id;
    organizationToken = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
  });

  /**
   * Transactions opened while serving ONE request.
   *
   * The route is called once before measuring: the first authenticated call after a Redis wipe
   * also pays the session-token lookup, and that cost belongs to the auth middleware, not to the
   * handler under test. Counting the second call isolates the handler — and matches the steady
   * state, where the session cache is warm for all but the first request of a session.
   *
   * `coolCache` runs between the two calls, for a route whose own read cache the warm-up would
   * otherwise fill. Without it the measured call is a cache hit at zero transactions and the
   * assertion passes no matter what the Postgres path does — a budget that cannot fail is not a
   * budget. Cooling it back down keeps this measuring the thing that actually costs a checkout.
   */
  async function countTransactionsForRead(options: {
    url: string;
    organizationScoped?: boolean;
    coolCache?: () => Promise<void>;
  }): Promise<number> {
    const request = options.organizationScoped
      ? { token: organizationToken, organizationPublicId }
      : { token };

    const warmup = await injectAuthenticated(app, { method: 'GET', url: options.url, ...request });
    expect(warmup.statusCode, warmup.body).toBe(200);
    await options.coolCache?.();

    const transactionSpy = vi.spyOn(database, 'transaction');
    try {
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: options.url,
        ...request,
      });
      expect(response.statusCode, response.body).toBe(200);
      return transactionSpy.mock.calls.length;
    } finally {
      transactionSpy.mockRestore();
    }
  }

  type ReadRoute = {
    name: string;
    path: string;
    /** Send the organization-claim token and organization header instead of the user-only token. */
    organizationScoped?: boolean;
    coolCache?: () => Promise<void>;
  };

  const readRoutes: readonly ReadRoute[] = [
    { name: 'GET /users/me', path: '/users/me' },
    { name: 'GET /users/me/settings', path: '/users/me/settings' },
    {
      name: 'GET /users/me/notification-preferences',
      path: '/users/me/notification-preferences',
    },
    { name: 'GET /notify/notifications', path: '/notify/notifications' },
    {
      name: 'GET /notify/notifications/unread-count',
      path: '/notify/notifications/unread-count',
      // A tombstone, not a delete — the same call the write paths make, so this measures the miss
      // exactly as production sees it (the populate that follows is `NX`-refused, which costs
      // nothing this test counts).
      coolCache: async () => {
        await invalidateCachedUnreadNotificationCount(userPublicId);
      },
    },
    { name: 'GET /users/me/organizations', path: '/users/me/organizations' },
    {
      name: 'GET /billing/subscriptions',
      path: '/billing/subscriptions',
      organizationScoped: true,
    },
  ];

  for (const route of readRoutes) {
    it(`${route.name} opens exactly ${TRANSACTIONS_PER_READ} transaction`, async () => {
      const observed = await countTransactionsForRead({
        url: testApiPath(route.path),
        ...(route.organizationScoped === true ? { organizationScoped: true } : {}),
        ...(route.coolCache ? { coolCache: route.coolCache } : {}),
      });

      // The upper bound is the budget. The lower bound is the guard on the budget: a route that
      // reaches Postgres but was measured at zero was not measured at all — its read cache stayed
      // warm through `coolCache`, or a mock swallowed the call — and an upper bound alone would
      // report that as a pass. If a route legitimately becomes free, delete it from this table
      // rather than relaxing this.
      expect(observed).toBeGreaterThan(0);
      expect(observed).toBeLessThanOrEqual(TRANSACTIONS_PER_READ);
    });
  }
});
