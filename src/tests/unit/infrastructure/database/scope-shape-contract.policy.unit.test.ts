import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  MAINTENANCE_SCOPE,
  SESSION_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import type { UserAuthContext } from '@/shared/types/index.js';
import { attachRequestPrincipalScope } from '@/shared/middlewares/core/auth.middleware.js';

/**
 * Scope shape contract — the FINALIZED fixed key/value pairs every minter
 * emits, locked so no doorway can ever grow, drop, or rename a field without a
 * deliberate edit here. Downstream (the app/maintenance wrappers, logging,
 * anything serializing a scope) may rely on exactly these keys:
 *
 *   Principal   { userPublicId?, organizationPublicId?, source }   (all minters)
 *   Session     { sessionPublicId?, sessionTokenHash? }   (exactly one defined)
 *   Maintenance { kind }
 *
 * Brand symbols are compile-time only and never appear as runtime keys.
 */
const PRINCIPAL_KEYS = ['organizationPublicId', 'source', 'userPublicId'];
const SESSION_KEYS = ['sessionPublicId', 'sessionTokenHash'];
const MAINTENANCE_KEYS = ['kind'];

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const USER_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';

const userPrincipal: UserAuthContext = { kind: 'user', userId: USER_PUBLIC_ID, role: 'user' };

function attachedScope(auth: object) {
  const request = { id: 'req-shape', auth } as unknown as FastifyRequest;
  attachRequestPrincipalScope(request);
  return request.principalScope;
}

function sortedRuntimeKeys(value: object): string[] {
  return Object.keys(value).sort();
}

describe('scope shape contract (fixed key/value pairs from every doorway)', () => {
  it('the middleware attachment (PRINCIPAL_SCOPE.REQUEST) emits exactly the principal keys', () => {
    const scope = attachedScope({ ...userPrincipal, organizationPublicId: ORGANIZATION_PUBLIC_ID });
    expect(sortedRuntimeKeys(scope)).toEqual(PRINCIPAL_KEYS);
    expect(scope.organizationPublicId).toBe(ORGANIZATION_PUBLIC_ID);
    expect(scope.userPublicId).toBe(USER_PUBLIC_ID);
    expect(scope.source).toBe('request');
  });

  it('an organization-less token attaches exactly the principal keys (organization undefined)', () => {
    const scope = attachedScope(userPrincipal);
    expect(sortedRuntimeKeys(scope)).toEqual(PRINCIPAL_KEYS);
    expect(scope.userPublicId).toBe(USER_PUBLIC_ID);
    expect(scope.organizationPublicId).toBeUndefined();
    expect(scope.source).toBe('request');
  });

  it('PRINCIPAL_SCOPE.JOB emits exactly the principal keys for both payload shapes', () => {
    const organizationScope = PRINCIPAL_SCOPE.JOB({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
    });
    expect(sortedRuntimeKeys(organizationScope)).toEqual(PRINCIPAL_KEYS);
    expect(organizationScope.source).toBe('job');

    const userScope = PRINCIPAL_SCOPE.JOB({ userPublicId: USER_PUBLIC_ID });
    expect(sortedRuntimeKeys(userScope)).toEqual(PRINCIPAL_KEYS);
    expect(userScope.userPublicId).toBe(USER_PUBLIC_ID);
    expect(userScope.organizationPublicId).toBeUndefined();
  });

  it('PRINCIPAL_SCOPE.VERIFIED emits exactly the principal keys', () => {
    const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
    expect(sortedRuntimeKeys(scope)).toEqual(PRINCIPAL_KEYS);
    expect(scope.organizationPublicId).toBe(ORGANIZATION_PUBLIC_ID);
    expect(scope.source).toBe('verified');
  });

  it('SESSION_SCOPE.ARTIFACT emits exactly the named artifact keys (one defined)', () => {
    const publicIdScope = SESSION_SCOPE.ARTIFACT({ sessionPublicId: 'ses_a1b2c3d4e5f6g7h8i9j0k' });
    expect(sortedRuntimeKeys(publicIdScope)).toEqual(SESSION_KEYS);
    expect(publicIdScope.sessionPublicId).toBe('ses_a1b2c3d4e5f6g7h8i9j0k');
    expect(publicIdScope.sessionTokenHash).toBeUndefined();

    const tokenHashScope = SESSION_SCOPE.ARTIFACT({ sessionTokenHash: 'hash-value' });
    expect(sortedRuntimeKeys(tokenHashScope)).toEqual(SESSION_KEYS);
    expect(tokenHashScope.sessionTokenHash).toBe('hash-value');
    expect(tokenHashScope.sessionPublicId).toBeUndefined();
  });

  it('every MAINTENANCE_SCOPE singleton emits exactly { kind } and is frozen', () => {
    for (const [kind, scope] of Object.entries(MAINTENANCE_SCOPE)) {
      expect(sortedRuntimeKeys(scope)).toEqual(MAINTENANCE_KEYS);
      expect(scope.kind).toBe(kind);
      expect(Object.isFrozen(scope)).toBe(true);
    }
  });
});
