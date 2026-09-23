import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateSuperAdminToken } from '@/tests/helpers/test-auth.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { AuditRepository } from '@/domains/audit/audit.repository.js';
import {
  type RequestScopedPostgresDatabase,
  runWithPinnedDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import type { FastifyInstance } from 'fastify';

/**
 * Focused HTTP contracts for `GET /api/v1/audit/logs`.
 *
 * **Scope split with `audit.test.ts`.** These two files used to carry byte-identical `it()`
 * titles — five-for-five, both DB-bound — so ten cases bought five behaviors and a fix applied
 * to one could leave the other stale. The bundled e2e suite (`audit.test.ts`) is now canonical
 * for the route's *gates*: 401, 403 for a plain user, 403 for a forged admin claim, and 200 for
 * a super-admin. This file is canonical for what comes back *through* those gates — the response
 * body, the cursor contract, input rejection, and the serializer boundary. Nothing is asserted
 * in both.
 */
interface SerializedAuditEntry {
  action: string;
  resource_type: string;
  severity: string;
  created_at: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  organization_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
}

interface AuditListBody {
  data: SerializedAuditEntry[];
  meta?: { pagination?: { per_page: number; has_more: boolean; next: string | null } };
}

/** Fixed, well-separated instants so newest-first ordering is deterministic, not timing-dependent. */
const BASE_INSTANT = Date.parse('2024-03-01T00:00:00.000Z');
const ONE_MINUTE_MS = 60_000;

describe('Audit Domain — Integration', () => {
  let app: FastifyInstance;
  const repository = new AuditRepository();
  // Seeds go through the REAL repository, pinned to the operator connection. These rows are
  // paging fixtures for a super-admin read, not the behaviour under test; under
  // `pnpm test:rls-role` the pool under test is `core_be_app`, whose tenant-scoped INSERT
  // policy would reject a fixture written with no organization context.
  const seedAuditRow = (row: Parameters<AuditRepository['insert']>[0]) =>
    runWithPinnedDatabaseHandle(
      getOperatorDatabase() as unknown as RequestScopedPostgresDatabase,
      () => repository.insert(row),
    );

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** Seeds `count` audit rows one minute apart, oldest first; returns their actions in that order. */
  async function seedAuditLogs(actorId: number, count: number): Promise<string[]> {
    const actions: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const action = `audit.seeded.${index}`;
      await seedAuditRow({
        actor_user_id: actorId,
        action,
        resource_type: 'user',
        resource_id: actorId,
        severity: 'INFO',
        ip_address: '203.0.113.7',
        user_agent: 'integration/1.0',
        metadata: { seq: index },
        created_at: new Date(BASE_INSTANT + index * ONE_MINUTE_MS),
      });
      actions.push(action);
    }
    return actions;
  }

  async function listLogs(token: string, query: Record<string, string> = {}) {
    return injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/audit/logs'),
      token,
      query,
    });
  }

  describe('GET /api/v1/audit/logs — response body', () => {
    /**
     * The happy path previously asserted only that `body.data` was defined. A serializer
     * regression that emptied every row, dropped every field, or returned `[]` would have passed.
     * Seed known rows and assert the actual shape.
     */
    it('returns the seeded rows with the full serialized field set', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);
      await seedAuditLogs(user.id, 3);

      const response = await listLogs(token);

      expect(response.statusCode).toBe(200);
      const body = response.json() as AuditListBody;
      expect(body.data).toHaveLength(3);

      const [entry] = body.data;
      expect(entry).toMatchObject({
        resource_type: 'user',
        severity: 'INFO',
        ip_address: '203.0.113.7',
        user_agent: 'integration/1.0',
        // sec-re-08: the internal bigint actor id is replaced by the resolved public id.
        actor_user_id: user.public_id,
        target_user_id: null,
        organization_id: null,
      });
      expect(entry?.action).toMatch(/^audit\.seeded\.\d$/);
      expect(new Date(entry!.created_at).toISOString()).toBe(entry!.created_at);
      // Strip-only allowlist: no internal surrogate may appear as a top-level key.
      expect(Object.keys(entry!).sort()).toEqual([
        'action',
        'actor_user_id',
        'created_at',
        'ip_address',
        'metadata',
        'organization_id',
        'resource_type',
        'severity',
        'target_user_id',
        'user_agent',
      ]);
    });

    /**
     * Newest-first is the ordering the cursor is built on (`ORDER BY created_at DESC, id DESC`).
     * If it silently flipped, paging would still "work" while walking the ledger backwards —
     * and an admin investigating an incident would read the oldest events first.
     */
    it('orders rows newest-first', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);
      const seededOldestFirst = await seedAuditLogs(user.id, 4);

      const response = await listLogs(token);

      const body = response.json() as AuditListBody;
      expect(body.data.map((entry) => entry.action)).toEqual([...seededOldestFirst].reverse());
    });
  });

  describe('GET /api/v1/audit/logs — cursor pagination', () => {
    /**
     * The pre-existing pagination case seeded fewer rows than `limit` and only checked that
     * `per_page` echoed back the value it sent — it never followed a cursor. These two cases
     * actually page: `has_more` / `next` must be truthful, and page 2 must continue the feed.
     */
    it('reports has_more and mints a cursor when more rows remain', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);
      await seedAuditLogs(user.id, 5);

      const response = await listLogs(token, { limit: '2' });

      expect(response.statusCode).toBe(200);
      const body = response.json() as AuditListBody;
      expect(body.data).toHaveLength(2);
      expect(body.meta?.pagination?.per_page).toBe(2);
      expect(body.meta?.pagination?.has_more).toBe(true);
      expect(body.meta?.pagination?.next).toBeTruthy();
    });

    /**
     * The contract that makes a cursor a cursor: page 2 is disjoint from page 1 and continues
     * the same newest-first ordering, and the final page clears `next` / `has_more`. A cursor
     * that re-served page 1 would satisfy every assertion in the case above.
     */
    it('follows the cursor to a disjoint page 2 and clears the cursor on the last page', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);
      const seededOldestFirst = await seedAuditLogs(user.id, 5);
      const newestFirst = [...seededOldestFirst].reverse();

      const pageOne = (await listLogs(token, { limit: '2' })).json() as AuditListBody;
      expect(pageOne.data.map((entry) => entry.action)).toEqual(newestFirst.slice(0, 2));

      const cursor = pageOne.meta?.pagination?.next as string;
      const pageTwo = (
        await listLogs(token, { limit: '2', after: cursor })
      ).json() as AuditListBody;
      expect(pageTwo.data.map((entry) => entry.action)).toEqual(newestFirst.slice(2, 4));

      const lastPage = (
        await listLogs(token, {
          limit: '2',
          after: pageTwo.meta?.pagination?.next as string,
        })
      ).json() as AuditListBody;
      expect(lastPage.data.map((entry) => entry.action)).toEqual(newestFirst.slice(4));
      expect(lastPage.meta?.pagination?.has_more).toBe(false);
      expect(lastPage.meta?.pagination?.next).toBeNull();
    });

    /**
     * Stability under concurrent writes — the property that makes a keyset cursor worth having
     * over an OFFSET.
     *
     * The cases above page a table nobody is writing to. Audit is append-only and written by every
     * mutating request, so in production rows arrive *between* a caller's page 1 and page 2. With
     * OFFSET, those inserts shift the window and page 2 re-serves rows already seen; a keyset
     * cursor is anchored to `(created_at, id)` and must not. Nothing asserted that.
     */
    it('is not disturbed by rows inserted after the cursor was minted', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);
      const seededOldestFirst = await seedAuditLogs(user.id, 5);
      const newestFirst = [...seededOldestFirst].reverse();

      const pageOne = (await listLogs(token, { limit: '2' })).json() as AuditListBody;
      const pageOneActions = pageOne.data.map((entry) => entry.action);
      expect(pageOneActions).toEqual(newestFirst.slice(0, 2));

      // A newer row lands mid-walk. It sorts ahead of everything on page 1, which is exactly the
      // insert that shifts an OFFSET window by one and makes page 2 repeat a row.
      await seedAuditRow({
        actor_user_id: user.id,
        action: 'audit.seeded.concurrent',
        resource_type: 'user',
        resource_id: user.id,
        severity: 'INFO',
        ip_address: '203.0.113.7',
        user_agent: 'integration/1.0',
        metadata: { seq: 99 },
        created_at: new Date(BASE_INSTANT + 99 * ONE_MINUTE_MS),
      });

      const pageTwo = (
        await listLogs(token, { limit: '2', after: pageOne.meta?.pagination?.next as string })
      ).json() as AuditListBody;
      const pageTwoActions = pageTwo.data.map((entry) => entry.action);

      // Page 2 continues from the anchor: the pre-existing feed, unshifted.
      expect(pageTwoActions).toEqual(newestFirst.slice(2, 4));
      // No row is served twice, and the late arrival never appears behind the cursor.
      expect(pageTwoActions.filter((action) => pageOneActions.includes(action))).toEqual([]);
      expect(pageTwoActions).not.toContain('audit.seeded.concurrent');
    });

    /**
     * The classic keyset failure: a cursor anchored on the sort column alone cannot separate rows
     * that share it. Audit orders by `created_at DESC, id DESC`, so ties break on the id — but a
     * regression that dropped the tiebreak would skip or repeat a row exactly at a page boundary
     * that falls between two same-instant rows, and every other case here would still pass.
     */
    it('pages cleanly through rows sharing the same created_at', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);

      const sharedInstant = new Date(BASE_INSTANT);
      for (let index = 0; index < 4; index += 1) {
        await seedAuditRow({
          actor_user_id: user.id,
          action: `audit.tied.${index}`,
          resource_type: 'user',
          resource_id: user.id,
          severity: 'INFO',
          ip_address: '203.0.113.7',
          user_agent: 'integration/1.0',
          metadata: { seq: index },
          created_at: sharedInstant,
        });
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      // Bounded walk: four tied rows at limit 2 is two pages; the bound stops a broken cursor
      // from looping forever instead of failing.
      for (let page = 0; page < 4; page += 1) {
        const body = (
          await listLogs(token, { limit: '2', ...(cursor ? { after: cursor } : {}) })
        ).json() as AuditListBody;
        collected.push(...body.data.map((entry) => entry.action));
        cursor = body.meta?.pagination?.next;
        if (!body.meta?.pagination?.has_more) break;
      }

      // Every row exactly once — no skip, no repeat, across the boundary that splits the tie.
      expect([...collected].sort()).toEqual([
        'audit.tied.0',
        'audit.tied.1',
        'audit.tied.2',
        'audit.tied.3',
      ]);
      expect(new Set(collected).size).toBe(collected.length);
    });

    /**
     * `has_more` is the flag every client loops on. It must be *computed*, not guessed — a route
     * that returned `data.length === limit` would report `has_more: true` on a perfectly full
     * final page and send the client into an extra round-trip forever.
     */
    it('reports has_more: false on a final page that is exactly full', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);
      await seedAuditLogs(user.id, 4);

      const pageOne = (await listLogs(token, { limit: '2' })).json() as AuditListBody;
      const pageTwo = (
        await listLogs(token, { limit: '2', after: pageOne.meta?.pagination?.next as string })
      ).json() as AuditListBody;

      expect(pageTwo.data).toHaveLength(2);
      expect(pageTwo.meta?.pagination?.has_more).toBe(false);
      expect(pageTwo.meta?.pagination?.next).toBeNull();
    });
  });

  describe('GET /api/v1/audit/logs — input rejection', () => {
    /**
     * Eight validator unit cases prove the `from`/`to` rules; nothing proved the validator is
     * still reachable from the route. The platform DoS suite touches this route but accepts
     * either `400` or `422`, so no audit-owned test ever pinned which status the domain returns.
     */
    it('rejects a malformed from/to pair with 400 and a field-level error', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);

      const response = await listLogs(token, { from: '2024-03-01', to: 'not-a-datetime' });

      expect(response.statusCode).toBe(400);
      const body = response.json() as {
        error?: { code?: string; errors?: { field: string; message: string }[] };
      };
      expect(body.error?.code).toBe('invalid_field');
      // `from` is date-only and `to` is not a datetime at all — both are reported, with
      // snake_case field names per the API contract.
      expect(body.error?.errors?.map((error) => error.field).sort()).toEqual(['from', 'to']);
    });
  });

  describe('GET /api/v1/audit/logs — serializer boundary', () => {
    /**
     * `audit.serializer.metadata-strip.unit.test.ts` proves the sanitizer in isolation; nothing
     * proved the route's response actually goes through it. Seed one row carrying all three
     * classes of metadata key and assert the wire format.
     */
    it('strips internal ids and redacts secret-bearing metadata keys on the wire', async () => {
      const user = await createTestUser();
      const token = await generateSuperAdminToken(user.public_id);
      await seedAuditRow({
        actor_user_id: user.id,
        action: 'auth.mfa.enrolled',
        resource_type: 'user',
        resource_id: user.id,
        severity: 'WARNING',
        metadata: {
          // Internal numeric surrogate — dropped entirely.
          auth_method_id: 4242,
          // Secret-bearing key — kept, value redacted.
          refresh_token: 'super-secret-value',
          // Public id and free-form fields — an admin needs these to pivot, so they survive.
          session_public_id: 'ses_integrationstrip0001',
          method: 'totp',
        },
        created_at: new Date(BASE_INSTANT),
      });

      const response = await listLogs(token);

      expect(response.statusCode).toBe(200);
      const [entry] = (response.json() as AuditListBody).data;
      expect(entry?.metadata).toEqual({
        refresh_token: '[REDACTED]',
        session_public_id: 'ses_integrationstrip0001',
        method: 'totp',
      });
      expect(entry?.metadata).not.toHaveProperty('auth_method_id');
    });
  });
});
