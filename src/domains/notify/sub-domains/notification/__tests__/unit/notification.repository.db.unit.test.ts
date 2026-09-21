import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';

describe('NotificationRepository (database)', () => {
  const repository = new NotificationRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('creates, lists, marks read, counts unread, and deletes notifications', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const notificationId = await repository.create({
      user_id: user.id,
      organization_id: organization.id,
      type: 'BILLING',
      title: 'Usage updated',
      message: 'Your monthly usage was updated',
      data: { subscription_id: 'sub_1' },
    });

    const organizationPublicId =
      await repository.findOrganizationPublicIdByNotificationId(notificationId);
    expect(organizationPublicId).toBe(organization.public_id);

    const listed = await repository.findByUser(user.id, { limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.read_at).toBeNull();
    expect(listed.total).toBeNull();
    expect(listed.has_more).toBe(false);

    const unreadBefore = await repository.countUnreadForUser(user.id);
    expect(unreadBefore).toBe(1);

    const marked = await repository.markRead(listed.items[0]!.public_id, user.id);
    expect(marked?.read_at).not.toBeNull();

    const unreadAfterMark = await repository.countUnreadForUser(user.id);
    expect(unreadAfterMark).toBe(0);

    const secondId = await repository.create({
      user_id: user.id,
      type: 'SYSTEM',
      title: 'Second',
      message: 'Another notification',
    });
    expect(secondId).toBeGreaterThan(notificationId);

    const organizationPublicIdWithoutOrg =
      await repository.findOrganizationPublicIdByNotificationId(secondId);
    expect(organizationPublicIdWithoutOrg).toBeNull();

    const markedAll = await repository.markAllReadForUser(user.id);
    expect(markedAll).toBeGreaterThanOrEqual(1);

    const deleted = await repository.deleteByPublicIdForUser(listed.items[0]!.public_id, user.id);
    expect(deleted?.public_id).toBe(listed.items[0]!.public_id);

    const byPublicId = await repository.findByPublicIdForUser(listed.items[0]!.public_id, user.id);
    expect(byPublicId).toBeNull();
  });

  it('findByIdForDispatch returns row scoped to organization', async () => {
    const user = await createTestUser({ email: 'dispatch@example.com' });
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const notificationId = await repository.create({
      user_id: user.id,
      organization_id: organization.id,
      type: 'BILLING',
      title: 'Dispatch',
      message: 'Body',
    });

    const row = await repository.findByIdForDispatch(notificationId, organization.public_id);
    expect(row?.title).toBe('Dispatch');
    expect(row?.userEmail).toBe('dispatch@example.com');
  });

  it('findByIdForDispatch scopes user-only notifications with null organization', async () => {
    const user = await createTestUser({ email: 'personal@example.com' });
    const notificationId = await repository.create({
      user_id: user.id,
      type: 'SYSTEM',
      title: 'Personal',
      message: 'No org',
    });

    const row = await repository.findByIdForDispatch(notificationId, null);
    expect(row?.title).toBe('Personal');

    const wrongScope = await repository.findByIdForDispatch(notificationId, 'wrong_org');
    expect(wrongScope).toBeNull();
  });

  it('countUnreadForUser returns zero when the user has no notifications', async () => {
    const user = await createTestUser({ email: 'notify-empty@example.com' });
    expect(await repository.countUnreadForUser(user.id)).toBe(0);
  });

  it('markRead and delete return null for unknown public ids', async () => {
    const user = await createTestUser({ email: 'notify-missing@example.com' });
    expect(await repository.markRead('missing_public_id', user.id)).toBeNull();
    expect(await repository.deleteByPublicIdForUser('missing_public_id', user.id)).toBeNull();
  });

  it('markAllReadForUser returns zero when nothing is unread', async () => {
    const user = await createTestUser({ email: 'notify-read-all@example.com' });
    expect(await repository.markAllReadForUser(user.id)).toBe(0);
    expect(await repository.countUnreadForUser(user.id)).toBe(0);
  });

  // sec-D10: previously implemented as SELECT-unreadCount-then-UPDATE, returning
  // the pre-update count rather than the atomic UPDATE result. Under a race
  // (caller creates a notification between the SELECT and the UPDATE), the two
  // values diverge — the API would tell the client "you marked N notifications
  // as read" while the DB just marked N+1. Switch to UPDATE...RETURNING so the
  // count is sourced from the same atomic statement.
  it('markAllReadForUser returns the count from the UPDATE itself (sec-D10)', async () => {
    const user = await createTestUser({ email: 'notify-read-d10@example.com' });
    await repository.create({
      user_id: user.id,
      type: 'SYSTEM',
      title: 'A',
      message: 'A',
    });
    await repository.create({
      user_id: user.id,
      type: 'SYSTEM',
      title: 'B',
      message: 'B',
    });
    await repository.create({
      user_id: user.id,
      type: 'SYSTEM',
      title: 'C',
      message: 'C',
    });

    const marked = await repository.markAllReadForUser(user.id);
    // Three rows updated atomically; result is sourced from RETURNING, not from
    // a separate pre-update SELECT.
    expect(marked).toBe(3);
    expect(await repository.countUnreadForUser(user.id)).toBe(0);
  });

  // audit #39: the batched `WHERE id IN (SELECT ... LIMIT N)` loop must drain the
  // whole unread set (summing per-batch counts) and then terminate — a marked row
  // leaves the `is_read=false` set, so the next sub-select returns fewer rows.
  it('markAllReadForUser drains all unread rows and terminates (audit #39)', async () => {
    const user = await createTestUser({ email: 'notify-batch-drain@example.com' });
    const unreadCount = 5;
    for (let index = 0; index < unreadCount; index += 1) {
      await repository.create({
        user_id: user.id,
        type: 'SYSTEM',
        title: `N${String(index)}`,
        message: 'body',
      });
    }

    const marked = await repository.markAllReadForUser(user.id);
    expect(marked).toBe(unreadCount);
    expect(await repository.countUnreadForUser(user.id)).toBe(0);

    // A second call has nothing left to mark — the loop exits on the empty batch.
    expect(await repository.markAllReadForUser(user.id)).toBe(0);
  });

  it('findOrganizationPublicIdByOrganizationId resolves public id by internal id', async () => {
    const user = await createTestUser({ email: 'notify-resolve-organization@example.com' });
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const resolved = await repository.findOrganizationPublicIdByOrganizationId(organization.id);
    expect(resolved).toBe(organization.public_id);
  });

  it('findOrganizationPublicIdByOrganizationId returns null for unknown organization id', async () => {
    const resolved = await repository.findOrganizationPublicIdByOrganizationId(-1);
    expect(resolved).toBeNull();
  });

  it('create stores optional action fields', async () => {
    const user = await createTestUser({ email: 'notify-action@example.com' });
    const notificationId = await repository.create({
      user_id: user.id,
      type: 'SYSTEM',
      title: 'Action',
      message: 'Tap to open',
      action_url: 'https://example.com/inbox',
      action_label: 'Open',
    });
    const row = await repository.findByIdForDispatch(notificationId, null);
    expect(row?.actionUrl).toBe('https://example.com/inbox');
  });

  // Every prior findByUser assertion used a single matching row (has_more only ever false, the
  // cursor never round-tripped). Drive the keyset across a real page boundary.
  it('findByUser pages through multiple keyset pages and round-trips the cursor', async () => {
    const user = await createTestUser({ email: 'notify-keyset@example.com' });
    for (let index = 0; index < 3; index += 1) {
      await repository.create({
        user_id: user.id,
        type: 'SYSTEM',
        title: `N${String(index)}`,
        message: 'body',
      });
    }

    const firstPage = await repository.findByUser(user.id, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_cursor).toEqual(expect.any(String));

    const nextPage = await repository.findByUser(user.id, {
      limit: 2,
      after: firstPage.next_cursor!,
    });
    expect(nextPage.items).toHaveLength(1);
    expect(nextPage.has_more).toBe(false);
    expect(nextPage.next_cursor).toBeNull();

    // The two pages are disjoint and together cover all three rows (the (created_at,id) keyset).
    const firstPageIds = firstPage.items.map((row) => row.id);
    expect(firstPageIds).not.toContain(nextPage.items[0]!.id);
    expect(new Set([...firstPageIds, nextPage.items[0]!.id]).size).toBe(3);
  });

  it('findByUser computes a real total only when include_total is set', async () => {
    // The route reserves a dedicated rate limit for include_total precisely because the count(*) is
    // expensive — pin that it is null by default and an accurate count when requested.
    const user = await createTestUser({ email: 'notify-total@example.com' });
    for (let index = 0; index < 3; index += 1) {
      await repository.create({
        user_id: user.id,
        type: 'SYSTEM',
        title: `N${String(index)}`,
        message: 'body',
      });
    }

    expect((await repository.findByUser(user.id, { limit: 2 })).total).toBeNull();

    const withTotal = await repository.findByUser(user.id, { limit: 2, include_total: true });
    expect(withTotal.total).toBe(3);
    expect(withTotal.items).toHaveLength(2);
    expect(withTotal.has_more).toBe(true);
  });
});
