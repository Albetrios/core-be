import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from '@/infrastructure/database/connection.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestNotification } from '@/tests/factories/notification.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';

/**
 * Notify was the last routed read-heavy domain with NO performance coverage, and its
 * inbox is the platform's highest-frequency poll surface (every client polls the list
 * and the unread badge). Three budgets:
 *
 * 1. a scaling guard on `GET /notifications` — an N+1 introduced anywhere in the
 *    request path (repository, serializer, RLS context churn) over 25 rows lands well
 *    past the bound while a constant number of queries stays far under it,
 * 2. the same guard on `GET /notifications/unread-count`, whose repository contract
 *    is a single bounded COUNT — the classic regression is looping rows instead,
 * 3. an EXPLAIN assertion that the inbox keyset query actually uses
 *    `idx_notifications_user_created_id` (migration 20260520000006) rather than a
 *    sequential scan — the index the whole keyset design depends on.
 */
const INBOX_ROW_COUNT = 25;

const runExplainTests = process.env.RUN_EXPLAIN_TESTS !== '0';

describe('Performance: notification inbox', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** User with `INBOX_ROW_COUNT` notifications (unread) and a bearer token. */
  async function createInboxContext() {
    const user = await createTestUser();
    for (let index = 0; index < INBOX_ROW_COUNT; index++) {
      await createTestNotification({
        userId: user.id,
        title: `Inbox budget notification ${index}`,
      });
    }
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, token };
  }

  it('GET /notify/notifications does not scale its work with inbox size', async () => {
    const { token } = await createInboxContext();

    // Warm the app, connection pool, and JIT before measuring.
    await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/notifications?limit=50'),
      token,
    });

    const started = performance.now();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/notifications?limit=50'),
      token,
    });
    const elapsedMs = performance.now() - started;

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown[] }).data).toHaveLength(INBOX_ROW_COUNT);
    // N+1 tripwire, not a latency SLO — a per-row round trip over 25 rows on a
    // containerised Postgres lands well past this bound.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('GET /notify/notifications/unread-count stays a single bounded count', async () => {
    const { token } = await createInboxContext();

    await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/notifications/unread-count'),
      token,
    });

    const started = performance.now();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/notifications/unread-count'),
      token,
    });
    const elapsedMs = performance.now() - started;

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { count: number } }).data.count).toBe(INBOX_ROW_COUNT);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it.runIf(runExplainTests)(
    'inbox keyset query uses idx_notifications_user_created_id (no seq scan)',
    async () => {
      const { user } = await createInboxContext();
      await sql`ANALYZE notify.notifications`;

      const planRows = await sql.begin(async (transaction) => {
        // The seeded table is tiny, so the planner would happily seq-scan it; disabling
        // seq scans locally asks "COULD the keyset index serve this query?" — which is
        // exactly what regresses when someone reorders the ORDER BY tuple or drops a
        // column from the index.
        await transaction`SET LOCAL enable_seqscan = off`;
        return transaction<{ 'QUERY PLAN': string }[]>`
          EXPLAIN (FORMAT TEXT)
          SELECT id FROM notify.notifications
          WHERE user_id = ${user.id}
          ORDER BY created_at DESC, id DESC
          LIMIT 20
        `;
      });

      const planText = planRows
        .map((row) => row['QUERY PLAN'])
        .join('\n')
        .toLowerCase();
      expect(planText).not.toContain('seq scan on notifications');
      expect(planText).toContain('idx_notifications_user_created_id');
    },
  );
});
