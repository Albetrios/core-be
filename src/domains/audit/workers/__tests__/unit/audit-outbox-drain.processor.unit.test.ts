import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';

const drainRepositoryMock = vi.hoisted(() => ({
  claimPendingBatch: vi.fn(),
  markProcessed: vi.fn().mockResolvedValue(undefined),
  recordTransientFailure: vi.fn().mockResolvedValue(undefined),
  markPermanentlyFailed: vi.fn().mockResolvedValue(undefined),
  getPendingBacklogStats: vi
    .fn()
    .mockResolvedValue({ pendingCount: 0, oldestPendingAgeSeconds: 0, maxAttemptCount: 0 }),
}));

vi.mock('@/domains/audit/audit-outbox.repository.js', () => ({
  createDrainAuditOutboxRepository: vi.fn(() => drainRepositoryMock),
}));

const setLocalDatabaseConfigMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      setLocalDatabaseConfig: (...args: unknown[]) => setLocalDatabaseConfigMock(...args),
    };
  },
);

interface FakeDatabaseHandle {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  /**
   * sec-r7/M2: the per-row audit.logs INSERT runs in a nested transaction (a SAVEPOINT). The fake
   * mirrors drizzle: it runs the callback and re-throws on failure (drizzle rolls the savepoint
   * back then re-throws), so `drainOutboxRow`'s catch records the failure on the still-valid batch.
   */
  transaction: ReturnType<typeof vi.fn>;
}

function buildDatabaseHandle(
  userIdByPublicId: Record<string, number>,
  orgIdByPublicId: Record<string, number>,
  apiKeyIdByPublicId: Record<string, number>,
  insertOverride?: (row: Record<string, unknown>) => Promise<void>,
): FakeDatabaseHandle {
  const userRows = Object.entries(userIdByPublicId).map(([public_id, id]) => ({ id, public_id }));
  const orgRows = Object.entries(orgIdByPublicId).map(([public_id, id]) => ({ id, public_id }));
  const apiKeyRows = Object.entries(apiKeyIdByPublicId).map(([public_id, id]) => ({
    id,
    public_id,
  }));

  // Route resolution SELECTs by the queried TABLE, not by call order: `buildResolutionMaps`
  // SKIPS a table's SELECT when the batch references no id of that kind (e.g. an API-key-only
  // actor has no user public id), so a positional response array would misalign the moment a
  // table is skipped. Table identity keeps every actor/target/org/api-key combination correct.
  const rowsByTable = new Map<unknown, Array<{ id: number; public_id: string }>>([
    [users, userRows],
    [organizations, orgRows],
    [api_keys, apiKeyRows],
  ]);

  const select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation((table: unknown) => ({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      where: vi
        .fn()
        .mockImplementation(async (_predicate: unknown) => rowsByTable.get(table) ?? []),
    })),
  }));

  const insert = vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation(async (row: Record<string, unknown>) => {
      if (insertOverride) return insertOverride(row);
      return undefined;
    }),
  }));

  // execute() serves both the per-row GUC set_config statements (return undefined)
  // and the two SECURITY DEFINER resolver calls (org / api-key id lookup) — the
  // resolver SQL is routed by function name and answered from the same fixtures
  // the table-routed selects use.
  const execute = vi.fn().mockImplementation(async (statement: unknown) => {
    const text = JSON.stringify(
      (statement as { queryChunks?: unknown[] })?.queryChunks ?? statement ?? '',
    );
    if (text.includes('resolve_organization_ids_for_public_ids')) return { rows: orgRows };
    if (text.includes('resolve_api_key_ids_for_public_ids')) return { rows: apiKeyRows };
    return undefined;
  });

  const handle = { select, insert, execute } as FakeDatabaseHandle;
  // Nested transaction (SAVEPOINT): run the callback with the same handle so its insert hits the
  // override; on failure the callback rejects and `transaction` re-throws (like drizzle's savepoint
  // rollback + rethrow), exercising `drainOutboxRow`'s catch on the still-valid outer transaction.
  handle.transaction = vi.fn(async (callback: (sp: FakeDatabaseHandle) => Promise<unknown>) =>
    callback(handle),
  );
  return handle;
}

