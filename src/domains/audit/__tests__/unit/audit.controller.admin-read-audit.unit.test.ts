import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createAuditController } from '@/domains/audit/audit.controller.js';
import type { ListAuditLogsQuery } from '@/domains/audit/audit.dto.js';
import type { AuditService } from '@/domains/audit/audit.service.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Regression for sec-U4 (Medium): the admin audit-log listing accepts
 * `actor_user_id` / `organization_id` filters and runs under
 * `withMaintenanceDatabaseContext`. An ADMIN-roled employee could read any
 * user's full audit timeline (IPs, sessions, actions, resources) without the
 * platform ever recording who watched whom — combined with U2's metadata
 * stripping, "who watched whom?" was unanswerable.
 *
 * `listLogs` now writes `audit.admin.read` (severity WARNING) whenever the
 * filter set narrows to a specific subject (actor_user_id and/or
 * organization_id). Unnarrowed listings (admin paging the global feed) are
 * not audited individually — the global request log already records them and
 * they do not single out a victim.
 *
 * Request volume is already bounded by the standard authenticated rate
 * limit; this PR does not add a bespoke per-(admin,target) audit-emission
 * throttle. If post-incident review shows excessive volume, follow up with
 * the throttle layer.
 */
describe('createAuditController — admin-read audit (sec-U4)', () => {
  const adminPublicId = generatePublicId('user');
  const targetUserPublicId = generatePublicId('user');
  const targetOrgPublicId = generatePublicId('organization');
  const auditRecord = vi.fn().mockResolvedValue(undefined);

  const service = {
    listForAdmin: vi.fn().mockResolvedValue({
      items: [],
      total: null,
      limit: 20,
      has_more: false,
      next_cursor: null,
    }),
  } as unknown as AuditService;

  const controller = createAuditController(service);

  function mockReply(): FastifyReply {
    const headers = new Map<string, string>();
    return {
      header(name: string, value: string) {
        headers.set(name, value);
        return this;
      },
      getHeader(name: string) {
        return headers.get(name);
      },
    } as unknown as FastifyReply;
  }

  function mockAdminRequest(
    query: Partial<ListAuditLogsQuery>,
  ): FastifyRequest<{ Querystring: ListAuditLogsQuery }> {
    return {
      auth: { kind: 'user' as const, userId: adminPublicId, role: 'super_admin' },
      query: { limit: 20, ...query },
      id: 'request-id',
      ip: '127.0.0.1',
      headers: {},
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      server: {
        auditDomain: { auditService: { record: auditRecord } },
        tenancyDomain: { organizationService: { findOrganizationByPublicId: vi.fn() } },
      },
    } as unknown as FastifyRequest<{ Querystring: ListAuditLogsQuery }>;
  }

  beforeEach(() => {
    auditRecord.mockClear();
  });

  it('writes audit.admin.read when filter narrows to a specific user', async () => {
    await controller.listLogs(mockAdminRequest({ actor_user_id: targetUserPublicId }), mockReply());
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const call = auditRecord.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      action: 'audit.admin.read',
      resource_type: 'audit_log',
      actorUserPublicId: adminPublicId,
      severity: 'WARNING',
    });
    expect(call?.metadata?.target_actor_user_id).toBe(targetUserPublicId);
  });

  it('writes audit.admin.read when filter narrows to a specific organization', async () => {
    await controller.listLogs(
      mockAdminRequest({ organization_id: targetOrgPublicId }),
      mockReply(),
    );
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const call = auditRecord.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      action: 'audit.admin.read',
      resource_type: 'audit_log',
      severity: 'WARNING',
    });
    expect(call?.metadata?.target_organization_id).toBe(targetOrgPublicId);
  });

  it('does NOT write an audit row for unnarrowed global paging', async () => {
    await controller.listLogs(mockAdminRequest({ limit: 50 }), mockReply());
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('still returns the response even when the audit write throws (best-effort)', async () => {
    auditRecord.mockRejectedValueOnce(new Error('audit down'));
    const response = await controller.listLogs(
      mockAdminRequest({ actor_user_id: targetUserPublicId }),
      mockReply(),
    );
    expect(response.data).toEqual([]);
  });
});
