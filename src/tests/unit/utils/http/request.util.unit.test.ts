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
  resolvePrincipalDatabaseScope,
  requireOrganizationPrincipalDatabaseScope,
} from '@/shared/utils/http/request.util.js';
import type { ApiKeyAuthContext, UserAuthContext } from '@/shared/types/index.js';
import type { FastifyRequest } from 'fastify';

const userPrincipal: UserAuthContext = { kind: 'user', userId: 'user-1', role: 'user' };
const apiKeyPrincipal: ApiKeyAuthContext = {
  kind: 'apiKey',
  apiKeyPublicId: 'key-1',
  apiKeyScopes: ['membership:read'],
  organizationPublicId: 'org-1',
};

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    id: 'req-123',
    auth: undefined,
    ...overrides,
  } as FastifyRequest;
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

describe('principal database scope minters', () => {
  const pathOrg = 'org_a1b2c3d4e5f6g7h8i9j0k';
  const claimOrg = 'org_z9y8x7w6v5u4t3s2r1q0p';

  describe('resolvePrincipalDatabaseScope', () => {
    it('mints user + organization scope from a user principal with an org claim', () => {
      const request = mockRequest({ auth: { ...userPrincipal, organizationPublicId: claimOrg } });
      const scope = resolvePrincipalDatabaseScope(request);
      expect(scope.userPublicId).toBe(userPrincipal.userId);
      expect(scope.organizationPublicId).toBe(claimOrg);
      expect(scope.source).toBe('token');
    });

    it('mints a user-only scope when no organization is in scope', () => {
      const request = mockRequest({ auth: userPrincipal });
      const scope = resolvePrincipalDatabaseScope(request);
      expect(scope.userPublicId).toBe(userPrincipal.userId);
      expect(scope.organizationPublicId).toBeUndefined();
    });

    it('prefers the {organization_id} path param over the claim (permission-check precedence)', () => {
      const request = mockRequest({
        params: { organization_id: pathOrg } as Record<string, string>,
        auth: { ...userPrincipal, organizationPublicId: claimOrg },
      });
      expect(resolvePrincipalDatabaseScope(request).organizationPublicId).toBe(pathOrg);
    });

    it('mints an organization-only scope for an API-key principal (no user identity)', () => {
      const request = mockRequest({
        auth: { ...apiKeyPrincipal, organizationPublicId: claimOrg },
      });
      const scope = resolvePrincipalDatabaseScope(request);
      expect(scope.userPublicId).toBeUndefined();
      expect(scope.organizationPublicId).toBe(claimOrg);
    });

    it('throws UnauthorizedError when unauthenticated', () => {
      expect(() => resolvePrincipalDatabaseScope(mockRequest())).toThrow(UnauthorizedError);
    });

    it('throws ValidationError for a malformed path organization id', () => {
      const request = mockRequest({
        params: { organization_id: 'not-a-public-id' } as Record<string, string>,
        auth: { ...userPrincipal, organizationPublicId: claimOrg },
      });
      expect(() => resolvePrincipalDatabaseScope(request)).toThrow(ValidationError);
    });
  });

  describe('requireOrganizationPrincipalDatabaseScope', () => {
    it('returns the scope when an organization is in scope', () => {
      const request = mockRequest({ auth: { ...userPrincipal, organizationPublicId: claimOrg } });
      expect(requireOrganizationPrincipalDatabaseScope(request).organizationPublicId).toBe(
        claimOrg,
      );
    });

    it('throws ForbiddenError when no organization is in scope', () => {
      const request = mockRequest({ auth: userPrincipal });
      expect(() => requireOrganizationPrincipalDatabaseScope(request)).toThrow(ForbiddenError);
    });
  });
});
