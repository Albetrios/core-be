import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

describe('countWithCap (database)', () => {
  const repository = new NotificationRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  async function seedNotifications(userId: number, total: number): Promise<void> {
    for (let index = 0; index < total; index += 1) {
      await repository.create({
        user_id: userId,
        type: 'SYSTEM',
        title: `Row ${index}`,
        message: 'Body',
      });
    }
  }

  it('returns the exact count when the row total is below the cap', async () => {
    const user = await createTestUser({ email: 'capped-count-under@example.com' });
    await seedNotifications(user.id, 3);

    const result = await countWithCap({
      database: getRequestDatabase(),
      table: notifications,
      where: eq(notifications.user_id, user.id),
      cap: 10,
    });

    expect(result).toBe(3);
  });

  it('stops counting at the cap so unbounded tables cannot be fully scanned', async () => {
    const user = await createTestUser({ email: 'capped-count-over@example.com' });
    await seedNotifications(user.id, 5);

    const result = await countWithCap({
      database: getRequestDatabase(),
      table: notifications,
      where: eq(notifications.user_id, user.id),
      cap: 2,
    });

    expect(result).toBe(2);
  });
});
