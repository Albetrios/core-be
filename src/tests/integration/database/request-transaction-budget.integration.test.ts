import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    token = await generateTestToken({ userId: user.public_id });
  });

  /**
   * Transactions opened while serving ONE request.
   *
   * The route is called once before measuring: the first authenticated call after a Redis wipe
   * also pays the session-token lookup, and that cost belongs to the auth middleware, not to the
   * handler under test. Counting the second call isolates the handler — and matches the steady
   * state, where the session cache is warm for all but the first request of a session.
   */
  async function countTransactionsForRead(url: string): Promise<number> {
    const warmup = await injectAuthenticated(app, { method: 'GET', url, token });
    expect(warmup.statusCode).toBe(200);

    const transactionSpy = vi.spyOn(database, 'transaction');
    try {
      const response = await injectAuthenticated(app, { method: 'GET', url, token });
      expect(response.statusCode).toBe(200);
      return transactionSpy.mock.calls.length;
    } finally {
      transactionSpy.mockRestore();
    }
  }

  const readRoutes: readonly [name: string, path: string][] = [
    ['GET /users/me', '/users/me'],
    ['GET /users/me/settings', '/users/me/settings'],
    ['GET /users/me/notification-preferences', '/users/me/notification-preferences'],
    ['GET /notify/notifications', '/notify/notifications'],
    ['GET /notify/notifications/unread-count', '/notify/notifications/unread-count'],
    ['GET /tenancy/organizations', '/users/me/organizations'],
  ];

  for (const [name, path] of readRoutes) {
    it(`${name} opens at most ${TRANSACTIONS_PER_READ} transaction`, async () => {
      expect(await countTransactionsForRead(testApiPath(path))).toBeLessThanOrEqual(
        TRANSACTIONS_PER_READ,
      );
    });
  }
});
