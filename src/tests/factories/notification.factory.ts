import { database } from '@/infrastructure/database/connection.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

export interface CreateNotificationOptions {
  userId: number;
  organizationId?: number | null;
  type?: string;
  title?: string;
  message?: string;
}

/**
 * Create a test notification owned by `userId` (notify.notifications).
 */
export async function createTestNotification(options: CreateNotificationOptions) {
  const publicId = generatePublicId('notification');
  const [notification] = await database
    .insert(notifications)
    .values({
      public_id: publicId,
      user_id: options.userId,
      organization_id: options.organizationId ?? null,
      type: options.type ?? 'system',
      title: options.title ?? 'Test notification',
      message: options.message ?? 'Test notification message',
    })
    .returning();
  return notification!;
}
