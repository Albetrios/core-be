import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { database } from '@/infrastructure/database/connection.js';
import { getElevatedDatabase } from '@/tests/helpers/elevated-database.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestNotification } from '@/tests/factories/notification.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const PERMISSIONS = ['notify:read'];
const UNREAD_COUNT_PATH = testApiPath('/notify/notifications/unread-count');

/**
 * The behaviours every read cache in this repo owes (`docs/reference/runtime/read-caching.md`) —
 * hit, invalidate-on-write, scope isolation, refusal at the gate, and Redis-down fallback — proved
 * over HTTP rather than against the cache module.
 *
 * @remarks
 * The unit test next door proves the tombstone protocol in isolation. What it cannot prove is that
 * the service reads the cache on the right side of `authenticate`, keys it on the verified scope
 * rather than on anything the caller sent, and invalidates on every write path — which is where a
 * caching bug becomes a cross-user read instead of a stale number.
 *
 * The staleness assertions write directly to Postgres, deliberately. Going through the API would
 * invalidate the key and prove nothing; a direct write is the only way to produce a database state
 * the cache has not been told about, which is exactly the condition a cache must survive.
 */
describe('Notification unread count — read cache', () => {
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
    await seedPermissions(PERMISSIONS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createAuthorizedContext(emailSuffix = 'owner') {
    const user = await createTestUser({ email: `unread-${emailSuffix}-${Date.now()}@test.com` });
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: PERMISSIONS,
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, token };
  }

  async function readUnreadCount(token: string, organizationPublicId: string): Promise<number> {
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: UNREAD_COUNT_PATH,
      token,
      organizationPublicId,
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { data: { count: number } }).data.count;
  }

  it('serves a second read from the cache, and a write makes it fresh again', async () => {
    const { user, organization, token } = await createAuthorizedContext();
    await createTestNotification({ userId: user.id, organizationId: organization.id });
    await createTestNotification({ userId: user.id, organizationId: organization.id });

    expect(await readUnreadCount(token, organization.public_id)).toBe(2);

    // A row Postgres knows about and the cache does not. A cached answer still says 2.
    await createTestNotification({ userId: user.id, organizationId: organization.id });
    expect(await readUnreadCount(token, organization.public_id)).toBe(2);

    // Marking all read goes through the service, which invalidates after the commit.
    const markAllRead = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/notify/notifications/mark-all-read'),
      token,
      organizationPublicId: organization.public_id,
    });
    expect(markAllRead.statusCode, markAllRead.body).toBe(200);

    expect(await readUnreadCount(token, organization.public_id)).toBe(0);
  });

  it('invalidates on delete as well as on mark-read', async () => {
    const { user, organization, token } = await createAuthorizedContext();
    const notification = await createTestNotification({
      userId: user.id,
      organizationId: organization.id,
    });
    expect(await readUnreadCount(token, organization.public_id)).toBe(1);

    const deleted = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/notify/notifications/${notification.public_id}`),
      token,
      organizationPublicId: organization.public_id,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    expect(await readUnreadCount(token, organization.public_id)).toBe(0);
  });

  it('does not invalidate when the delete found nothing', async () => {
    // A 404 changes no count. Tombstoning on one would let a caller cold-start their own cache at
    // will by deleting ids that do not exist — cheap for them, a Postgres count for us each time.
    const { user, organization, token } = await createAuthorizedContext();
    await createTestNotification({ userId: user.id, organizationId: organization.id });
    expect(await readUnreadCount(token, organization.public_id)).toBe(1);

    const missing = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath('/notify/notifications/notif_doesnotexist000000'),
      token,
      organizationPublicId: organization.public_id,
    });
    expect(missing.statusCode).toBe(404);

    // Still served from the warm entry — proved by writing a row the cache has not been told about.
    await createTestNotification({ userId: user.id, organizationId: organization.id });
    expect(await readUnreadCount(token, organization.public_id)).toBe(1);
  });

  it('keys on the caller, so one warm cache never answers another user', async () => {
    const first = await createAuthorizedContext('first');
    const second = await createAuthorizedContext('second');
    await createTestNotification({ userId: first.user.id, organizationId: first.organization.id });
    await createTestNotification({ userId: first.user.id, organizationId: first.organization.id });
    await createTestNotification({
      userId: second.user.id,
      organizationId: second.organization.id,
    });

    // Warm both, then re-read both: a key built from anything other than the verified scope
    // (a shared key, or one keyed on the organization) would cross the counts here.
    expect(await readUnreadCount(first.token, first.organization.public_id)).toBe(2);
    expect(await readUnreadCount(second.token, second.organization.public_id)).toBe(1);
    expect(await readUnreadCount(first.token, first.organization.public_id)).toBe(2);
    expect(await readUnreadCount(second.token, second.organization.public_id)).toBe(1);
  });

  /**
   * This route's only gate is `authenticate`, so the refusal is 401 rather than the 403 a
   * permission-gated cached route owes. The property under test is the same one either way: the
   * cache is read behind the gate, so a warm entry cannot be reached without passing it.
   */
  it('refuses an unauthenticated read even with the entry warm', async () => {
    const { user, organization, token } = await createAuthorizedContext();
    await createTestNotification({ userId: user.id, organizationId: organization.id });
    expect(await readUnreadCount(token, organization.public_id)).toBe(1);

    const response = await injectUnauthenticated(app, { method: 'GET', url: UNREAD_COUNT_PATH });
    expect(response.statusCode).toBe(401);
  });

  it('falls back to Postgres when Redis is unreachable', async () => {
    const { user, organization, token } = await createAuthorizedContext();
    await createTestNotification({ userId: user.id, organizationId: organization.id });

    // Both halves fail: a cache whose read is guarded but whose populate is not still throws
    // into the request. The count must come back regardless — Postgres is the source of truth
    // and a cache outage is a latency problem, not an availability one.
    vi.spyOn(redisConnection, 'get').mockRejectedValue(new Error('ECONNREFUSED'));
    vi.spyOn(redisConnection, 'set').mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await readUnreadCount(token, organization.public_id)).toBe(1);
    expect(await readUnreadCount(token, organization.public_id)).toBe(1);
  });

  it('bounds staleness from a writer that names no user', async () => {
    // The retention sweep and the enqueue-rollback delete both remove rows without learning whose
    // they were, so neither can invalidate. The TTL is the whole guarantee for those, and this
    // pins the direction of the error: the badge reads high, never low — it can show a
    // notification that is gone, but never hide one that has arrived.
    const { user, organization, token } = await createAuthorizedContext();
    await createTestNotification({ userId: user.id, organizationId: organization.id });
    expect(await readUnreadCount(token, organization.public_id)).toBe(1);

    await getElevatedDatabase().delete(notifications);

    expect(await readUnreadCount(token, organization.public_id)).toBe(1);
  });
});
