/**
 * Load-test credential pool generator.
 *
 * Run AFTER `pnpm db:seed:bulk` (or via `pnpm db:seed:loadtest` which chains both).
 * Does two things:
 *   1. Stamps a single Argon2id hash onto every `bulk-user-*@seed.local` user that has
 *      no password yet — one hash computation, one bulk UPDATE — so they become loginable
 *      via POST /api/v1/auth/login without touching any other seed logic.
 *   2. Joins users → memberships → organizations to export
 *      `src/tests/load/k6/data/credential-pool.json`, one entry per active bulk membership.
 *      k6 scenarios index into this pool by `__VU` so each VU authenticates as a distinct user.
 *
 * Env knobs:
 *   LOAD_TEST_PASSWORD  — plaintext password stamped on bulk users (default: LoadTest123!)
 *
 * Usage:
 *   pnpm tool:load-test-credential-pool      (after bulk seed exists)
 *   pnpm db:seed:loadtest                    (runs bulk seed then this script)
 */
import '@/shared/config/load-env-files.js';
import '@/scripts/seed/seed-runtime-url.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { closeDatabase } from '@/infrastructure/database/connection.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { hashPassword } from '@/shared/utils/security/password.util.js';
import { assertBulkSeedAllowed } from '@/scripts/seed/production-guard.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const BULK_EMAIL_PATTERN = 'bulk-user-%@seed.local';
const BULK_ORG_SLUG_PATTERN = 'bulk-organization-%';
const OUTPUT_PATH = join(process.cwd(), 'src/tests/load/k6/data/credential-pool.json');

/** One row in the exported credential pool. */
export interface CredentialPoolEntry {
  /** Deterministic bulk email; indexes the user across runs. */
  email: string;
  /** Plaintext password stamped by this script — same value for all bulk users. */
  password: string;
  /** Public id of the organization this user is an active member of (used to scope tokens). */
  organizationPublicId: string;
  /** Public id of this user (for assertions in scenario checks). */
  userPublicId: string;
}

async function run(env: NodeJS.ProcessEnv): Promise<void> {
  assertBulkSeedAllowed(env);

  const password = env.LOAD_TEST_PASSWORD ?? 'LoadTest123!';
  const database = getRequestDatabase();

  // Step 1 — stamp password_hash on bulk users that don't have one yet.
  // Compute the hash once and issue a single UPDATE to avoid N*argon2 slowness.
  logger.info('load-test-credential-pool: computing password hash (argon2id)...');
  const passwordHash = await hashPassword(password);

  const stamped = await database
    .update(users)
    .set({ password_hash: passwordHash })
    .where(and(like(users.email, BULK_EMAIL_PATTERN), isNull(users.password_hash)))
    .returning({ id: users.id });

  logger.info({ stamped: stamped.length }, 'load-test-credential-pool: password hash stamped');

  // Step 2 — build pool: one entry per active bulk-organization membership.
  // A user round-robined into multiple organizations by the bulk seeder yields multiple entries,
  // which is fine — k6 VUs that collide on the same user just share organization context rather
  // than failing.
  //
  // MFA accounts are excluded, and the two exclusions below mirror `completeFirstFactorAuth`'s
  // gate exactly (`user.is_mfa_enabled || organizationRequiresMfa`). For such an account the
  // first factor succeeds with HTTP 200 but the body is an `mfa_required` envelope carrying an
  // `mfa_session_token` instead of an `access_token` — so a k6 VU that draws one reads no token
  // and silently abandons its journey partway. That does not fail loudly; it just removes VUs
  // from every route after login, quietly understating concurrency and skewing every number in
  // the run. The bulk seeder sets `security_policy.mfa_required` on a share of its organizations,
  // so without this filter a third of the pool is unusable.
  const rows = await database
    .select({
      email: users.email,
      userPublicId: users.public_id,
      organizationPublicId: organizations.public_id,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.user_id, users.id))
    .innerJoin(organizations, eq(organizations.id, memberships.organization_id))
    .where(
      and(
        like(users.email, BULK_EMAIL_PATTERN),
        like(organizations.slug, BULK_ORG_SLUG_PATTERN),
        eq(memberships.status, 'ACTIVE'),
        isNull(memberships.deleted_at),
        eq(users.is_mfa_enabled, false),
        // Same SECURITY DEFINER resolver the login path uses, so this can never drift from it.
        sql`NOT tenancy.user_has_organization_requiring_mfa(${users.id})`,
      ),
    );

  if (rows.length === 0) {
    logger.warn(
      'load-test-credential-pool: no bulk users with active memberships found — run pnpm db:seed:bulk first',
    );
    return;
  }

  const pool: CredentialPoolEntry[] = rows.map((row) => ({
    email: row.email,
    password,
    organizationPublicId: row.organizationPublicId,
    userPublicId: row.userPublicId,
  }));

  // Step 3 — write pool JSON (gitignored; contains plaintext password).
  await mkdir(join(process.cwd(), 'src/tests/load/k6/data'), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(pool, null, 2));

  logger.info(
    { entries: pool.length, path: OUTPUT_PATH },
    'load-test-credential-pool: pool written — use helpers/pool.js in k6 scenarios for per-VU auth',
  );
}

run(process.env)
  .catch((error) => {
    logger.error({ error }, 'load-test-credential-pool: failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
