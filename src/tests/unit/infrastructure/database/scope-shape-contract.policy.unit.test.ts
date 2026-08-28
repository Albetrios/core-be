import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  SESSION_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { resolveJobPrincipalScope } from '@/infrastructure/queue/worker-runtime/job-principal-scope.util.js';
import type { UserAuthContext } from '@/shared/types/index.js';
import { REQUEST_SCOPE } from '@/shared/utils/http/request.util.js';
import { resolveVerifiedPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

/**
 * Scope shape contract — the FINALIZED fixed key/value pairs every minter
 * emits, locked so no doorway can ever grow, drop, or rename a field without a
 * deliberate edit here. Downstream (the app/maintenance wrappers, logging,
 * anything serializing a scope) may rely on exactly these keys:
 *
 *   Principal   { userPublicId?, organizationPublicId?, source }   (all minters)
 *   Session     { kind, value }
 *   Maintenance { kind }
 *
 * Brand symbols are compile-time only and never appear as runtime keys.
 */
const PRINCIPAL_KEYS = ['organizationPublicId', 'source', 'userPublicId'];
const SESSION_KEYS = ['kind', 'value'];
const MAINTENANCE_KEYS = ['kind'];

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const USER_PUBLIC_ID = 'usr_a1b2c3d4e5f6g7h8i9j0k';

const userPrincipal: UserAuthContext = { kind: 'user', userId: USER_PUBLIC_ID, role: 'user' };

function requestWithOrgClaim(): FastifyRequest {
  return {
    id: 'req-shape',
    auth: { ...userPrincipal, organizationPublicId: ORGANIZATION_PUBLIC_ID },
  } as unknown as FastifyRequest;
}

function sortedRuntimeKeys(value: object): string[] {
  return Object.keys(value).sort();
}

describe('scope shape contract (fixed key/value pairs from every doorway)', () => {
  it('REQUEST_SCOPE.ORGANIZATION emits exactly the principal keys', () => {
    const scope = REQUEST_SCOPE.ORGANIZATION(requestWithOrgClaim());
    expect(sortedRuntimeKeys(scope)).toEqual(PRINCIPAL_KEYS);
    expect(scope.organizationPublicId).toBe(ORGANIZATION_PUBLIC_ID);
    expect(scope.userPublicId).toBe(USER_PUBLIC_ID);
    expect(scope.source).toBe('request');
  });

  it('REQUEST_SCOPE.USER emits exactly the principal keys (org undefined when absent)', () => {
    const scope = REQUEST_SCOPE.USER({
      id: 'req-shape',
      auth: userPrincipal,
    } as unknown as FastifyRequest);
    expect(sortedRuntimeKeys(scope)).toEqual(PRINCIPAL_KEYS);
    expect(scope.userPublicId).toBe(USER_PUBLIC_ID);
    expect(scope.organizationPublicId).toBeUndefined();
    expect(scope.source).toBe('request');
  });

  it('resolveJobPrincipalScope emits exactly the principal keys for both payload shapes', () => {
    const organizationScope = resolveJobPrincipalScope({
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
    });
    expect(sortedRuntimeKeys(organizationScope)).toEqual(PRINCIPAL_KEYS);
    expect(organizationScope.source).toBe('job');

    const userScope = resolveJobPrincipalScope({ userPublicId: USER_PUBLIC_ID });
    expect(sortedRuntimeKeys(userScope)).toEqual(PRINCIPAL_KEYS);
    expect(userScope.userPublicId).toBe(USER_PUBLIC_ID);
    expect(userScope.organizationPublicId).toBeUndefined();
  });

  it('resolveVerifiedPrincipalScope emits exactly the principal keys', () => {
    const scope = resolveVerifiedPrincipalScope({ organizationPublicId: ORGANIZATION_PUBLIC_ID });
    expect(sortedRuntimeKeys(scope)).toEqual(PRINCIPAL_KEYS);
    expect(scope.organizationPublicId).toBe(ORGANIZATION_PUBLIC_ID);
    expect(scope.source).toBe('provisioning');
  });

  it('SESSION_SCOPE factories emit exactly { kind, value }', () => {
    const publicIdScope = SESSION_SCOPE.SESSION_PUBLIC_ID('ses_a1b2c3d4e5f6g7h8i9j0k');
    expect(sortedRuntimeKeys(publicIdScope)).toEqual(SESSION_KEYS);
    expect(publicIdScope.kind).toBe('SESSION_PUBLIC_ID');

    const tokenHashScope = SESSION_SCOPE.SESSION_TOKEN_HASH('hash-value');
    expect(sortedRuntimeKeys(tokenHashScope)).toEqual(SESSION_KEYS);
    expect(tokenHashScope.kind).toBe('SESSION_TOKEN_HASH');
    expect(tokenHashScope.value).toBe('hash-value');
  });

  it('every MAINTENANCE_SCOPE singleton emits exactly { kind } and is frozen', () => {
    for (const [kind, scope] of Object.entries(MAINTENANCE_SCOPE)) {
      expect(sortedRuntimeKeys(scope)).toEqual(MAINTENANCE_KEYS);
      expect(scope.kind).toBe(kind);
      expect(Object.isFrozen(scope)).toBe(true);
    }
  });
});
