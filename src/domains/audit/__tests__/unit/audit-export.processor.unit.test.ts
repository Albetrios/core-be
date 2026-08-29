import { gunzipSync } from 'node:zlib';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandWorkerContextDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import type { PostgresDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import {
  AUDIT_EXPORT_MANIFEST_FILENAME,
  AUDIT_EXPORT_SCHEMA_VERSION,
  type AuditExportManifest,
} from '@/domains/audit/workers/audit-export.constants.js';

/**
 * Mutable env stand-in. `runAuditExportJob` reads `env.*` at call time (the prefix is resolved
 * per invocation), so flipping fields between tests is enough — no module reset needed.
 */
const environmentMock = vi.hoisted(() => ({
  AUDIT_EXPORT_ENABLED: true,
  S3_BUCKET: 'audit-export-test-bucket' as string | undefined,
  AUDIT_EXPORT_S3_PREFIX: 'audit/export/',
  AUDIT_EXPORT_BATCH_SIZE: 2,
}));

vi.mock('@/shared/config/env.config.js', () => ({ env: environmentMock }));

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: { selectDistinct: vi.fn(), select: vi.fn() },
}));

const headObjectMock = vi.hoisted(() => vi.fn());
const putObjectBufferMock = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/storage/storage.service.js', () => ({
  headObject: (...args: unknown[]) => headObjectMock(...args),
  putObjectBuffer: (...args: unknown[]) => putObjectBufferMock(...args),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface AuditRowFixture {
  id: number;
  organization_id: number;
  actor_user_id: number | null;
  action: string;
  resource_type: string;
  resource_id: number | null;
  severity: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function buildAuditRow(id: number, organizationId: number): AuditRowFixture {
  return {
    id,
    organization_id: organizationId,
    actor_user_id: 7,
    action: 'user.login',
    resource_type: 'user',
    resource_id: null,
    severity: 'INFO',
    metadata: { source: 'audit-export.unit' },
    created_at: new Date('2024-05-01T12:00:00.000Z'),
  };
}

interface PutObjectCall {
  key: string;
  body: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}

interface FakeDatabaseHandle {
  selectDistinct: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  /** How many keyset batch queries the processor issued. */
  batchQueryCount: () => number;
  /** Every `limit(n)` argument, in call order — proves batching stays bounded. */
  requestedLimits: () => number[];
}

/**
 * Fake Drizzle handle. `selectDistinct` yields the tenant discovery rows; `select` yields the
 * keyset batches in the order the caller supplies them, so a test states exactly how the
 * processor's `while (true)` loop should unfold (a short batch, or an empty one, ends it).
 */
function buildDatabaseHandle(options: {
  organizationIds: number[];
  batches: AuditRowFixture[][];
}): FakeDatabaseHandle {
  const remainingBatches = [...options.batches];
  const requestedLimits: number[] = [];

  const selectDistinct = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () =>
        options.organizationIds.map((organization_id) => ({ organization_id })),
      ),
    })),
  }));

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(async (limit: number) => {
            requestedLimits.push(limit);
            return remainingBatches.shift() ?? [];
          }),
        })),
      })),
    })),
  }));

  return {
    selectDistinct,
    select,
    batchQueryCount: () => requestedLimits.length,
    requestedLimits: () => requestedLimits,
  };
}

function asWorkerHandle(handle: FakeDatabaseHandle) {
  return brandWorkerContextDatabaseHandle(handle as unknown as PostgresDatabaseHandle);
}

function putCalls(): PutObjectCall[] {
  return putObjectBufferMock.mock.calls.map(([argument]) => argument as PutObjectCall);
}

function manifestCall(): PutObjectCall | undefined {
  return putCalls().find((call) => call.key.endsWith(AUDIT_EXPORT_MANIFEST_FILENAME));
}

function partCalls(): PutObjectCall[] {
  return putCalls().filter((call) => !call.key.endsWith(AUDIT_EXPORT_MANIFEST_FILENAME));
}

