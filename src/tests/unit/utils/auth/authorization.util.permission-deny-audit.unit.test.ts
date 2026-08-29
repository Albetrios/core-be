import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '@/shared/errors/index.js';
import { GLOBAL_ROLES } from '@/shared/constants/index.js';

vi.mock('@/domains/tenancy/sub-domains/permission/authorization.service.js', () => ({
  resolveUserOrganizationPermissions: vi.fn(),
}));

import { resolveUserOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import {
  requireOrganizationPermission,
  requireRole,
} from '@/shared/utils/auth/authorization.util.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

/**
 * Regression for sec-U13 (Low): both `requireRole` and
 * `requireOrganizationPermission` used to throw `ForbiddenError` with no
 * audit recording. An attacker probing the admin surface generated no audit
 * entries — only 403s in the request log — so defenders could not use
 * `audit.logs` to spot "user X tried 47 admin endpoints in 5 min."
 *
 * Both prehandlers now best-effort write `auth.permission.denied` (severity
 * WARNING) before throwing. The audit write must NOT block the 403: it is
 * fire-and-forget and the ForbiddenError path is unchanged. Volume is
 * already bounded by the standard authenticated rate-limit middleware so no
 * bespoke per-(user, route) audit throttle is added here.
 *
 * The wiring uses `request.server.auditDomain?.auditService` so the
 * prehandler stays testable in isolation (no hard DI dependency on the
 * audit domain — absence simply skips the write).
 */
describe('authorization.util — permission-deny audit (sec-U13)', () => {
  const mockedResolvePermissions = vi.mocked(resolveUserOrganizationPermissions);
  const auditRecord = vi.fn().mockResolvedValue(undefined);

  function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
    return attachPrincipalScope({
      auth: { kind: 'user' as const, userId: 'user-1', role: GLOBAL_ROLES.USER },
      params: { organization_id: 'org-public' },
      routeOptions: { url: '/api/v1/admin/test' },
      url: '/api/v1/admin/test',
      method: 'GET',
      id: 'request-id',
      ip: '127.0.0.1',
      headers: {},
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      server: {
        auditDomain: { auditService: { record: auditRecord } },
        tenancyDomain: { organizationService: { findOrganizationByPublicId: vi.fn() } },
      },
      ...overrides,
    }) as unknown as FastifyRequest;
  }

  const mockReply = {} as FastifyReply;

  beforeEach(() => {
    mockedResolvePermissions.mockReset();
    auditRecord.mockClear();
  });

  it('requireRole writes auth.permission.denied at WARNING when role insufficient', async () => {
    const handler = requireRole(GLOBAL_ROLES.SUPER_ADMIN);
    await expect(handler(mockRequest(), mockReply)).rejects.toThrow(ForbiddenError);
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const call = auditRecord.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      action: 'auth.permission.denied',
      resource_type: 'route',
      actorUserPublicId: 'user-1',
      severity: 'WARNING',
    });
  });

  it('requireOrganizationPermission writes auth.permission.denied when permission missing', async () => {
    mockedResolvePermissions.mockResolvedValue(['membership:read']);
    const handler = requireOrganizationPermission('membership:manage');
    await expect(handler(mockRequest(), mockReply)).rejects.toThrow(ForbiddenError);
    expect(auditRecord).toHaveBeenCalledTimes(1);
    const call = auditRecord.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      action: 'auth.permission.denied',
      resource_type: 'route',
      severity: 'WARNING',
    });
    expect(call?.metadata?.permission_code).toBe('membership:manage');
  });

  it('still throws ForbiddenError even when the audit write rejects (best-effort)', async () => {
    auditRecord.mockRejectedValueOnce(new Error('audit down'));
    const handler = requireRole(GLOBAL_ROLES.SUPER_ADMIN);
    await expect(handler(mockRequest(), mockReply)).rejects.toThrow(ForbiddenError);
  });

  it('tolerates a request without auditDomain decorator (no throw, no write)', async () => {
    const handler = requireRole(GLOBAL_ROLES.SUPER_ADMIN);
    const requestWithoutAudit = mockRequest({
      server: {
        auditDomain: undefined,
        tenancyDomain: { organizationService: { findOrganizationByPublicId: vi.fn() } },
      } as never,
    });
    await expect(handler(requestWithoutAudit, mockReply)).rejects.toThrow(ForbiddenError);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('does NOT write an audit row on allowed access', async () => {
    const handler = requireRole(GLOBAL_ROLES.USER);
    await expect(handler(mockRequest(), mockReply)).resolves.toBeUndefined();
    expect(auditRecord).not.toHaveBeenCalled();
  });
});
