import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createAuditController } from '@/domains/audit/audit.controller.js';
import type { ListAuditLogsQuery } from '@/domains/audit/audit.dto.js';
import type { AuditService } from '@/domains/audit/audit.service.js';
import { attachPrincipalScopeGetters } from '@/tests/helpers/principal-scope-getters.helper.js';

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

function mockRequest(
  overrides: Partial<FastifyRequest<{ Querystring: ListAuditLogsQuery }>> = {},
): FastifyRequest<{ Querystring: ListAuditLogsQuery }> {
  return attachPrincipalScopeGetters({
    query: { limit: 20 },
    id: 'request-id',
    ...overrides,
  }) as FastifyRequest<{ Querystring: ListAuditLogsQuery }>;
}

function auditLogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    actor_user_id: 10,
    target_user_id: null,
    organization_id: 20,
    action: 'user.login',
    resource_type: 'user',
    resource_id: 10,
    ip_address: '127.0.0.1',
    user_agent: 'vitest',
    severity: 'INFO',
    metadata: { source: 'test', auth_method_id: 99 },
    created_at: new Date('2026-05-19T12:00:00.000Z'),
    ...overrides,
  };
}

describe('createAuditController', () => {
  // sec-re-08: the service now also returns a `resolution` map so the
  // serializer can surface user/org public ids in place of the bigserials.
  // The default mock returns empty maps; specific tests can override.
  const defaultResolution = {
    userPublicIds: new Map(),
    organizationPublicIds: new Map(),
  };

  const service = {
    listForAdmin: vi.fn().mockResolvedValue({
      items: [auditLogRow()],
      resolution: defaultResolution,
      total: 1,
      limit: 20,
      has_more: false,
      next_cursor: null,
    }),
  } as unknown as AuditService;

  const controller = createAuditController(service);

  it('listLogs returns paginated audit entries with sanitized metadata and resolved public ids (sec-re-08)', async () => {
    vi.mocked(service.listForAdmin).mockResolvedValueOnce({
      items: [auditLogRow({ actor_user_id: 7, organization_id: 11 })],
      resolution: {
        userPublicIds: new Map([[7, 'usr_actor_pub']]),
        organizationPublicIds: new Map([[11, 'org_owner_pub']]),
      },
      total: 1,
      limit: 20,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listLogs(
      mockRequest({ query: { limit: 20, include_total: 'true' } }),
      mockReply(),
    );
    expect(service.listForAdmin).toHaveBeenCalled();
    expect(response).toMatchObject({
      data: [
        expect.objectContaining({
          // sec-re-08: bigserial id is DROPPED; action + sanitized metadata
          // pass through; user/org bigints are replaced by resolved public ids.
          action: 'user.login',
          metadata: { source: 'test' },
          actor_user_id: 'usr_actor_pub',
          organization_id: 'org_owner_pub',
        }),
      ],
    });
    expect((response as { data: Record<string, unknown>[] }).data[0]).not.toHaveProperty('id');
  });

  it('listLogs sets has_more and next when more pages exist', async () => {
    vi.mocked(service.listForAdmin).mockResolvedValueOnce({
      items: [auditLogRow({ id: 1 }), auditLogRow({ id: 2 })],
      resolution: defaultResolution,
      total: 4,
      limit: 2,
      has_more: true,
      next_cursor: 'cursor_2',
    } as never);
    const response = await controller.listLogs(
      mockRequest({ query: { limit: 2, include_total: 'true' } }),
      mockReply(),
    );
    expect(response).toMatchObject({
      meta: {
        pagination: expect.objectContaining({
          has_more: true,
          next: 'cursor_2',
        }),
      },
    });
  });

  it('listLogs clears next when on final page', async () => {
    vi.mocked(service.listForAdmin).mockResolvedValueOnce({
      items: [auditLogRow()],
      resolution: defaultResolution,
      total: 1,
      limit: 20,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listLogs(mockRequest(), mockReply());
    expect(response).toMatchObject({
      meta: { pagination: expect.objectContaining({ has_more: false, next: null }) },
    });
  });

  it('listLogs omits estimated_total when service total is null', async () => {
    vi.mocked(service.listForAdmin).mockResolvedValueOnce({
      items: [],
      resolution: defaultResolution,
      total: null,
      limit: 20,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listLogs(mockRequest(), mockReply());
    expect(response.meta?.pagination).not.toHaveProperty('estimated_total');
  });
});
