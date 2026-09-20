import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { GLOBAL_ROLES } from '@/shared/constants/roles.constants.js';
import { signAccessToken } from '@/shared/utils/security/jwt.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

// Module-level mock — must be declared before importing the middleware so the auth
// middleware's static `import { resolveGlobalRoleForEmail } ...` resolves to this stub.
vi.mock('@/shared/utils/auth/global-admin-role.util.js', () => ({
  resolveGlobalRoleForEmail: vi.fn(),
}));

import authMiddleware from '@/shared/middlewares/core/auth.middleware.js';
import { resolveGlobalRoleForEmail } from '@/shared/utils/auth/global-admin-role.util.js';

/**
 * Regression for sec-A6 (Medium): the JWT carries `role: super_admin` baked in at
 * sign-time from the then-current `GLOBAL_ADMIN_EMAILS`. Previously, the auth middleware
 * trusted that claim for the full token lifetime — so removing an email from the
 * allowlist (e.g. emergency demotion of a misbehaving admin) took up to
 * `GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS` (default 5 min) to take effect.
 *
 * Now: when the JWT carries SUPER_ADMIN, the middleware re-derives the role per request
 * by looking up the user's current email and re-checking it against the live
 * `GLOBAL_ADMIN_EMAILS`. A demoted email is downgraded immediately. Regular users
 * (`role: user` or no role) skip the lookup entirely — no hot-path regression.
 */
describe('auth.middleware — super_admin per-request re-derive (sec-A6)', () => {
  let application: FastifyInstance;
  const findUserRecordByPublicId = vi.fn();

  async function setup(): Promise<void> {
    application = Fastify();
    application.decorate('authDomain', {
      authSessionService: {
        verifyActiveAccessToken: vi.fn().mockResolvedValue({ sessionPublicId: 'sess_test' }),
      },
    } as never);
    application.decorate('userDomain', {
      userService: { findUserRecordByPublicId },
    } as never);
    application.decorate('tenancyDomain', {
      organizationApiKeyService: {
        authenticate: vi.fn().mockResolvedValue(null),
      },
    } as never);
    await application.register(authMiddleware);
    application.get(
      '/protected',
      { preHandler: (req, reply) => application.authenticate(req, reply) },
      async (req) => req.auth,
    );
    await application.ready();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    findUserRecordByPublicId.mockResolvedValue({
      id: 1,
      public_id: 'user_pub',
      email: 'admin@example.com',
      status: 'ACTIVE',
      is_email_verified: true,
    });
  });

  it('downgrades a SUPER_ADMIN JWT to USER when the email is no longer in GLOBAL_ADMIN_EMAILS', async () => {
    vi.mocked(resolveGlobalRoleForEmail).mockReturnValue(undefined);
    await setup();
    const userPublicId = generatePublicId('user');
    const accessToken = await signAccessToken({
      userId: userPublicId,
      role: GLOBAL_ROLES.SUPER_ADMIN,
    });

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { role?: string };
    // The JWT claimed super_admin but the email is no longer in the allowlist; the
    // middleware re-derives and downgrades to USER (the account is still ACTIVE).
    expect(body.role).toBe(GLOBAL_ROLES.USER);
    expect(findUserRecordByPublicId).toHaveBeenCalledWith(userPublicId);
    await application.close();
  });

  it('keeps SUPER_ADMIN when the email is still in GLOBAL_ADMIN_EMAILS', async () => {
    vi.mocked(resolveGlobalRoleForEmail).mockReturnValue(GLOBAL_ROLES.SUPER_ADMIN);
    await setup();
    const userPublicId = generatePublicId('user');
    const accessToken = await signAccessToken({
      userId: userPublicId,
      role: GLOBAL_ROLES.SUPER_ADMIN,
    });

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { role?: string }).role).toBe(GLOBAL_ROLES.SUPER_ADMIN);
    await application.close();
  });

  it('reaudit-#10: drops SUPER_ADMIN when the account is suspended even if the email is still allowlisted', async () => {
    vi.mocked(resolveGlobalRoleForEmail).mockReturnValue(GLOBAL_ROLES.SUPER_ADMIN);
    findUserRecordByPublicId.mockResolvedValue({
      id: 1,
      public_id: 'user_pub',
      email: 'admin@example.com',
      status: 'SUSPENDED',
      is_email_verified: true,
    });
    await setup();
    const userPublicId = generatePublicId('user');
    const accessToken = await signAccessToken({
      userId: userPublicId,
      role: GLOBAL_ROLES.SUPER_ADMIN,
    });

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    // The email is still in the allowlist, but the account is suspended → role is dropped.
    expect((response.json() as { role?: string }).role).toBeUndefined();
    await application.close();
  });

  it('reaudit-#13: drops SUPER_ADMIN when the account email is unverified even if still allowlisted', async () => {
    // Symmetry with the token-minting side (resolveAccessTokenRoleForUser requires a verified email).
    // The email is allowlisted and the account is ACTIVE, but unverified → the role must be dropped so
    // the two derivation sites cannot drift into a re-grant for an unverified allowlisted account.
    vi.mocked(resolveGlobalRoleForEmail).mockReturnValue(GLOBAL_ROLES.SUPER_ADMIN);
    findUserRecordByPublicId.mockResolvedValue({
      id: 1,
      public_id: 'user_pub',
      email: 'admin@example.com',
      status: 'ACTIVE',
      is_email_verified: false,
    });
    await setup();
    const userPublicId = generatePublicId('user');
    const accessToken = await signAccessToken({
      userId: userPublicId,
      role: GLOBAL_ROLES.SUPER_ADMIN,
    });

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { role?: string }).role).toBeUndefined();
    await application.close();
  });

  it('route-#6: re-derives a role claim the server does not issue, instead of trusting it', async () => {
    // `admin` was a real GLOBAL_ROLES value until it was removed as never-issued. A token minted
    // before that — or forged, or carrying a typo — must still be re-validated rather than honored
    // for its lifetime. The middleware treats ANY claim that is not `user` as privileged, so a
    // retired or unrecognised value fails closed here; listing the privileged values explicitly
    // would let exactly this token through untouched. resolveGlobalRoleForEmail returns the user's
    // TRUE role; a non-allowlisted account is downgraded to USER.
    vi.mocked(resolveGlobalRoleForEmail).mockReturnValue(undefined);
    await setup();
    const adminUserPublicId = generatePublicId('user');
    const accessToken = await signAccessToken({
      userId: adminUserPublicId,
      role: 'admin',
    });

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    // The retired claim triggered the live re-derivation (not a blind trust)...
    expect(findUserRecordByPublicId).toHaveBeenCalledWith(adminUserPublicId);
    // ...and downgraded to USER since the email is not in the allowlist.
    expect((response.json() as { role?: string }).role).toBe(GLOBAL_ROLES.USER);
    await application.close();
  });

  it('does NOT call findUserRecordByPublicId for a non-admin JWT (hot-path stays unchanged)', async () => {
    vi.mocked(resolveGlobalRoleForEmail).mockReturnValue(undefined);
    await setup();
    const userPublicId = generatePublicId('user');
    const accessToken = await signAccessToken({ userId: userPublicId, role: GLOBAL_ROLES.USER });

    const response = await application.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { role?: string }).role).toBe(GLOBAL_ROLES.USER);
    // Regular USER tokens skip the user lookup — preserves the existing hot-path latency.
    expect(findUserRecordByPublicId).not.toHaveBeenCalled();
    await application.close();
  });
});