describe('audit-export.processor', () => {
  let runAuditExportJob: typeof import('@/domains/audit/workers/audit-export.processor.js').runAuditExportJob;

  beforeAll(async () => {
    ({ runAuditExportJob } = await import('@/domains/audit/workers/audit-export.processor.js'));
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    environmentMock.AUDIT_EXPORT_ENABLED = true;
    environmentMock.S3_BUCKET = 'audit-export-test-bucket';
    environmentMock.AUDIT_EXPORT_S3_PREFIX = 'audit/export/';
    environmentMock.AUDIT_EXPORT_BATCH_SIZE = 2;
    // Default: nothing has been exported yet for this organization+date.
    headObjectMock.mockResolvedValue(null);
    putObjectBufferMock.mockResolvedValue(undefined);
  });

  it('skips when export is disabled', async () => {
    environmentMock.AUDIT_EXPORT_ENABLED = false;
    const databaseHandle = buildDatabaseHandle({ organizationIds: [], batches: [] });

    const result = await runAuditExportJob(asWorkerHandle(databaseHandle));

    expect(result).toEqual({ exportedOrganizations: 0, skipped: 0 });
    expect(databaseHandle.selectDistinct).not.toHaveBeenCalled();
    expect(putObjectBufferMock).not.toHaveBeenCalled();
  });

  /**
   * The manifest is the contract a restore path reads before touching a single part file. If the
   * version literal silently drifts (or is dropped), every consumer pinned to `"1"` breaks at read
   * time, long after the export ran. Nothing pinned its shape before this case.
   */
  it('writes a manifest carrying AUDIT_EXPORT_SCHEMA_VERSION, the export date, and the organization id', async () => {
    const databaseHandle = buildDatabaseHandle({
      organizationIds: [42],
      batches: [[buildAuditRow(1, 42)]],
    });

    await runAuditExportJob(asWorkerHandle(databaseHandle));

    const manifest = manifestCall();
    expect(manifest).toBeDefined();
    const parsed = JSON.parse(manifest!.body.toString('utf8')) as AuditExportManifest;
    expect(parsed.schema_version).toBe(AUDIT_EXPORT_SCHEMA_VERSION);
    expect(parsed.organization_id).toBe(42);
    // The window is the previous UTC calendar day, so the label is always a bare ISO date.
    expect(parsed.export_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest!.contentType).toBe('application/json');
  });

  /**
   * The manifest filename is the idempotency key: the processor `headObject`s exactly this name
   * to decide whether a tenant+day is already done. A rename on the write side without the read
   * side would silently re-export every day forever.
   */
  it('names the manifest AUDIT_EXPORT_MANIFEST_FILENAME and probes that same key first', async () => {
    const databaseHandle = buildDatabaseHandle({
      organizationIds: [42],
      batches: [[buildAuditRow(1, 42)]],
    });

    await runAuditExportJob(asWorkerHandle(databaseHandle));

    const probedKey = headObjectMock.mock.calls[0]?.[0] as string;
    expect(probedKey.endsWith(`/${AUDIT_EXPORT_MANIFEST_FILENAME}`)).toBe(true);
    expect(manifestCall()?.key).toBe(probedKey);
  });

  /**
   * The Hive-style layout (`organization_id=`/`dt=`) is what gives Athena partition pruning and
   * makes a per-tenant retention delete a prefix delete. A flattened key would still upload
   * fine and quietly break both.
   */
  it('writes part objects under the partitioned organization/date key convention', async () => {
    const databaseHandle = buildDatabaseHandle({
      organizationIds: [42],
      batches: [[buildAuditRow(1, 42)]],
    });

    await runAuditExportJob(asWorkerHandle(databaseHandle));

    const [part] = partCalls();
    expect(part).toBeDefined();
    // The trailing slash on AUDIT_EXPORT_S3_PREFIX is normalized away, not doubled.
    expect(part!.key).toMatch(
      /^audit\/export\/organization_id=42\/dt=\d{4}-\d{2}-\d{2}\/part-[0-9a-f-]{36}\.jsonl\.gz$/,
    );
    expect(part!.contentType).toBe('application/gzip');
    expect(manifestCall()!.key).toMatch(
      /^audit\/export\/organization_id=42\/dt=\d{4}-\d{2}-\d{2}\/manifest\.json$/,
    );
  });

  /**
   * A tenant discovered by `selectDistinct` but returning no rows in the window (e.g. every row
   * purged by retention between the two queries) is counted as `skipped` and writes NOTHING —
   * not an empty manifest. This is deliberate: the manifest doubles as the "already done" marker,
   * so writing an empty one would permanently suppress a legitimate re-run for that day.
   */
  it('writes no manifest for a tenant with zero rows in the window and counts it as skipped', async () => {
    const databaseHandle = buildDatabaseHandle({ organizationIds: [42], batches: [[]] });

    const result = await runAuditExportJob(asWorkerHandle(databaseHandle));

    expect(result).toEqual({ exportedOrganizations: 0, skipped: 1 });
    expect(putObjectBufferMock).not.toHaveBeenCalled();
  });

  /**
   * A part upload that rejects must propagate so BullMQ retries the job. The dangerous failure
   * mode is the opposite: swallowing the error, writing the manifest anyway, and permanently
   * marking an incomplete day as exported. Asserts both halves — the throw, and no manifest.
   */
  it('rethrows a failed part upload and does not write the manifest', async () => {
    const databaseHandle = buildDatabaseHandle({
      organizationIds: [42],
      batches: [[buildAuditRow(1, 42)]],
    });
    putObjectBufferMock.mockRejectedValueOnce(new Error('s3-put-failed'));

    await expect(runAuditExportJob(asWorkerHandle(databaseHandle))).rejects.toThrow(
      's3-put-failed',
    );

    expect(manifestCall()).toBeUndefined();
  });

  /**
   * The manifest's `row_count` / `sha256` are what a consumer verifies a part against without
   * re-downloading it. Decompress the uploaded body and check the manifest describes the bytes
   * that were actually written, not what the processor intended to write.
   */
  it('records per-part row_count and sha256 in the manifest that match the uploaded bytes', async () => {
    const rows = [buildAuditRow(1, 42), buildAuditRow(2, 42), buildAuditRow(3, 42)];
    const databaseHandle = buildDatabaseHandle({
      organizationIds: [42],
      batches: [rows.slice(0, 2), rows.slice(2)],
    });

    await runAuditExportJob(asWorkerHandle(databaseHandle));

    const parsed = JSON.parse(manifestCall()!.body.toString('utf8')) as AuditExportManifest;
    const parts = partCalls();
    expect(parsed.objects).toHaveLength(parts.length);
    expect(parsed.objects.reduce((total, object) => total + object.row_count, 0)).toBe(rows.length);

    for (const [index, object] of parsed.objects.entries()) {
      const part = parts[index]!;
      expect(object.key).toBe(part.key);
      expect(object.format).toBe('ndjson');
      expect(object.content_type).toBe('application/gzip');
      // NDJSON: one JSON object per line, trailing newline on every line.
      const lines = gunzipSync(part.body).toString('utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(object.row_count);
      expect((JSON.parse(lines[0]!) as { id: number }).id).toBeGreaterThan(0);
      // The object metadata a consumer reads from S3 HEAD must agree with the manifest.
      expect(part.metadata?.sha256).toBe(object.sha256);
      expect(part.metadata?.row_count).toBe(String(object.row_count));
      expect(part.metadata?.schema_version).toBe(AUDIT_EXPORT_SCHEMA_VERSION);
    }
  });

  /**
   * Every keyset query is capped at AUDIT_EXPORT_BATCH_SIZE — the whole point of streaming a
   * ledger table rather than selecting it. A regression to an unbounded select would still pass
   * every other case here while OOM-ing on a real tenant's day.
   */
  it('bounds every keyset query at AUDIT_EXPORT_BATCH_SIZE and stops on a short batch', async () => {
    const rows = [1, 2, 3, 4, 5].map((id) => buildAuditRow(id, 42));
    const databaseHandle = buildDatabaseHandle({
      organizationIds: [42],
      batches: [rows.slice(0, 2), rows.slice(2, 4), rows.slice(4)],
    });

    await runAuditExportJob(asWorkerHandle(databaseHandle));

    expect(databaseHandle.requestedLimits()).toEqual([2, 2, 2]);
    // The third batch was short (1 < 2), so the loop stopped without a fourth probe.
    expect(databaseHandle.batchQueryCount()).toBe(3);
    expect(partCalls()).toHaveLength(3);
  });

  /**
   * Idempotency by manifest: a re-run over an already-exported organization+date must not re-read the
   * ledger or re-upload a byte. The scheduler retries this job, so a non-idempotent run would
   * duplicate a full day of data in S3 on every retry.
   */
  it('is idempotent — an existing manifest skips the tenant without reading rows or uploading', async () => {
    const databaseHandle = buildDatabaseHandle({
      organizationIds: [42],
      batches: [[buildAuditRow(1, 42)]],
    });
    headObjectMock.mockResolvedValue({ ContentLength: 128 });

    const result = await runAuditExportJob(asWorkerHandle(databaseHandle));

    expect(result).toEqual({ exportedOrganizations: 0, skipped: 1 });
    expect(databaseHandle.batchQueryCount()).toBe(0);
    expect(putObjectBufferMock).not.toHaveBeenCalled();
  });
});
