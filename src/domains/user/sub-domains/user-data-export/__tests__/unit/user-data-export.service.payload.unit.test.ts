import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserDataExportService } from '@/domains/user/sub-domains/user-data-export/user-data-export.service.js';
import { GDPR_EXPORT_MAX_ROWS_PER_TABLE } from '@/shared/constants/query-limits.constants.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import { USER_DATA_EXPORT_STATUSES } from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';
import {
  createPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Payload-shaping and download-URL branches of {@link UserDataExportService}.
 *
 * The sibling `user-data-export.service.unit.test.ts` covers the request/complete/offboarding
 * lifecycle. This file covers what that one leaves unmeasured: how the GDPR bundle is *shaped*
 * (name assembly, per-category row mapping, truncation reporting) and exactly when a presigned
 * download URL is handed out. Both are user-facing data-protection surfaces — a wrong branch
 * either leaks a download for an expired or unfinished export, or silently ships a bundle with
 * fields dropped and no truncation notice.
 */
const { workerExportRepository } = vi.hoisted(() => ({
  workerExportRepository: { findByPublicIdAndUserId: vi.fn() },
}));

vi.mock('@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js', () => ({
  enqueueUserDataExport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/user/sub-domains/user-data-export/user-data-export.repository.js', () => ({
  createWorkerUserDataExportRepository: () => workerExportRepository,
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const ONE_HOUR_MS = 60 * 60 * 1000;

function userRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    public_id: 'user_public',
    email: 'user@example.com',
    first_name: null,
    last_name: null,
    deleted_at: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

const asUserScope = (userPublicId: string) =>
  createPrincipalDatabaseScope({
    userPublicId,
    organizationPublicId: 'org_scope_test',
    source: 'token',
  }) as UserPrincipalDatabaseScope;

describe('UserDataExportService — payload shape and download URL', () => {
  const userService = {
    findUserRecordByPublicId: vi.fn(),
    requireUserRecordByPublicId: vi.fn(),
  };
  const exportRepository = {
    create: vi.fn(),
    findPendingOrProcessingByUserId: vi.fn().mockResolvedValue(null),
    findByPublicIdAndUserId: vi.fn(),
    listByUserId: vi.fn(),
    findS3KeysByUserIdAfter: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn(),
    deleteAllByUserId: vi.fn(),
  };
  const crossDomainServices = {
    authSessionService: { listForUserDataExport: vi.fn() },
    membershipService: { listOrganizationsForUserDataExport: vi.fn() },
    notificationService: { listForUserDataExport: vi.fn() },
    auditService: { listActivityForUserDataExport: vi.fn() },
  };
  const objectStorage = createObjectStoragePortMock();
  const service = new UserDataExportService(
    userService as never,
    exportRepository as never,
    objectStorage,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    service.wireCrossDomainServices(crossDomainServices as never);
    userService.findUserRecordByPublicId.mockResolvedValue(userRecord());
    userService.requireUserRecordByPublicId.mockResolvedValue(userRecord());
    crossDomainServices.authSessionService.listForUserDataExport.mockResolvedValue([]);
    crossDomainServices.membershipService.listOrganizationsForUserDataExport.mockResolvedValue([]);
    crossDomainServices.notificationService.listForUserDataExport.mockResolvedValue([]);
    crossDomainServices.auditService.listActivityForUserDataExport.mockResolvedValue([]);
  });

  // ─── full_name assembly ───────────────────────────────────────

  it('joins first and last name with a single space', async () => {
    userService.requireUserRecordByPublicId.mockResolvedValue(
      userRecord({ first_name: 'Ada', last_name: 'Lovelace' }),
    );

    const payload = await service.buildExportPayload('user_public');

    expect(payload.user.full_name).toBe('Ada Lovelace');
  });

  it('uses the first name alone when the last name is absent', async () => {
    userService.requireUserRecordByPublicId.mockResolvedValue(
      userRecord({ first_name: 'Ada', last_name: null }),
    );

    const payload = await service.buildExportPayload('user_public');

    // filter(Boolean) must drop the null before the join — otherwise the export carries a
    // trailing space, which is a visible defect in a document the user downloads.
    expect(payload.user.full_name).toBe('Ada');
  });

  it('uses the last name alone when the first name is absent', async () => {
    userService.requireUserRecordByPublicId.mockResolvedValue(
      userRecord({ first_name: null, last_name: 'Lovelace' }),
    );

    const payload = await service.buildExportPayload('user_public');

    expect(payload.user.full_name).toBe('Lovelace');
  });

  it('reports full_name as null rather than an empty string when both names are absent', async () => {
    const payload = await service.buildExportPayload('user_public');

    expect(payload.user.full_name).toBeNull();
  });

  it('carries the user public id, email and created_at as an ISO string', async () => {
    const payload = await service.buildExportPayload('user_public');

    expect(payload.user).toMatchObject({
      id: 'user_public',
      email: 'user@example.com',
      created_at: CREATED_AT.toISOString(),
    });
  });

  // ─── per-category row mapping ─────────────────────────────────

  it('maps organization memberships onto the documented export fields', async () => {
    crossDomainServices.membershipService.listOrganizationsForUserDataExport.mockResolvedValue([
      { name: 'Acme', slug: 'acme', status: 'ACTIVE', created_at: CREATED_AT, secret: 'nope' },
    ]);

    const payload = await service.buildExportPayload('user_public');

    // Exact equality, not toMatchObject: an export must not leak columns the shape does not
    // declare, so an extra key on the source row has to be dropped.
    expect(payload.organizations).toEqual([
      { name: 'Acme', slug: 'acme', role: 'ACTIVE', joined_at: CREATED_AT.toISOString() },
    ]);
  });

  it('maps sessions onto the documented export fields', async () => {
    crossDomainServices.authSessionService.listForUserDataExport.mockResolvedValue([
      {
        ip_address: '203.0.113.10',
        last_active_at: CREATED_AT,
        created_at: CREATED_AT,
        token_hash: 'must-not-leak',
      },
    ]);

    const payload = await service.buildExportPayload('user_public');

    expect(payload.sessions).toEqual([
      {
        ip_address: '203.0.113.10',
        last_active_at: CREATED_AT.toISOString(),
        created_at: CREATED_AT.toISOString(),
      },
    ]);
  });

  it('maps notifications onto the documented export fields', async () => {
    crossDomainServices.notificationService.listForUserDataExport.mockResolvedValue([
      { type: 'BILLING', title: 'Usage', message: 'Updated', created_at: CREATED_AT },
    ]);

    const payload = await service.buildExportPayload('user_public');

    expect(payload.notifications).toEqual([
      {
        type: 'BILLING',
        title: 'Usage',
        message: 'Updated',
        created_at: CREATED_AT.toISOString(),
      },
    ]);
  });

  it('maps audit activity onto the documented export fields', async () => {
    crossDomainServices.auditService.listActivityForUserDataExport.mockResolvedValue([
      { action: 'user.login', resource_type: 'user', resource_id: 99, created_at: CREATED_AT },
    ]);

    const payload = await service.buildExportPayload('user_public');

    expect(payload.audit_activity).toEqual([
      { action: 'user.login', resource_type: 'user', created_at: CREATED_AT.toISOString() },
    ]);
  });

  // ─── truncation reporting ─────────────────────────────────────

  it('reports no truncated categories when every category is under the cap', async () => {
    crossDomainServices.notificationService.listForUserDataExport.mockResolvedValue([
      { type: 'BILLING', title: 'Usage', message: 'Updated', created_at: CREATED_AT },
    ]);

    const payload = await service.buildExportPayload('user_public');

    expect(payload.truncation).toEqual({
      row_cap: GDPR_EXPORT_MAX_ROWS_PER_TABLE,
      truncated_categories: [],
    });
  });

  it('caps an oversized category and names it in the truncation notice', async () => {
    crossDomainServices.auditService.listActivityForUserDataExport.mockResolvedValue(
      Array.from({ length: GDPR_EXPORT_MAX_ROWS_PER_TABLE + 3 }, () => ({
        action: 'user.login',
        resource_type: 'user',
        created_at: CREATED_AT,
      })),
    );

    const payload = await service.buildExportPayload('user_public');

    expect(payload.audit_activity).toHaveLength(GDPR_EXPORT_MAX_ROWS_PER_TABLE);
    expect(payload.truncation.truncated_categories).toEqual(['audit_activity']);
  });

  it('names every oversized category, not just the first', async () => {
    const overflow = (row: Record<string, unknown>) =>
      Array.from({ length: GDPR_EXPORT_MAX_ROWS_PER_TABLE + 1 }, () => row);
    crossDomainServices.notificationService.listForUserDataExport.mockResolvedValue(
      overflow({ type: 'BILLING', title: 'Usage', message: 'Updated', created_at: CREATED_AT }),
    );
    crossDomainServices.auditService.listActivityForUserDataExport.mockResolvedValue(
      overflow({ action: 'user.login', resource_type: 'user', created_at: CREATED_AT }),
    );

    const payload = await service.buildExportPayload('user_public');

    expect(payload.truncation.truncated_categories).toEqual(['notifications', 'audit_activity']);
  });

  // ─── download URL gating ──────────────────────────────────────

  function exportRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      public_id: 'ude_aaaaaaaaaaaaaaaaaaaaa',
      user_id: 1,
      status: USER_DATA_EXPORT_STATUSES.COMPLETED,
      s3_key: 'exports/1/bundle.zip',
      expires_at: new Date(Date.now() + ONE_HOUR_MS),
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      completed_at: CREATED_AT,
      failed_at: null,
      error_code: null,
      ...overrides,
    };
  }

  it('issues a presigned download URL for a completed, unexpired export', async () => {
    exportRepository.findByPublicIdAndUserId.mockResolvedValue(exportRow());

    const result = await service.getExportStatus(
      asUserScope('user_public'),
      'ude_aaaaaaaaaaaaaaaaaaaaa',
    );

    expect(objectStorage.createPresignedDownloadUrl).toHaveBeenCalledOnce();
    expect(result.download_url).toBeTruthy();
  });

  it('withholds the download URL once the artifact has expired', async () => {
    // The expiry comparison is the only thing standing between a lapsed retention window and a
    // still-working download link.
    exportRepository.findByPublicIdAndUserId.mockResolvedValue(
      exportRow({ expires_at: new Date(Date.now() - ONE_HOUR_MS) }),
    );

    const result = await service.getExportStatus(
      asUserScope('user_public'),
      'ude_aaaaaaaaaaaaaaaaaaaaa',
    );

    expect(objectStorage.createPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(result.download_url).toBeNull();
  });

  it('withholds the download URL while the export is still pending', async () => {
    exportRepository.findByPublicIdAndUserId.mockResolvedValue(
      exportRow({ status: USER_DATA_EXPORT_STATUSES.PENDING, completed_at: null }),
    );

    const result = await service.getExportStatus(
      asUserScope('user_public'),
      'ude_aaaaaaaaaaaaaaaaaaaaa',
    );

    expect(objectStorage.createPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(result.download_url).toBeNull();
  });

  it('withholds the download URL when the row carries no storage key', async () => {
    exportRepository.findByPublicIdAndUserId.mockResolvedValue(exportRow({ s3_key: null }));

    const result = await service.getExportStatus(
      asUserScope('user_public'),
      'ude_aaaaaaaaaaaaaaaaaaaaa',
    );

    expect(objectStorage.createPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(result.download_url).toBeNull();
  });

  it('withholds the download URL when the row has no expiry stamp', async () => {
    exportRepository.findByPublicIdAndUserId.mockResolvedValue(exportRow({ expires_at: null }));

    const result = await service.getExportStatus(
      asUserScope('user_public'),
      'ude_aaaaaaaaaaaaaaaaaaaaa',
    );

    expect(objectStorage.createPresignedDownloadUrl).not.toHaveBeenCalled();
    expect(result.download_url).toBeNull();
  });
});