interface OutboxRowOverride {
  id?: number;
  action?: string;
  actor_user_public_id?: string | null;
  actor_api_key_public_id?: string | null;
  target_user_public_id?: string | null;
  organization_public_id?: string | null;
  attempt_count?: number;
}

function buildOutboxRow(overrides: OutboxRowOverride = {}): Record<string, unknown> {
  // `??` collapses `null` to the default, which is the wrong semantics here — `null`
  // is a meaningful explicit value for the optional public_id columns (tenantless rows,
  // user-only audits without an organization, etc.). Use a `hasOwnProperty`-style check
  // so the caller can distinguish "use default" (omit the key) from "this field is null".
  const pickNullable = <K extends keyof OutboxRowOverride>(
    key: K,
    fallback: NonNullable<OutboxRowOverride[K]> | null,
  ): OutboxRowOverride[K] | null => (key in overrides ? (overrides[key] ?? null) : fallback);

  return {
    id: overrides.id ?? 1,
    status: 'PENDING',
    actor_user_public_id: pickNullable('actor_user_public_id', 'user_a'),
    actor_api_key_public_id: pickNullable('actor_api_key_public_id', null),
    target_user_public_id: pickNullable('target_user_public_id', null),
    organization_public_id: pickNullable('organization_public_id', 'org_a'),
    action: overrides.action ?? 'user.login',
    resource_type: 'user',
    resource_id: null,
    ip_address: '203.0.113.1',
    user_agent: 'test/1.0',
    severity: 'INFO',
    metadata: {},
    attempt_count: overrides.attempt_count ?? 1,
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    processed_at: null,
  };
}

