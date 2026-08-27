import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { eq, inArray } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestNotification } from '@/tests/factories/notification.factory.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { runNotificationRetentionJob } from '@/domains/notify/sub-domains/notification/workers/notification-retention.processor.js';
import { env } from '@/shared/config/env.config.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Notification retention proved *construction*, not *effect*: twelve of the domain's seventeen
 * retention cases assert queue names, concurrency, and context wrappers, and only two assert what
 * a purge does to rows — neither of them for notifications.
 *
 * These cases drive the processor against real Postgres and assert on the rows themselves.
 */
describe('runNotificationRetentionJob (database)', () => {
  const retentionDays = env.NOTIFICATION_RETENTION_DAYS;
  const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

  /** A timestamp `daysAgo` days before now. */
  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * MILLISECONDS_PER_DAY);
  }

  async function backdate(notificationId: number, createdAt: Date): Promise<void> {
    await database
      .update(notifications)
      .set({ created_at: createdAt })
      .where(eq(notifications.id, notificationId));
  }

  async function runRetention() {
    return withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      (databaseHandle) => runNotificationRetentionJob(databaseHandle),
    );
  }

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('deletes notifications older than the retention window and keeps recent ones', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const recent = await createTestNotification({
      userId: user.id,
      organizationId: organization.id,
      title: 'recent',
    });
    const stale = await createTestNotification({
      userId: user.id,
      organizationId: organization.id,
      title: 'stale',
    });
    await backdate(stale.id, daysAgo(retentionDays + 10));

    const result = await runRetention();

    expect(result.deletedCount).toBe(1);
    const remaining = await database.select({ id: notifications.id }).from(notifications);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(recent.id);
  });

  it('keeps a row sitting just inside the cutoff and deletes one just outside it', async () => {
    // The processor filters with `lt(created_at, cutoff)`, so the boundary belongs to the
    // survivor. An off-by-one to `lte` would silently start deleting a day early.
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const justInside = await createTestNotification({
      userId: user.id,
      organizationId: organization.id,
      title: 'just-inside',
    });
    const justOutside = await createTestNotification({
      userId: user.id,
      organizationId: organization.id,
      title: 'just-outside',
    });
    // One hour on the safe side of the cutoff, one hour past it.
    await backdate(justInside.id, new Date(daysAgo(retentionDays).getTime() + 60 * 60 * 1000));
    await backdate(justOutside.id, new Date(daysAgo(retentionDays).getTime() - 60 * 60 * 1000));

    const result = await runRetention();

    expect(result.deletedCount).toBe(1);
    const remaining = await database.select({ id: notifications.id }).from(notifications);
    expect(remaining.map((row) => row.id)).toEqual([justInside.id]);
  });

  it('drains every expired row in a single run rather than one batch', async () => {
    // deleteInBatchesByCondition loops until exhaustion. A processor that deleted one chunk and
    // returned would leave rows behind forever — the cron would never catch up on a large table.
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const staleIds: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const notification = await createTestNotification({
        userId: user.id,
        organizationId: organization.id,
        title: `stale-${String(index)}`,
      });
      await backdate(notification.id, daysAgo(retentionDays + 1 + index));
      staleIds.push(notification.id);
    }

    const result = await runRetention();

    expect(result.deletedCount).toBe(staleIds.length);
    const survivors = await database
      .select({ id: notifications.id })
      .from(notifications)
      .where(inArray(notifications.id, staleIds));
    expect(survivors).toHaveLength(0);
  });

  it('purges on age alone — a read notification is not exempt', async () => {
    // Retention policy is age-based; `read_at` plays no part. Pinned because "keep unread rows
    // forever" is a plausible-sounding change that would quietly break the retention guarantee.
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const readStale = await createTestNotification({
      userId: user.id,
      organizationId: organization.id,
      title: 'read-stale',
    });
    const unreadStale = await createTestNotification({
      userId: user.id,
      organizationId: organization.id,
      title: 'unread-stale',
    });
    await database
      .update(notifications)
      .set({ read_at: new Date(), created_at: daysAgo(retentionDays + 5) })
      .where(eq(notifications.id, readStale.id));
    await backdate(unreadStale.id, daysAgo(retentionDays + 5));

    const result = await runRetention();

    expect(result.deletedCount).toBe(2);
    const remaining = await database.select({ id: notifications.id }).from(notifications);
    expect(remaining).toHaveLength(0);
  });

  it('purges across organizations under the global retention context', async () => {
    // The job runs under withMaintenanceDatabaseContext precisely so it can see rows
    // from every tenant. If it were ever run with a request-scoped handle, RLS would hide most
    // rows and the purge would silently under-delete instead of failing.
    const firstUser = await createTestUser();
    const firstOrganization = await createTestOrganization({ ownerUserId: firstUser.id });
    const secondUser = await createTestUser({ email: `second-${Date.now()}@test.com` });
    const secondOrganization = await createTestOrganization({ ownerUserId: secondUser.id });

    const firstStale = await createTestNotification({
      userId: firstUser.id,
      organizationId: firstOrganization.id,
    });
    const secondStale = await createTestNotification({
      userId: secondUser.id,
      organizationId: secondOrganization.id,
    });
    // A user-scoped notification with no tenant at all must be purged too.
    const tenantlessStale = await createTestNotification({
      userId: firstUser.id,
      organizationId: null,
    });
    for (const notification of [firstStale, secondStale, tenantlessStale]) {
      await backdate(notification.id, daysAgo(retentionDays + 3));
    }

    const result = await runRetention();

    expect(result.deletedCount).toBe(3);
    expect(result.blockedCount).toBe(0);
    const remaining = await database.select({ id: notifications.id }).from(notifications);
    expect(remaining).toHaveLength(0);
  });
});
