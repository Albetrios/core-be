import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createPermissionController } from '@/domains/tenancy/sub-domains/permission/permission.controller.js';
import type { PermissionService } from '@/domains/tenancy/sub-domains/permission/permission.service.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

function mockRequest(): FastifyRequest {
  return attachPrincipalScope({
    id: 'request-id',
    headers: {},
  }) as unknown as FastifyRequest;
}

function mockReply(): FastifyReply {
  const reply = {
    header: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply;
}

const samplePermissionRow = {
  code: 'billing:read',
  name: 'Billing read',
  description: null,
  category: 'billing',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('createPermissionController', () => {
  it('listPermissions returns paginated, serialized permissions', async () => {
    const service = {
      list: vi.fn().mockResolvedValue([samplePermissionRow]),
    } as unknown as PermissionService;
    const controller = createPermissionController(service);
    const response = await controller.listPermissions(mockRequest(), mockReply());
    expect(service.list).toHaveBeenCalled();
    expect(response).toBeDefined();
    expect(response?.data).toEqual([
      {
        code: 'billing:read',
        name: 'Billing read',
        description: null,
        category: 'billing',
        created_at: samplePermissionRow.created_at.toISOString(),
      },
    ]);
  });

  it('listPermissions returns reply when If-None-Match matches catalog ETag', async () => {
    const service = {
      list: vi.fn().mockResolvedValue([samplePermissionRow]),
    } as unknown as PermissionService;
    const controller = createPermissionController(service);
    const firstReply = mockReply();
    await controller.listPermissions(mockRequest(), firstReply);
    const etag = (firstReply.header as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === 'ETag',
    )?.[1];
    expect(etag).toBeDefined();

    const secondReply = mockReply();
    const secondResponse = await controller.listPermissions(
      {
        id: 'request-id-2',
        headers: { 'if-none-match': String(etag) },
      } as FastifyRequest,
      secondReply,
    );
    expect(secondResponse).toBe(secondReply);
    expect(secondReply.status).toHaveBeenCalledWith(304);
    expect(secondReply.send).toHaveBeenCalled();
  });
});
