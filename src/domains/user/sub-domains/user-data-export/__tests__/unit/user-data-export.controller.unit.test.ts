import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { USER_DATA_EXPORT_STATUSES } from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';

const { recordScopedAuditEventSpy } = vi.hoisted(() => ({
  recordScopedAuditEventSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/utils/infrastructure/audit-request-context.util.js', () => ({
  recordScopedAuditEvent: recordScopedAuditEventSpy,
}));

import { createUserDataExportController } from '@/domains/user/sub-domains/user-data-export/user-data-export.controller.js';
import type { UserDataExportService } from '@/domains/user/sub-domains/user-data-export/user-data-export.service.js';
import { attachPrincipalScopeGetters } from '@/tests/helpers/principal-scope-getters.helper.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): never {
  return attachPrincipalScopeGetters({
    auth: {
      kind: 'user' as const,
      userId: generatePublicId('user'),
      role: 'user',
      organizationPublicId: generatePublicId('organization'),
    },
    params: {},
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as never;
}

function mockReply(): FastifyReply {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockImplementation((body) => body),
  } as unknown as FastifyReply;
}

describe('createUserDataExportController', () => {
  it('requestExport returns 202 with export payload', async () => {
    const userPublicId = generatePublicId('user');
    const exportPayload = {
      export_id: generatePublicId('userDataExport'),
      status: USER_DATA_EXPORT_STATUSES.PENDING,
      download_url: null,
      expires_at: null,
      completed_at: null,
      failed_at: null,
      error_code: null,
      created_at: new Date().toISOString(),
    };
    const service = {
      requestExport: vi.fn().mockResolvedValue(exportPayload),
    } as unknown as UserDataExportService;
    const controller = createUserDataExportController(service);
    const reply = mockReply();

    await controller.requestExport(
      mockRequest({
        auth: {
          kind: 'user' as const,
          userId: userPublicId,
          role: 'user',
          organizationPublicId: generatePublicId('organization'),
        },
      }),
      reply,
    );

    expect(service.requestExport).toHaveBeenCalledWith(expect.objectContaining({ userPublicId }), {
      requestId: 'request-id',
    });
    expect(reply.status).toHaveBeenCalledWith(202);
  });

  it('getExportStatus delegates to service', async () => {
    const userPublicId = generatePublicId('user');
    const exportId = generatePublicId('userDataExport');
    const service = {
      getExportStatus: vi.fn().mockResolvedValue({
        export_id: exportId,
        status: USER_DATA_EXPORT_STATUSES.COMPLETED,
      }),
    } as unknown as UserDataExportService;
    const controller = createUserDataExportController(service);

    const response = await controller.getExportStatus(
      mockRequest({
        auth: {
          kind: 'user' as const,
          userId: userPublicId,
          role: 'user',
          organizationPublicId: generatePublicId('organization'),
        },
        params: { data_export_id: exportId },
      }),
      mockReply(),
    );

    expect(service.getExportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ userPublicId }),
      exportId,
    );
    expect(response).toMatchObject({
      data: { export_id: exportId, status: USER_DATA_EXPORT_STATUSES.COMPLETED },
    });
  });

  // sec-U6: GDPR bundle download URL is a sensitive material — an attacker who
  // exfiltrates a session token can repeatedly mint fresh presigned URLs and
  // download the user's entire data history (sessions, IPs, memberships,
  // notifications, audit). Every URL mint must leave a row in `audit.events`
  // so the user (and admins) can see post-hoc who pulled the bundle when.
  it('records a user.data_export.url_minted audit event when download_url is returned', async () => {
    const userPublicId = generatePublicId('user');
    const exportId = generatePublicId('userDataExport');
    recordScopedAuditEventSpy.mockClear();
    const service = {
      getExportStatus: vi.fn().mockResolvedValue({
        export_id: exportId,
        status: USER_DATA_EXPORT_STATUSES.COMPLETED,
        download_url: 'https://s3.example.com/presigned-url',
      }),
    } as unknown as UserDataExportService;
    const controller = createUserDataExportController(service);

    await controller.getExportStatus(
      mockRequest({
        auth: {
          kind: 'user' as const,
          userId: userPublicId,
          role: 'user',
          organizationPublicId: generatePublicId('organization'),
        },
        params: { data_export_id: exportId },
      }),
      mockReply(),
    );

    expect(recordScopedAuditEventSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserPublicId: userPublicId,
        action: 'user.data_export.url_minted',
        resource_type: 'user_data_export',
        metadata: expect.objectContaining({ export_public_id: exportId }),
      }),
    );
  });

  it('does NOT record an audit event when no download_url is returned (status != COMPLETED)', async () => {
    const userPublicId = generatePublicId('user');
    const exportId = generatePublicId('userDataExport');
    recordScopedAuditEventSpy.mockClear();
    const service = {
      getExportStatus: vi.fn().mockResolvedValue({
        export_id: exportId,
        status: USER_DATA_EXPORT_STATUSES.PROCESSING,
        download_url: null,
      }),
    } as unknown as UserDataExportService;
    const controller = createUserDataExportController(service);

    await controller.getExportStatus(
      mockRequest({
        auth: {
          kind: 'user' as const,
          userId: userPublicId,
          role: 'user',
          organizationPublicId: generatePublicId('organization'),
        },
        params: { data_export_id: exportId },
      }),
      mockReply(),
    );

    // Only minted URLs are auditable events. A status poll (no URL minted yet)
    // is observability noise; recording it would dilute the signal during
    // incident response.
    expect(recordScopedAuditEventSpy).not.toHaveBeenCalled();
  });
});
