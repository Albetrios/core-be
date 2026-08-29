/**
 * Notification bulk seeder — fills each registered user's in-app inbox with
 * `counts.notificationsPerUser` rows spread across notification types and read-state, plus a
 * deliberate unread/read mix. Tagged with a `data.seed = 'bulk'` marker so re-runs resume
 * idempotently and never touch hand-seeded demo notifications.
 *
 * Idempotency: count-and-resume per user — for each user the seeder counts existing
 * marker-tagged rows and inserts only the missing remainder, so a re-run with the same counts
 * is a no-op. High-count inserts are batched in chunks of {@link INSERT_BATCH_SIZE}.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkNotification } from './notification.faker.js';

/** Marker stored in `notifications.data` so bulk rows are countable and resumable. */
const BULK_MARKER = { seed: 'bulk' } as const;
/** SQL predicate matching only marker-tagged bulk notifications. */
const BULK_MARKER_PREDICATE = sql`${notifications.data} ->> 'seed' = 'bulk'`;
/** Max rows per multi-row insert to keep statements bounded for high per-user counts. */
const INSERT_BATCH_SIZE = 500;

/** A fully-resolved notification row ready for insertion. */
interface NotificationInsert {
  public_id: string;
  user_id: number;
  organization_id: number | null;
  type: string;
  title: string;
  message: string;
  data: typeof BULK_MARKER;
  is_read: boolean;
  read_at: Date | null;
}

/**
 * Builds one bulk notification row for a user, deriving read-state from the row index so each
 * user gets a deterministic unread/read spread (roughly every third row is marked read).
 */
function buildNotification(
  context: SeedContext,
  options: { userId: number; organizationId: number | null; index: number },
): NotificationInsert {
  const content = generateBulkNotification(context.faker);
  const isRead = options.index % 3 === 0;
  return {
    public_id: generatePublicId('notification'),
    user_id: options.userId,
    organization_id: options.organizationId,
    type: content.type,
    title: content.title,
    message: content.message,
    data: BULK_MARKER,
    is_read: isRead,
    read_at: isRead ? new Date() : null,
  };
}

/**
 * Seeds in-app notifications for every user in `context.registry.users`.
 *
 * @remarks
 * Parents read: `context.registry.users` (each {@link SeededUser}) and the first
 * `context.registry.organizations` entry (used as the notification's organization scope; the
 * column is nullable so an empty organization registry still seeds). Algorithm: per user, count existing
 * marker-tagged rows and insert only the remaining `notificationsPerUser` in chunks of
 * {@link INSERT_BATCH_SIZE}. Side effects: inserts into `notify.notifications`. Failure modes:
 * warns and returns early if the user pool is empty; otherwise propagates DB errors.
 */
export async function seedNotificationsBulk(context: SeedContext): Promise<void> {
  const database = getRequestDatabase();
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn('seed.bulk.notification: empty user pool; run the user seeder first');
    return;
  }

  const target = context.counts.notificationsPerUser;
  const organizationId = context.registry.organizations[0]?.id ?? null;
  let totalInserted = 0;

  for (const user of users) {
    const [existing] = await database
      .select({ total: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.user_id, user.id), BULK_MARKER_PREDICATE));
    const have = existing?.total ?? 0;

    const pending: NotificationInsert[] = [];
    for (let index = have; index < target; index += 1) {
      pending.push(buildNotification(context, { userId: user.id, organizationId, index }));
    }

    for (let offset = 0; offset < pending.length; offset += INSERT_BATCH_SIZE) {
      const chunk = pending.slice(offset, offset + INSERT_BATCH_SIZE);
      await database.insert(notifications).values(chunk);
      totalInserted += chunk.length;
    }
  }

  context.logger.info(
    { users: users.length, inserted: totalInserted },
    'seed.bulk.notification: notifications seeded',
  );
}
