import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { withTransaction } from '@/infrastructure/database/transaction.js';
import { database } from '@/infrastructure/database/connection.js';
import { users } from '@/domains/user/user.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

function buildUserInsert(email: string) {
  return {
    public_id: generatePublicId('user'),
    email,
    email_hash: createHash('sha256').update(email).digest('hex'),
    status: 'ACTIVE' as const,
  };
}

describe('Integration: transaction rollback on error', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('rolls back all writes when the callback throws', async () => {
    const rolledBackEmail = 'rollback-test@example.com';
    const seedEmail = 'seed-before-rollback@example.com';
    await createTestUser({ email: seedEmail });

    await expect(
      withTransaction(async (transaction) => {
        const databaseHandle = transaction as typeof database;
        await databaseHandle.insert(users).values(buildUserInsert(rolledBackEmail));
        throw new Error('Simulated failure');
      }),
    ).rejects.toThrow('Simulated failure');

    const rolledBackRows = await database
      .select()
      .from(users)
      .where(eq(users.email, rolledBackEmail));
    expect(rolledBackRows).toHaveLength(0);

    const seedRows = await database.select().from(users).where(eq(users.email, seedEmail));
    expect(seedRows).toHaveLength(1);
  });

  it('commits writes when the callback completes successfully', async () => {
    const committedEmail = 'rollback-commit@example.com';

    await withTransaction(async (transaction) => {
      const databaseHandle = transaction as typeof database;
      await databaseHandle.insert(users).values(buildUserInsert(committedEmail));
    });

    const committedRows = await database
      .select()
      .from(users)
      .where(eq(users.email, committedEmail));
    expect(committedRows).toHaveLength(1);
  });
});
