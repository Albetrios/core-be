import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { database } from '@/infrastructure/database/connection.js';
import { mail_outbox } from '@/infrastructure/mail/mail-outbox.schema.js';
import {
  insertMailOutbox,
  tryClaimPendingMailOutbox,
} from '@/infrastructure/mail/mail-outbox.repository.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

describe('Integration: mail outbox claim race', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('allows only one pending → sending claim when ten workers race', async () => {
    const mailOutboxId = await insertMailOutbox({
      to: ['race@example.com'],
      subject: 'Claim race',
      html: '<p>Hi</p>',
    });

    const claimResults = await Promise.all(
      Array.from({ length: 10 }, () => tryClaimPendingMailOutbox(mailOutboxId)),
    );

    expect(claimResults.filter((result) => result === 'claimed')).toHaveLength(1);
    expect(claimResults.filter((result) => result === 'in_flight')).toHaveLength(9);

    const rows = await database
      .select({ status: mail_outbox.status })
      .from(mail_outbox)
      .where(eq(mail_outbox.id, mailOutboxId));

    expect(rows[0]?.status).toBe('sending');
  });
});
