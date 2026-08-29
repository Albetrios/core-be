import { describe, expect, it } from 'vitest';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@/shared/errors/index.js';
import {
  getActingUserPublicId,
  getAuthenticatedActorId,
  getRequestIdentifier,
  isApiKeyPrincipal,
  isUserPrincipal,
  requireAuth,
  requirePrincipal,
  resolveActiveOrganizationId,
  requireOrganizationScope,
  requireUserScope,
} from '@/shared/utils/http/request.util.js';
import type { ApiKeyAuthContext, UserAuthContext } from '@/shared/types/index.js';
import type { FastifyRequest } from 'fastify';
import { attachPrincipalScopeGetters } from '@/tests/helpers/principal-scope-getters.helper.js';

const userPrincipal: UserAuthContext = { kind: 'user', userId: 'user-1', role: 'user' };
const apiKeyPrincipal: ApiKeyAuthContext = {
  kind: 'apiKey',
  apiKeyPublicId: 'key-1',
  apiKeyScopes: ['membership:read'],
  organizationPublicId: 'org-1',
};

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScopeGetters({
    id: 'req-123',
    auth: undefined,
    ...overrides,
  }) as FastifyRequest;
}

describe('request.util', () => {
  describe('getRequestIdentifier', () => {
    it('returns request.id', () => {
      expect(getRequestIdentifier(mockRequest({ id: 'trace-abc' }))).toBe('trace-abc');
    });
  });

  describe('requireAuth', () => {
    it('returns auth context when userId is present', () => {
      const auth = { kind: 'user' as const, userId: 'user-1', role: 'user' as const };
      expect(requireAuth(mockRequest({ auth }))).toEqual(auth);
    });

    it('throws UnauthorizedError when auth is missing', () => {
      expect(() => requireAuth(mockRequest())).toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError when userId is missing', () => {
      expect(() => requireAuth(mockRequest({ auth: { role: 'user' } as never }))).toThrow(
        UnauthorizedError,
      );
    });

    it('throws UnauthorizedError for an API-key principal (user-only route)', () => {
      expect(() => requireAuth(mockRequest({ auth: apiKeyPrincipal }))).toThrow(UnauthorizedError);
    });
  });

  describe('requirePrincipal', () => {
    it('returns a user principal', () => {
      expect(requirePrincipal(mockRequest({ auth: userPrincipal }))).toEqual(userPrincipal);
    });

    it('returns an API-key principal', () => {
      expect(requirePrincipal(mockRequest({ auth: apiKeyPrincipal }))).toEqual(apiKeyPrincipal);
    });

    it('throws UnauthorizedError when unauthenticated', () => {
      expect(() => requirePrincipal(mockRequest())).toThrow(UnauthorizedError);
    });
  });

  describe('principal helpers', () => {
    it('narrows principal kinds', () => {
      expect(isUserPrincipal(userPrincipal)).toBe(true);
      expect(isUserPrincipal(apiKeyPrincipal)).toBe(false);
      expect(isApiKeyPrincipal(apiKeyPrincipal)).toBe(true);
      expect(isApiKeyPrincipal(userPrincipal)).toBe(false);
    });

    it('getActingUserPublicId returns the user id for users and undefined for API keys', () => {
      expect(getActingUserPublicId(userPrincipal)).toBe('user-1');
      expect(getActingUserPublicId(apiKeyPrincipal)).toBeUndefined();
    });

    it('getAuthenticatedActorId returns a non-empty actor id for both principal kinds', () => {
      expect(getAuthenticatedActorId(userPrincipal)).toBe('user-1');
      expect(getAuthenticatedActorId(apiKeyPrincipal)).toBe('key-1');
    });
  });

  describe('resolveActiveOrganizationId', () => {
    const pathOrg = 'org_a1b2c3d4e5f6g7h8i9j0k';
    const claimOrg = 'org_z9y8x7w6v5u4t3s2r1q0p';

    it('returns the path param when the route carries {organization_id}', () => {
      const request = mockRequest({
        params: { organization_id: pathOrg } as Record<string, string>,
        auth: { ...userPrincipal, organizationPublicId: claimOrg },
      });
      expect(resolveActiveOrganizationId(request)).toBe(pathOrg);
    });

    it('falls back to the token org claim when the route carries no path param', () => {
      const request = mockRequest({
        params: {} as Record<string, string>,
        auth: { ...userPrincipal, organizationPublicId: claimOrg },
      });
      expect(resolveActiveOrganizationId(request)).toBe(claimOrg);
    });

    it('prefers the path param over the claim (precedence matches requireOrganizationPermission)', () => {
      const request = mockRequest({
        params: { organization_id: pathOrg } as Record<string, string>,
        auth: { ...userPrincipal, organizationPublicId: claimOrg },
      });
      // Must equal the permission-layer source (`params ?? claim`) so authz and RLS cannot diverge.
      expect(resolveActiveOrganizationId(request)).toBe(pathOrg);
    });

    it('resolves an API-key principal’s pinned organization from the claim', () => {
      const request = mockRequest({ params: {} as Record<string, string>, auth: apiKeyPrincipal });
      // apiKeyPrincipal.organizationPublicId is 'org-1' (malformed) — proves it routes through the claim.
      expect(() => resolveActiveOrganizationId(request)).toThrow(ValidationError);
    });

    it('throws ForbiddenError when neither a path param nor a claim is present', () => {
      const request = mockRequest({ params: {} as Record<string, string>, auth: userPrincipal });
      expect(() => resolveActiveOrganizationId(request)).toThrow(ForbiddenError);
    });

    it('throws ValidationError when the resolved organization id is malformed', () => {
      const request = mockRequest({
        params: { organization_id: 'not-an-org-id' } as Record<string, string>,
        auth: userPrincipal,
      });
      expect(() => resolveActiveOrganizationId(request)).toThrow(ValidationError);
    });
  });
});