describe('runAuditOutboxDrainJob', () => {
  let runAuditOutboxDrainJob: typeof import('@/domains/audit/workers/audit-outbox-drain.processor.js').runAuditOutboxDrainJob;

  beforeAll(async () => {
    ({ runAuditOutboxDrainJob } = await import(
      '@/domains/audit/workers/audit-outbox-drain.processor.js'
    ));
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zero counts and writes nothing when no PENDING rows exist', async () => {
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([]);
    const databaseHandle = buildDatabaseHandle({}, {}, {});

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 0, transientFailed: 0, permanentlyFailed: 0 });
    expect(setLocalDatabaseConfigMock).not.toHaveBeenCalled();
    expect(databaseHandle.insert).not.toHaveBeenCalled();
  });

  it('drains a tenant row: resolves public ids, sets per-row org GUC, inserts audit.logs, marks PROCESSED', async () => {
    const row = buildOutboxRow({
      id: 100,
      actor_user_public_id: 'user_a',
      organization_public_id: 'org_a',
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    const databaseHandle = buildDatabaseHandle({ user_a: 5 }, { org_a: 10 }, {});

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 1, transientFailed: 0, permanentlyFailed: 0 });
    // First setLocalDatabaseConfig is the global-admin lift for resolution.
    expect(setLocalDatabaseConfigMock).toHaveBeenNthCalledWith(
      1,
      databaseHandle,
      'app.global_admin',
      'true',
    );
    // Per-row org GUC for the audit.logs INSERT RLS.
    expect(setLocalDatabaseConfigMock).toHaveBeenNthCalledWith(
      2,
      databaseHandle,
      'app.current_organization_public_id',
      'org_a',
    );
    // …and the system arm is explicitly turned OFF for a tenanted row. Savepoints do NOT restore
    // settings on RELEASE, so leaving it unset would inherit `'true'` from any earlier tenantless
    // row in the same batch and widen `audit_logs_tenant_isolation_insert` for the remainder.
    expect(setLocalDatabaseConfigMock).toHaveBeenNthCalledWith(
      3,
      databaseHandle,
      'app.system_audit_insert',
      'false',
    );
    expect(databaseHandle.insert).toHaveBeenCalledTimes(1);
    expect(drainRepositoryMock.markProcessed).toHaveBeenCalledExactlyOnceWith([100]);
  });

  it('drains a tenantless row using the system_audit_insert arm', async () => {
    const row = buildOutboxRow({
      id: 101,
      actor_user_public_id: 'user_a',
      organization_public_id: null,
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    const databaseHandle = buildDatabaseHandle({ user_a: 5 }, {}, {});

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result.drained).toBe(1);
    expect(setLocalDatabaseConfigMock).toHaveBeenCalledWith(
      databaseHandle,
      'app.system_audit_insert',
      'true',
    );
    // Both identity GUCs are written on EVERY row, never just the one this row needs:
    // `RELEASE SAVEPOINT` keeps whatever the savepoint set, so a one-GUC-per-branch loop
    // inherits the previous row's value and widens the insert policy for the rest of the batch.
    expect(setLocalDatabaseConfigMock).toHaveBeenCalledWith(
      databaseHandle,
      'app.current_organization_public_id',
      '',
    );
  });

  it('marks a row permanently FAILED when the actor public_id no longer resolves', async () => {
    const row = buildOutboxRow({
      id: 102,
      actor_user_public_id: 'user_deleted',
      organization_public_id: 'org_a',
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    const databaseHandle = buildDatabaseHandle({}, { org_a: 10 }, {});

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 0, transientFailed: 0, permanentlyFailed: 1 });
    expect(drainRepositoryMock.markPermanentlyFailed).toHaveBeenCalledExactlyOnceWith(
      102,
      expect.stringMatching(/actor public_id did not resolve/),
    );
    expect(databaseHandle.insert).not.toHaveBeenCalled();
  });

  it('marks a row permanently FAILED when the organization public_id no longer resolves', async () => {
    // The actor resolves but the organization was hard-deleted between the outbox insert and
    // the drain. This is the SIBLING of the actor-unresolvable branch (processor `resolveRowInserts`
    // org guard) — a tenant deleted mid-flight must produce a terminal FAILED row for triage, never
    // a silently-dropped audit or a wedged queue head.
    const row = buildOutboxRow({
      id: 105,
      actor_user_public_id: 'user_a',
      organization_public_id: 'org_gone',
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    // user_a resolves; org_gone does not (empty org map).
    const databaseHandle = buildDatabaseHandle({ user_a: 5 }, {}, {});

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 0, transientFailed: 0, permanentlyFailed: 1 });
    expect(drainRepositoryMock.markPermanentlyFailed).toHaveBeenCalledExactlyOnceWith(
      105,
      expect.stringMatching(/organization_public_id org_gone did not resolve/),
    );
    expect(databaseHandle.insert).not.toHaveBeenCalled();
  });

  it('drains a row attributed to an API-key actor: resolves the api-key id, inserts actor_api_key_id / null user', async () => {
    // The whole `actor_api_key_public_id` column exists so key-attributed actions stay auditable.
    // Every other drain test uses a USER actor; this exercises the api-key resolution branch — a
    // regression there would mark every API-key-attributed audit as "actor public_id did not
    // resolve" → permanently FAILED, silently losing that class of audit.
    const row = buildOutboxRow({
      id: 106,
      actor_user_public_id: null,
      actor_api_key_public_id: 'key_a',
      organization_public_id: 'org_a',
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    let insertedRow: Record<string, unknown> | undefined;
    const databaseHandle = buildDatabaseHandle({}, { org_a: 10 }, { key_a: 77 }, async (values) => {
      insertedRow = values;
    });

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 1, transientFailed: 0, permanentlyFailed: 0 });
    expect(insertedRow?.actor_api_key_id).toBe(77);
    expect(insertedRow?.actor_user_id).toBeNull();
    expect(drainRepositoryMock.markProcessed).toHaveBeenCalledExactlyOnceWith([106]);
  });

  it('records a TRANSIENT failure on first DB error and KEEPS the row PENDING for retry', async () => {
    const row = buildOutboxRow({
      id: 103,
      actor_user_public_id: 'user_a',
      organization_public_id: 'org_a',
      attempt_count: 1,
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    const databaseHandle = buildDatabaseHandle({ user_a: 5 }, { org_a: 10 }, {}, async () => {
      throw new Error('rls-rejected');
    });

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 0, transientFailed: 1, permanentlyFailed: 0 });
    expect(drainRepositoryMock.recordTransientFailure).toHaveBeenCalledExactlyOnceWith(
      103,
      'rls-rejected',
    );
    expect(drainRepositoryMock.markPermanentlyFailed).not.toHaveBeenCalled();
  });

  it('escalates to permanently FAILED when attempt_count would exceed the cap', async () => {
    // attempt_count 4 → on this drain pass it becomes 5 (the default max), so any
    // failure must mark the row terminally instead of transient.
    const row = buildOutboxRow({
      id: 104,
      actor_user_public_id: 'user_a',
      organization_public_id: 'org_a',
      attempt_count: 4,
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    const databaseHandle = buildDatabaseHandle({ user_a: 5 }, { org_a: 10 }, {}, async () => {
      throw new Error('rls-rejected');
    });

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 0, transientFailed: 0, permanentlyFailed: 1 });
    expect(drainRepositoryMock.markPermanentlyFailed).toHaveBeenCalledExactlyOnceWith(
      104,
      'rls-rejected',
    );
    expect(drainRepositoryMock.recordTransientFailure).not.toHaveBeenCalled();
  });

  it('sec-r7/M2: a poison row is isolated by SAVEPOINT and does NOT roll back the rest of the batch', async () => {
    // One row's audit.logs INSERT errors; the other is healthy. Without the per-row SAVEPOINT the
    // failed INSERT would abort the whole batch transaction, the failure-mark UPDATE would itself
    // throw, the job would propagate the error, and the claim's attempt_count bump (plus the good
    // row's insert) would roll back — re-heading the poison row forever. With the savepoint, the
    // poison row is rolled back to its savepoint, marked transient, and the good row still PROCESSES.
    const poison = buildOutboxRow({
      id: 200,
      action: 'poison.action',
      actor_user_public_id: 'user_a',
      organization_public_id: 'org_a',
      attempt_count: 1,
    });
    const healthy = buildOutboxRow({
      id: 201,
      action: 'user.login',
      actor_user_public_id: 'user_a',
      organization_public_id: 'org_a',
      attempt_count: 1,
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([poison, healthy]);
    const databaseHandle = buildDatabaseHandle({ user_a: 5 }, { org_a: 10 }, {}, async (row) => {
      if (row.action === 'poison.action') throw new Error('constraint-violation');
      return undefined;
    });

    // The job RETURNS a result (does not throw) — the poison row did not wedge the batch.
    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 1, transientFailed: 1, permanentlyFailed: 0 });
    // The healthy row committed (PROCESSED); the poison row was kept PENDING for a bounded retry.
    expect(drainRepositoryMock.markProcessed).toHaveBeenCalledExactlyOnceWith([201]);
    expect(drainRepositoryMock.recordTransientFailure).toHaveBeenCalledExactlyOnceWith(
      200,
      'constraint-violation',
    );
    // Each row's INSERT ran in its own nested transaction (savepoint): one per row.
    expect(databaseHandle.transaction).toHaveBeenCalledTimes(2);
  });

  it('sec-r7/M2: checks the PENDING backlog after a drain pass (stall telemetry)', async () => {
    // The backstop runs after a non-empty pass: a leftover poison/transient row that stays
    // PENDING surfaces as a non-zero oldest-age so an operator can be paged.
    const row = buildOutboxRow({
      id: 300,
      action: 'poison.action',
      actor_user_public_id: 'user_a',
      organization_public_id: 'org_a',
      attempt_count: 1,
    });
    drainRepositoryMock.claimPendingBatch.mockResolvedValueOnce([row]);
    drainRepositoryMock.getPendingBacklogStats.mockResolvedValueOnce({
      pendingCount: 1,
      oldestPendingAgeSeconds: 60 * 60, // 1h — well past the 15-min warn threshold
      maxAttemptCount: 1,
    });
    const databaseHandle = buildDatabaseHandle(
      { user_a: 5 },
      { org_a: 10 },
      {},
      async (insertRow) => {
        if (insertRow.action === 'poison.action') throw new Error('constraint-violation');
        return undefined;
      },
    );

    const result = await runAuditOutboxDrainJob(databaseHandle as never);

    expect(result).toEqual({ drained: 0, transientFailed: 1, permanentlyFailed: 0 });
    expect(drainRepositoryMock.getPendingBacklogStats).toHaveBeenCalled();
  });
});
