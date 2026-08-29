import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import { GLOBAL_ROLES } from '@/shared/constants/index.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

vi.mock('@/domains/tenancy/sub-domains/permission/authorization.service.js', () => ({
  resolveUserOrganizationPermissions: vi.fn(),
}));

import { resolveUserOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import {
  requireOrganizationPermission,
  requireRole,
} from '@/shared/utils/auth/authorization.util.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

const mockedResolvePermissions = vi.mocked(resolveUserOrganizationPermissions);

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScope({
    auth: { kind: 'user' as const, userId: 'user-1', role: GLOBAL_ROLES.USER },
    params: { organization_id: 'org-public' },
    ...overrides,
  }) as FastifyRequest;
}

const mockReply = {} as FastifyReply;

describe('authorization.util', () => {
  beforeEach(() => {
    mockedResolvePermissions.mockReset();
  });

  describe('requireRole', () => {
    it('allows user with matching global role', async () => {
      const handler = requireRole(GLOBAL_ROLES.USER);
      await expect(
        handler(
          mockRequest({
            auth: { kind: 'user' as const, userId: 'user-1', role: GLOBAL_ROLES.USER },
          }),
          mockReply,
        ),
      ).resolves.toBeUndefined();
    });

    it('throws ForbiddenError when role is not allowed', async () => {
      const handler = requireRole(GLOBAL_ROLES.SUPER_ADMIN);
      await expect(
        handler(
          mockRequest({
            auth: { kind: 'user' as const, userId: 'user-1', role: GLOBAL_ROLES.USER },
          }),
          mockReply,
        ),
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws UnauthorizedError when not authenticated', async () => {
      const handler = requireRole(GLOBAL_ROLES.USER);
      await expect(handler(mockRequest({ auth: null }), mockReply)).rejects.toThrow(
        UnauthorizedError,
      );
    });
  });

  describe('requireOrganizationPermission', () => {
    it('allows when user has required permission', async () => {
      mockedResolvePermissions.mockResolvedValue(['membership:read', 'membership:manage']);
      const handler = requireOrganizationPermission('membership:manage');
      await expect(handler(mockRequest(), mockReply)).resolves.toBeUndefined();
      expect(mockedResolvePermissions).toHaveBeenCalledWith('user-1', 'org-public');
    });

    it('throws ForbiddenError when permission is missing', async () => {
      mockedResolvePermissions.mockResolvedValue(['membership:read']);
      const handler = requireOrganizationPermission('membership:manage');
      await expect(handler(mockRequest(), mockReply)).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when organization id param is missing', async () => {
      const handler = requireOrganizationPermission('membership:read');
      await expect(handler(mockRequest({ params: {} }), mockReply)).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when only a differently-named param is present (no fallback)', async () => {
      const handler = requireOrganizationPermission('membership:read');
      await expect(
        handler(mockRequest({ params: { id: 'org-by-id' } as Record<string, string> }), mockReply),
      ).rejects.toThrow(ForbiddenError);
      expect(mockedResolvePermissions).not.toHaveBeenCalled();
    });

    it('falls back to the token organization claim when the route carries no path param', async () => {
      mockedResolvePermissions.mockResolvedValue(['membership:read']);
      const handler = requireOrganizationPermission('membership:read');
      await expect(
        handler(
          mockRequest({
            params: {},
            auth: {
              kind: 'user' as const,
              userId: 'user-1',
              role: GLOBAL_ROLES.USER,
              organizationPublicId: 'org-from-claim',
            },
          }),
          mockReply,
        ),
      ).resolves.toBeUndefined();
      // Resolved against the claim organization, not a path param.
      expect(mockedResolvePermissions).toHaveBeenCalledWith('user-1', 'org-from-claim');
    });

    it('throws UnauthorizedError when not authenticated', async () => {
      const handler = requireOrganizationPermission('membership:read');
      await expect(handler(mockRequest({ auth: null }), mockReply)).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it('allows an API key scoped to the matching organization', async () => {
      const handler = requireOrganizationPermission('membership:read');
      const request = mockRequest({
        auth: {
          kind: 'apiKey' as const,
          apiKeyPublicId: 'key-1',
          apiKeyScopes: ['membership:read'],
          organizationPublicId: 'org-public',
        },
      } as Partial<FastifyRequest>);
      await expect(handler(request, mockReply)).resolves.toBeUndefined();
    });

    it('defensive fallback: rejects an API key when a legacy {organization_id} path param disagrees with the key org', async () => {
      // NOTE: post-flatten NO production route carries an `{organization_id}` path param, so this
      // mismatch cannot occur in production — the key's organization IS the active organization. This exercises the
      // belt-and-suspenders `params[paramName] ?? claim` fallback only; the mockRequest default
      // injects `params.organization_id: 'org-public'`, which differs from the key's `other-org`.
      const handler = requireOrganizationPermission('membership:read');
      const request = mockRequest({
        auth: {
          kind: 'apiKey' as const,
          apiKeyPublicId: 'key-1',
          apiKeyScopes: ['membership:read'],
          organizationPublicId: 'other-org',
        },
      } as Partial<FastifyRequest>);
      await expect(handler(request, mockReply)).rejects.toThrow(ForbiddenError);
    });

    it('production path: an API key with no path param is scoped to its own claim organization and passes when scoped', async () => {
      // The real post-flatten shape: no `organization_id` path param, so the organization resolves to the
      // key's pinned `organizationPublicId` (the claim). A correctly-scoped key is authorized.
      const handler = requireOrganizationPermission('membership:read');
      const request = mockRequest({
        params: {} as Record<string, string>,
        auth: {
          kind: 'apiKey' as const,
          apiKeyPublicId: 'key-1',
          apiKeyScopes: ['membership:read'],
          organizationPublicId: 'org-keypinned00000000z',
        },
      } as Partial<FastifyRequest>);
      await expect(handler(request, mockReply)).resolves.toBeUndefined();
    });

    it('production path: an API key with no path param is rejected when its scope lacks the permission', async () => {
      const handler = requireOrganizationPermission('membership:manage');
      const request = mockRequest({
        params: {} as Record<string, string>,
        auth: {
          kind: 'apiKey' as const,
          apiKeyPublicId: 'key-1',
          apiKeyScopes: ['membership:read'], // read only — lacks manage
          organizationPublicId: 'org-keypinned00000000z',
        },
      } as Partial<FastifyRequest>);
      await expect(handler(request, mockReply)).rejects.toThrow(ForbiddenError);
    });

    it('fails closed when an API-key principal carries an empty organization', async () => {
      const handler = requireOrganizationPermission('membership:read');
      const request = mockRequest({
        auth: {
          kind: 'apiKey' as const,
          apiKeyPublicId: 'key-1',
          apiKeyScopes: ['membership:read'],
          organizationPublicId: '',
        },
      } as Partial<FastifyRequest>);
      await expect(handler(request, mockReply)).rejects.toThrow(ForbiddenError);
    });
  });
});
