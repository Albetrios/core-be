import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { mail_outbox } from '@/infrastructure/mail/mail-outbox.schema.js';
import { insertMailOutbox } from '@/infrastructure/mail/mail-outbox.repository.js';
import { processMailOutboxJob } from '@/infrastructure/mail/workers/mail.processor.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

const sendEmailMock = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/mail/mail.service.js', () => ({
  sendEmail: (...arguments_: unknown[]) => sendEmailMock(...arguments_),
}));

const PARALLEL_WORKER_COUNT = 10;

describe('Integration: mail worker concurrency race', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    sendEmailMock.mockReset();
  });

  it('sends email exactly once when parallel workers race the same outbox row', async () => {
    const mailOutboxId = await insertMailOutbox({
      to: ['race@example.com'],
      subject: 'Race test',
      html: '<p>Hello</p>',
    });

    sendEmailMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return 'msg_race_single';
    });

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_WORKER_COUNT }, (_, index) =>
        processMailOutboxJob(
          { mailOutboxId, requestId: `req-mail-race-${String(index)}` },
          { jobId: `job-mail-race-${String(index)}`, requestId: `req-mail-race-${String(index)}` },
        ),
      ),
    );

    const sentOnce = results.some(
      (result) =>
        result.status === 'fulfilled' &&
        (result.value as { messageId?: string }).messageId === 'msg_race_single',
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sentOnce).toBe(true);

    const rows = await getOperatorDatabase()
      .select()
      .from(mail_outbox)
      .where(eq(mail_outbox.id, mailOutboxId));

    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.resend_message_id).toBe('msg_race_single');
  });
});
