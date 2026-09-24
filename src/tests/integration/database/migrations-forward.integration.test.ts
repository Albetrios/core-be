import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from '@/infrastructure/database/connection.js';
import { execSync } from 'node:child_process';

/**
 * Verifies all SQL migrations in migrations/ are applied to the test database.
 * CI runs `pnpm db:migrate` before tests; local dev should run migrate after compose:up.
 */
// Skipped under `pnpm test:rls-role`: this suite reads `public.schema_migrations`, the migrator's ledger — not something the application role touches, so running it as the RLS-subject
// `core_be_app` would assert nothing about whether the application obeys RLS.
const runAsApplicationBehaviour = !process.env.TEST_DATABASE_ROLE;

describe.runIf(runAsApplicationBehaviour)('Integration: migrations forward', () => {
  it('should have every migrations/*.sql file recorded in schema_migrations', async () => {
    const migrationsFolder = resolve(process.cwd(), 'migrations');
    const allFiles = (await readdir(migrationsFolder))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const applied = await sql<{ filename: string }[]>`
      SELECT filename FROM public.schema_migrations ORDER BY filename ASC
    `;
    if (applied.length === 0) {
      console.warn(
        'Skipping migration file parity check: schema_migrations is empty. Run pnpm db:migrate (CI applies migrations before tests).',
      );
      return;
    }
    const appliedSet = new Set(applied.map((row) => row.filename));

    const missing = allFiles.filter((filename) => !appliedSet.has(filename));
    expect(missing, `Run pnpm db:migrate — pending: ${missing.join(', ')}`).toEqual([]);
  });

  it('should pass static migration lint', () => {
    execSync('pnpm db:migrate:lint', { stdio: 'pipe', encoding: 'utf-8' });
  });
});
