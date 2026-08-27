import { describe, expect, it, vi } from 'vitest';
import {
  createPrincipalDatabaseScope,
  MAINTENANCE_SCOPE,
  withDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { createSessionDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';

const executedStatements: string[] = [];
const executeMock = vi.fn(async (statement: unknown) => {
  executedStatements.push(JSON.stringify((statement as { queryChunks?: unknown[] })?.queryChunks));
  return undefined;
});
const transactionHandle = { execute: executeMock };

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: {
    transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback(transactionHandle),
    ),
  },
}));

/**
 * The ONE common dispatcher must route every scope shape to its pattern wrapper —
 * this is behavioral coverage for the entry point the architecture documents as
 * the standard (`withDatabaseContext(scope, cb)`), so it can never rot into
 * dead-but-documented API.
 */
describe('withDatabaseContext dispatcher', () => {
  it('routes a principal scope to the principal wrapper (identity GUC set)', async () => {
    executedStatements.length = 0;
    const scope = createPrincipalDatabaseScope({
      organizationPublicId: 'org_dispatch_test0001',
      source: 'token',
    });
    await withDatabaseContext(scope, async () => undefined);
    expect(executedStatements.join(' ')).toContain('app.current_organization_public_id');
  });

  it('routes a maintenance scope to the maintenance wrapper (bypass GUC set)', async () => {
    executedStatements.length = 0;
    await withDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, async () => undefined);
    expect(executedStatements.join(' ')).toContain('app.global_retention_cleanup');
  });

  it('routes a session scope to the session wrapper (session GUC set)', async () => {
    executedStatements.length = 0;
    const scope = createSessionDatabaseScope('public_id', 'ses_dispatch_test0001');
    await withDatabaseContext(scope, async () => undefined);
    expect(executedStatements.join(' ')).toContain('app.current_session_public_id');
  });
});