describe('principal scope narrowing accessors (over the middleware-attached scope)', () => {
  const claimOrg = 'org_z9y8x7w6v5u4t3s2r1q0p';

  describe('requireOrganizationScope', () => {
    it('narrows to the org-bearing scope for a user principal with an org claim', () => {
      const request = mockRequest({ auth: { ...userPrincipal, organizationPublicId: claimOrg } });
      const scope = requireOrganizationScope(request);
      expect(scope.organizationPublicId).toBe(claimOrg);
      expect(scope.userPublicId).toBe(userPrincipal.userId);
      expect(scope.source).toBe('request');
    });

    it('throws ForbiddenError for a stale token with no org claim (personal/team invariant)', () => {
      const request = mockRequest({ auth: userPrincipal });
      expect(() => requireOrganizationScope(request)).toThrow(ForbiddenError);
    });

    it('narrows an API-key principal to its key-pinned organization (no user identity)', () => {
      const request = mockRequest({ auth: { ...apiKeyPrincipal, organizationPublicId: claimOrg } });
      const scope = requireOrganizationScope(request);
      expect(scope.userPublicId).toBeUndefined();
      expect(scope.organizationPublicId).toBe(claimOrg);
    });

    it('throws UnauthorizedError when unauthenticated (no scope attached)', () => {
      expect(() => requireOrganizationScope(mockRequest())).toThrow(UnauthorizedError);
    });
  });

  describe('requireUserScope', () => {
    it('narrows to the user-bearing scope for a user principal', () => {
      const request = mockRequest({ auth: { ...userPrincipal, organizationPublicId: claimOrg } });
      const scope = requireUserScope(request);
      expect(scope.userPublicId).toBe(userPrincipal.userId);
      expect(scope.organizationPublicId).toBe(claimOrg);
    });

    it('keeps the org optional for an org-less token (the /users/me self-heal state)', () => {
      const request = mockRequest({ auth: userPrincipal });
      const scope = requireUserScope(request);
      expect(scope.userPublicId).toBe(userPrincipal.userId);
      expect(scope.organizationPublicId).toBeUndefined();
    });

    it('rejects an API-key principal (user-owned resources need a real end user)', () => {
      const request = mockRequest({ auth: { ...apiKeyPrincipal, organizationPublicId: claimOrg } });
      expect(() => requireUserScope(request)).toThrow(UnauthorizedError);
    });
  });
});
