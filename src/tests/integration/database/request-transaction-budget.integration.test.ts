import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateCachedUnreadNotificationCount } from '@/domains/notify/sub-domains/notification/notification-unread-count.cache.js';
import { database } from '@/infrastructure/database/connection.js';
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
 */
const TRANSACTIONS_PER_READ = 1;

describe('Integration: per-request database transaction budget', () => {
  let app: FastifyInstance;
  let token: string;
  let userPublicId: string;

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
    token = await generateTestToken({ userId: user.public_id });
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
  async function countTransactionsForRead(
    url: string,
    coolCache?: () => Promise<void>,
  ): Promise<number> {
    const warmup = await injectAuthenticated(app, { method: 'GET', url, token });
    expect(warmup.statusCode).toBe(200);
    await coolCache?.();

    const transactionSpy = vi.spyOn(database, 'transaction');
    try {
      const response = await injectAuthenticated(app, { method: 'GET', url, token });
      expect(response.statusCode).toBe(200);
      return transactionSpy.mock.calls.length;
    } finally {
      transactionSpy.mockRestore();
    }
  }

  const readRoutes: readonly [name: string, path: string, coolCache?: () => Promise<void>][] = [
    ['GET /users/me', '/users/me'],
    ['GET /users/me/settings', '/users/me/settings'],
    ['GET /users/me/notification-preferences', '/users/me/notification-preferences'],
    ['GET /notify/notifications', '/notify/notifications'],
    [
      'GET /notify/notifications/unread-count',
      '/notify/notifications/unread-count',
      // A tombstone, not a delete — the same call the write paths make, so this measures the miss
      // exactly as production sees it (the populate that follows is `NX`-refused, which costs
      // nothing this test counts).
      async () => {
        await invalidateCachedUnreadNotificationCount(userPublicId);
      },
    ],
    ['GET /users/me/organizations', '/users/me/organizations'],
  ];

  for (const [name, path, coolCache] of readRoutes) {
    it(`${name} opens exactly ${TRANSACTIONS_PER_READ} transaction`, async () => {
      const observed = await countTransactionsForRead(testApiPath(path), coolCache);

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
