import { createHash } from 'node:crypto';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '@/infrastructure/database/connection.js';
import { logs } from '@/domains/audit/audit.schema.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  AUDIT_EXPORT_MANIFEST_FILENAME,
  type AuditExportManifest,
} from '@/domains/audit/workers/audit-export.constants.js';
import { buildManifestKey } from '@/domains/audit/workers/audit-export.processor.js';
import type * as EnvConfigModule from '@/shared/config/env.config.js';

const { headObjectMock, putObjectBufferMock } = vi.hoisted(() => ({
  headObjectMock: vi.fn(),
  putObjectBufferMock: vi.fn(),
}));

vi.mock('@/infrastructure/storage/storage.service.js', () => ({
  headObject: headObjectMock,
  putObjectBuffer: putObjectBufferMock,
}));

vi.mock('@/shared/config/env.config.js', async (importOriginal) => {
  const original = await importOriginal<typeof EnvConfigModule>();
  return {
    env: {
      ...original.env,
      AUDIT_EXPORT_ENABLED: true,
      S3_BUCKET: 'contract-test-bucket',
      AUDIT_EXPORT_S3_PREFIX: 'audit/export',
      AUDIT_EXPORT_BATCH_SIZE: 5_000,
    },
    getEnv: () => ({
      ...original.env,
      AUDIT_EXPORT_ENABLED: true,
      S3_BUCKET: 'contract-test-bucket',
      AUDIT_EXPORT_S3_PREFIX: 'audit/export',
      AUDIT_EXPORT_BATCH_SIZE: 5_000,
    }),
  };
});

function getPreviousUtcDayRange(referenceDate = new Date()): {
  start: Date;
  end: Date;
  dateLabel: string;
} {
  const end = new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
    ),
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  const dateLabel = start.toISOString().slice(0, 10);
  return { start, end, dateLabel };
}

/**
 * Verifies audit-export processor writes gzip NDJSON per organization for the previous UTC day.
 * S3 is mocked; Postgres is real (same pattern as contract tests — no Localstack in CI).
 */
