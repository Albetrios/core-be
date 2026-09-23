import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { database } from '@/infrastructure/database/connection.js';
import { mail_outbox } from '@/infrastructure/mail/mail-outbox.schema.js';
import {
  insertMailOutbox,
  reclaimStaleSendingMailOutboxIds,
  tryClaimPendingMailOutbox,
} from '@/infrastructure/mail/mail-outbox.repository.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

describe('Integration: mail outbox sending reclaim', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('reclaimStaleSendingMailOutboxIds moves stuck sending rows back to pending', async () => {
    const mailOutboxId = await insertMailOutbox({
      to: ['reclaim@example.com'],
      subject: 'Reclaim test',
      html: '<p>Hi</p>',
    });

    expect(await tryClaimPendingMailOutbox(mailOutboxId)).toBe('claimed');

    await database
      .update(mail_outbox)
      .set({ updated_at: new Date(Date.now() - 60 * 60_000) })
      .where(eq(mail_outbox.id, mailOutboxId));

    const reclaimedIds = await reclaimStaleSendingMailOutboxIds(new Date(), 10);

    expect(reclaimedIds).toEqual([mailOutboxId]);

    const rows = await database
      .select({ status: mail_outbox.status })
      .from(mail_outbox)
      .where(eq(mail_outbox.id, mailOutboxId));

    expect(rows[0]?.status).toBe('pending');
  });
});
