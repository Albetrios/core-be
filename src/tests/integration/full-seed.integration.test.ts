/**
 * Full-seed integration — verifies `runFullSeed` (`pnpm db:seed:full`) produces the demo
 * dataset it promises and is idempotent, so re-running the demo seed in local development
 * upserts rather than duplicating rows. Also guards the import-safety contract of
 * `src/scripts/seed/full.ts`: importing `runFullSeed` here must NOT trigger a seed or tear
 * down the shared postgres.js pool (the module only auto-runs when executed as the CLI entry).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { runFullSeed } from '@/scripts/seed/full.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { users } from '@/domains/user/user.schema.js';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_ORGANIZATION_SLUG = 'demo-org';

/** Resolve the demo user + organization rows created by the full seed (identity columns). */
async function resolveDemoSeed(): Promise<{
  user: { id: number; public_id: string } | undefined;
  organization: { id: number; public_id: string } | undefined;
}> {
  const database = getRequestDatabase();
  const [user] = await database
    .select({ id: users.id, public_id: users.public_id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .limit(1);
  const [organization] = await database
    .select({ id: organizations.id, public_id: organizations.public_id })
    .from(organizations)
    .where(eq(organizations.slug, DEMO_ORGANIZATION_SLUG))
    .limit(1);
  return { user, organization };
}

describe('Full seed — integration', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    process.env.DEMO_PASSWORD = 'DemoPassword123!';
  });

  it('seeds the demo user, organization, and an active admin membership', async () => {
    await runFullSeed();

    const { user, organization } = await resolveDemoSeed();
    expect(user).toBeDefined();
    expect(organization).toBeDefined();

    const database = getRequestDatabase();
    const [membershipRow] = await database
      .select({ status: memberships.status })
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, user!.id),
          eq(memberships.organization_id, organization!.id),
          isNull(memberships.deleted_at),
        ),
      )
      .limit(1);
    expect(membershipRow?.status).toBe('ACTIVE');
  });

  it('is idempotent — re-running upserts instead of duplicating demo rows', async () => {
    await runFullSeed();
    const first = await resolveDemoSeed();
    await runFullSeed();
    const second = await resolveDemoSeed();

    // Stable public ids across runs → the demo user + org were upserted, not re-created.
    expect(second.user?.public_id).toBe(first.user?.public_id);
    expect(second.organization?.public_id).toBe(first.organization?.public_id);

    const database = getRequestDatabase();
    const [membershipCount] = await database
      .select({ total: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.user_id, first.user!.id),
          eq(memberships.organization_id, first.organization!.id),
          isNull(memberships.deleted_at),
        ),
      );
    // Exactly one active demo membership — the second seed run did not duplicate it.
    expect(membershipCount?.total).toBe(1);
  });
});