describe('audit-export.worker — S3 NDJSON export', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    headObjectMock.mockResolvedValue(null);
    putObjectBufferMock.mockResolvedValue(undefined);
    await cleanupDatabase();
  });

  it('exports previous UTC day logs per organization to gzip NDJSON and manifest in S3', async () => {
    const { runAuditExportJob } = await import('@/domains/audit/workers/audit-export.processor.js');
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const { start, dateLabel } = getPreviousUtcDayRange();
    const createdAt = new Date(start.getTime() + 3_600_000);

    await database.insert(logs).values({
      organization_id: organization.id,
      actor_user_id: user.id,
      action: 'organization.updated',
      resource_type: 'organization',
      resource_id: organization.id,
      created_at: createdAt,
    });

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      (databaseHandle) => runAuditExportJob(databaseHandle),
    );

    expect(result.exportedOrganizations).toBe(1);
    expect(result.skipped).toBe(0);
    expect(putObjectBufferMock).toHaveBeenCalledTimes(2);

    const gzipPut = putObjectBufferMock.mock.calls.find(
      (call) => call[0]!.contentType === 'application/gzip',
    )![0]!;
    expect(gzipPut.key).toMatch(
      // eslint-disable-next-line security/detect-non-literal-regexp -- pattern built from server-side ids in test fixtures.
      new RegExp(
        `^audit/export/organization_id=${organization.id}/dt=${dateLabel}/part-.+\\.jsonl\\.gz$`,
      ),
    );
    expect(gzipPut.metadata?.format).toBe('ndjson');
    expect(gzipPut.metadata?.schema_version).toBe('1');
    expect(gzipPut.metadata?.export_date).toBe(dateLabel);
    expect(gzipPut.metadata?.row_count).toBe('1');

    const expectedSha256 = createHash('sha256').update(gzipPut.body).digest('hex');
    expect(gzipPut.metadata?.sha256).toBe(expectedSha256);

    const decompressed = gunzipSync(gzipPut.body).toString('utf8');
    const parsed = JSON.parse(decompressed.trim().split('\n')[0]!) as {
      action: string;
      organization_id: number;
    };
    expect(parsed.action).toBe('organization.updated');
    expect(parsed.organization_id).toBe(organization.id);

    const manifestPut = putObjectBufferMock.mock.calls.find(
      (call) => call[0]!.contentType === 'application/json',
    )![0]!;
    expect(manifestPut.key).toBe(buildManifestKey(organization.id, dateLabel));
    const manifest = JSON.parse(manifestPut.body.toString('utf8')) as AuditExportManifest;
    expect(manifest.schema_version).toBe('1');
    expect(manifest.export_date).toBe(dateLabel);
    expect(manifest.organization_id).toBe(organization.id);
    expect(manifest.objects).toHaveLength(1);
    expect(manifest.objects[0]).toMatchObject({
      key: gzipPut.key,
      row_count: 1,
      sha256: expectedSha256,
      format: 'ndjson',
      content_type: 'application/gzip',
    });
  });

  it('exports separate partition paths for multiple organizations', async () => {
    const { runAuditExportJob } = await import('@/domains/audit/workers/audit-export.processor.js');
    const user = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: user.id });
    const organizationB = await createTestOrganization({ ownerUserId: user.id });
    const { start, dateLabel } = getPreviousUtcDayRange();
    const createdAt = new Date(start.getTime() + 3_600_000);

    await database.insert(logs).values([
      {
        organization_id: organizationA.id,
        actor_user_id: user.id,
        action: 'organization.updated',
        resource_type: 'organization',
        created_at: createdAt,
      },
      {
        organization_id: organizationB.id,
        actor_user_id: user.id,
        action: 'membership.created',
        resource_type: 'membership',
        created_at: createdAt,
      },
    ]);

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      (databaseHandle) => runAuditExportJob(databaseHandle),
    );

    expect(result.exportedOrganizations).toBe(2);
    expect(result.skipped).toBe(0);
    expect(putObjectBufferMock).toHaveBeenCalledTimes(4);

    const gzipKeys = putObjectBufferMock.mock.calls
      .filter((call) => call[0]!.contentType === 'application/gzip')
      .map((call) => call[0]!.key);

    expect(gzipKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          // eslint-disable-next-line security/detect-non-literal-regexp -- pattern built from server-side ids in test fixtures.
          new RegExp(`^audit/export/organization_id=${organizationA.id}/dt=${dateLabel}/part-`),
        ),
        expect.stringMatching(
          // eslint-disable-next-line security/detect-non-literal-regexp -- pattern built from server-side ids in test fixtures.
          new RegExp(`^audit/export/organization_id=${organizationB.id}/dt=${dateLabel}/part-`),
        ),
      ]),
    );

    const manifestKeys = putObjectBufferMock.mock.calls
      .filter((call) => call[0]!.key.endsWith(`/${AUDIT_EXPORT_MANIFEST_FILENAME}`))
      .map((call) => call[0]!.key);

    expect(manifestKeys).toEqual(
      expect.arrayContaining([
        buildManifestKey(organizationA.id, dateLabel),
        buildManifestKey(organizationB.id, dateLabel),
      ]),
    );
  });

  it('skips upload when manifest.json already exists for org+date', async () => {
    const { runAuditExportJob } = await import('@/domains/audit/workers/audit-export.processor.js');
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const { start, dateLabel } = getPreviousUtcDayRange();
    const createdAt = new Date(start.getTime() + 3_600_000);

    await database.insert(logs).values({
      organization_id: organization.id,
      actor_user_id: user.id,
      action: 'membership.created',
      resource_type: 'membership',
      created_at: createdAt,
    });

    const manifestKey = buildManifestKey(organization.id, dateLabel);
    headObjectMock.mockImplementation(async (key: string) => {
      if (key === manifestKey) {
        return { contentType: 'application/json', contentLength: 256 };
      }
      return null;
    });

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      (databaseHandle) => runAuditExportJob(databaseHandle),
    );

    expect(result.exportedOrganizations).toBe(0);
    expect(result.skipped).toBe(1);
    expect(putObjectBufferMock).not.toHaveBeenCalled();
    expect(headObjectMock).toHaveBeenCalledWith(manifestKey);
  });

  it('does not export logs outside the previous UTC calendar day', async () => {
    const { runAuditExportJob } = await import('@/domains/audit/workers/audit-export.processor.js');
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const { end } = getPreviousUtcDayRange();
    const todayLogTime = new Date(end.getTime() + 3_600_000);

    await database.insert(logs).values({
      organization_id: organization.id,
      actor_user_id: user.id,
      action: 'user.login',
      resource_type: 'user',
      created_at: todayLogTime,
    });

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      (databaseHandle) => runAuditExportJob(databaseHandle),
    );

    expect(result).toEqual({ exportedOrganizations: 0, skipped: 0 });
    expect(putObjectBufferMock).not.toHaveBeenCalled();
  });
});
