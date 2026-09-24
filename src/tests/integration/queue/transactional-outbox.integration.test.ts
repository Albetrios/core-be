import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import {
  organizationRequestDatabaseStorage,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { enterOnCommitScope, eventBus } from '@/core/events/event-bus.js';
import { mail_outbox } from '@/infrastructure/mail/mail-outbox.schema.js';
import { countPendingMailOutbox } from '@/infrastructure/mail/mail-outbox.repository.js';
import { dispatchOutboxEmail, recordOutboxEmail } from '@/infrastructure/mail/queues/mail.queue.js';
import type * as MailQueueModule from '@/infrastructure/mail/queues/mail.queue.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

const dispatchOutboxEmailMock = vi.fn();

vi.mock('@/infrastructure/mail/queues/mail.queue.js', async (importOriginal) => {
  const original = await importOriginal<typeof MailQueueModule>();
  return {
    ...original,
    dispatchOutboxEmail: (...arguments_: unknown[]) => dispatchOutboxEmailMock(...arguments_),
  };
});

describe('Integration: transactional mail outbox', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    dispatchOutboxEmailMock.mockReset();
    dispatchOutboxEmailMock.mockResolvedValue(undefined);
  });

  it('defers BullMQ dispatch until flushOnCommit after recordOutboxEmail', async () => {
    enterOnCommitScope();
    const mailOutboxId = await recordOutboxEmail({
      to: 'deferred@example.com',
      subject: 'Deferred dispatch test',
      html: '<p>Hello</p>',
    });

    eventBus.onCommit(() => dispatchOutboxEmail(mailOutboxId));
    expect(dispatchOutboxEmailMock).not.toHaveBeenCalled();

    await eventBus.flushOnCommit();
    expect(dispatchOutboxEmailMock).toHaveBeenCalledOnce();
    expect(dispatchOutboxEmailMock).toHaveBeenCalledWith(mailOutboxId);

    const pendingCount = await countPendingMailOutbox();
    expect(pendingCount).toBeGreaterThanOrEqual(1);
  });

  it('does not persist outbox rows when the request transaction rolls back', async () => {
    const email = 'rollback@example.com';

    await expect(
      database.transaction(async (transaction) => {
        const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
        await organizationRequestDatabaseStorage.run(
          { databaseHandle, organizationPublicId: 'org_rollback_test' },
          async () => {
            await recordOutboxEmail({
              to: email,
              subject: 'Should roll back',
              html: '<p>Rollback</p>',
            });
            throw new Error('simulated_handler_failure');
          },
        );
      }),
    ).rejects.toThrow('simulated_handler_failure');

    const rows = await getOperatorDatabase()
      .select({ id: mail_outbox.id })
      .from(mail_outbox)
      .where(drizzleSql`${mail_outbox.to_addresses} @> ${JSON.stringify([email])}::jsonb`);

    expect(rows).toHaveLength(0);
    expect(dispatchOutboxEmailMock).not.toHaveBeenCalled();
  });

  it('persists outbox row when the request transaction commits', async () => {
    const email = 'committed@example.com';
    let mailOutboxId = 0;

    await database.transaction(async (transaction) => {
      const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await organizationRequestDatabaseStorage.run(
        { databaseHandle, organizationPublicId: 'org_commit_test' },
        async () => {
          mailOutboxId = await recordOutboxEmail({
            to: email,
            subject: 'Committed outbox',
            html: '<p>OK</p>',
          });
        },
      );
    });

    const rows = await getOperatorDatabase()
      .select()
      .from(mail_outbox)
      .where(eq(mail_outbox.id, mailOutboxId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
  });
});
