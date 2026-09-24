import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/**
 * Every per-organization cap in this codebase is enforced the same way: take the advisory
 * quota lock, `count(...)`, compare against the cap, then insert — all inside one transaction
 * (`resource-quota-lock.util.ts`). The whole point of the lock is that `count` and `insert`
 * cannot interleave; without it, N concurrent creates all read the same pre-insert count and
 * every one of them decides it is under the cap.
 *
 * That invariant has never been attacked concurrently at the database level. These tests do
 * that directly against the lock primitive and the table it guards, because a cap that only
 * holds when requests arrive one at a time is not a cap — and a caller who can overshoot an
 * API-key or seat cap has escaped a billing and a blast-radius control at once.
 *
 * Run as the privileged harness role; the concern here is serialization, not RLS.
 */

const API_KEY_CAP = 25;
const CONCURRENT_ATTEMPTS = 60;

async function seedOrganization(): Promise<number> {
  const seedEmail = 'quota-race@example.test';
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO auth.users (public_id, email, email_hash, is_email_verified)
    VALUES ('usr_quotaraceseeduser001', ${seedEmail}, md5(${seedEmail}), true)
    RETURNING id
  `;
  const [organization] = await sql<{ id: number }[]>`
    INSERT INTO tenancy.organizations (public_id, name, slug, owner_user_id, type)
    VALUES ('org_quotaraceseedorg00001', 'Quota Race', 'quota-race', ${user!.id}, 'TEAM')
    RETURNING id
  `;
  return Number(organization!.id);
}

/**
 * One capped create, exactly as the repositories shape it: lock, count, compare, insert.
 * Returns whether this attempt was allowed to insert.
 */
async function attemptCappedInsert(
  organizationId: number,
  attempt: number,
  options: { readonly withQuotaLock: boolean } = { withQuotaLock: true },
): Promise<boolean> {
  return sql.begin(async (transaction) => {
    if (options.withQuotaLock) {
      // ASCII `APIK` — the same namespace `organization-api-key.repository.ts` uses.
      await transaction`SELECT pg_advisory_xact_lock(${0x41_50_49_4b}, ${organizationId})`;
    }
    const [row] = await transaction<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tenancy.api_keys
      WHERE organization_id = ${organizationId} AND deleted_at IS NULL
    `;
    if (Number(row!.count) >= API_KEY_CAP) return false;
    await transaction`
      INSERT INTO tenancy.api_keys
        (public_id, organization_id, name, key_hash, key_prefix, scopes, created_by_user_id)
      VALUES (
        ${`key_quotarace${String(attempt).padStart(11, '0')}`},
        ${organizationId}, ${`race-${attempt}`}, ${`hash-${attempt}`}, ${'pk_test'},
        '[]'::jsonb,
        (SELECT owner_user_id FROM tenancy.organizations WHERE id = ${organizationId})
      )
    `;
    return true;
  });
}

describe('Security: per-organization resource caps under concurrency', () => {
  let organizationId: number;

  beforeAll(async () => {
    await cleanupDatabase();
    organizationId = await seedOrganization();
  });

  it(`holds the cap at ${API_KEY_CAP} against ${CONCURRENT_ATTEMPTS} simultaneous creates`, async () => {
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, (_, attempt) =>
        attemptCappedInsert(organizationId, attempt),
      ),
    );

    const inserted = outcomes.filter(Boolean).length;
    const [stored] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tenancy.api_keys
      WHERE organization_id = ${organizationId} AND deleted_at IS NULL
    `;

    // Overshoot here is the interesting failure: it would mean the advisory lock is not
    // serializing count-then-insert, and every cap built on this primitive — API keys, seats,
    // roles, webhooks, sessions — leaks under load rather than under attack.
    expect(Number(stored!.count)).toBe(API_KEY_CAP);
    expect(inserted).toBe(API_KEY_CAP);
    // And the excess must be refused, not silently dropped or errored into a retry storm.
    expect(outcomes.filter((allowed) => !allowed)).toHaveLength(CONCURRENT_ATTEMPTS - API_KEY_CAP);
  });

  it('overshoots the cap once the lock is removed — proving the lock is what holds it', async () => {
    // A control, not a regression test. The assertion above is only meaningful if the same
    // shape FAILS without the lock; otherwise it would pass on a codebase with no locking at
    // all and quietly certify nothing. Postgres's default READ COMMITTED lets every one of
    // these transactions read the same pre-insert count, so each concludes it is under the cap.
    const [freshOrganizationId] = await sql<{ id: number }[]>`
      INSERT INTO tenancy.organizations (public_id, name, slug, owner_user_id, type)
      VALUES ('org_quotaraceunlocked001', 'Unlocked', 'quota-race-unlocked',
              (SELECT owner_user_id FROM tenancy.organizations WHERE id = ${organizationId}), 'TEAM')
      RETURNING id
    `;

    await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, (_, attempt) =>
        attemptCappedInsert(Number(freshOrganizationId!.id), 5_000 + attempt, {
          withQuotaLock: false,
        }),
      ),
    );

    const [stored] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tenancy.api_keys
      WHERE organization_id = ${Number(freshOrganizationId!.id)} AND deleted_at IS NULL
    `;
    expect(Number(stored!.count)).toBeGreaterThan(API_KEY_CAP);
  });

  it('serializes a second concurrent wave against the already-full cap', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, attempt) =>
        attemptCappedInsert(organizationId, 1_000 + attempt),
      ),
    );

    // Already at the cap, so every attempt must be refused — no gap opens up because the
    // first wave's transactions have committed and released their locks.
    expect(outcomes.some(Boolean)).toBe(false);
    const [stored] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tenancy.api_keys
      WHERE organization_id = ${organizationId} AND deleted_at IS NULL
    `;
    expect(Number(stored!.count)).toBe(API_KEY_CAP);
  });
});
