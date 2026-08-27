import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { NotImplementedError, UnauthorizedError, ValidationError } from '@/shared/errors/index.js';
import { createAuthController } from '@/domains/auth/auth.controller.js';
import { createAuthLoginHandlers } from '@/domains/auth/handlers/auth-login.handlers.js';
import { createAuthSessionHandlers } from '@/domains/auth/handlers/auth-session.handlers.js';
import { createAuthEmailLoginHandlers } from '@/domains/auth/handlers/auth-email-login.handlers.js';
import { createAuthOauthHandlers } from '@/domains/auth/handlers/auth-oauth.handlers.js';
import { createAuthAuthMethodHandlers } from '@/domains/auth/handlers/auth-auth-method.handlers.js';
import { createAuthMfaHandlers } from '@/domains/auth/handlers/auth-mfa.handlers.js';
import { createAuthWebauthnHandlers } from '@/domains/auth/handlers/auth-webauthn.handlers.js';
import { createAuthMeContextHandlers } from '@/domains/auth/handlers/auth-me-context.handlers.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { attachPrincipalScopeGetters } from '@/tests/helpers/principal-scope-getters.helper.js';

vi.mock('@/shared/middlewares/session/cookie-session-origin.pre-handler.js', () => ({
  requireAllowedSourceOriginForCookieSessionRoute: vi.fn(),
}));

vi.mock('@/shared/utils/auth/recent-step-up.util.js', () => ({
  recordRecentStepUp: vi.fn().mockResolvedValue(undefined),
}));

/**
 * NOTE: `DATABASE_URL` and the SSL/timeout fields are required because auth handlers
 * import `audit-request-context.util.ts`, which now imports `user-database.context.ts`
 * for scoped-RLS audit lookups. That transitively pulls in
 * `infrastructure/database/connection.ts` at module-init time, and
 * `parseSslMode(env.DATABASE_URL)` crashes on `undefined`.
 *
 * The factory is hoisted by vitest, so the object is inlined (no external refs).
 */
vi.mock('@/shared/config/env.config.js', () => {
  const env = {
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    AUTH_SESSION_MAX_AGE_DAYS: 7,
    COOKIE_SECURE: false,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    DATABASE_SSL_ENABLED: false,
    DATABASE_SSL_REJECT_UNAUTHORIZED: false,
    DATABASE_HTTP_STATEMENT_TIMEOUT_MS: 5_000,
    DATABASE_STATEMENT_TIMEOUT_MS: 30_000,
  } as const;
  return { env, getEnv: () => env };
});

function mockRequest(overrides: Record<string, unknown> = {}): never {
  return attachPrincipalScopeGetters({
    auth: {
      kind: 'user' as const,
      userId: generatePublicId('user'),
      role: 'user',
      sessionPublicId: generatePublicId('authSession'),
    },
    params: {},
    body: {},
    query: {},
    headers: { 'user-agent': 'vitest' },
    cookies: {},
    ip: '127.0.0.1',
    id: 'request-id',
    t: (key: string) => key,
    server: {
      auditDomain: {
        auditService: { record: vi.fn().mockResolvedValue(undefined) },
      },
    },
    log: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  }) as never;
}

function mockReply(): FastifyReply {
  return {
    setCookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
}

describe('createAuthController', () => {
  const authService = {
    login: vi.fn().mockResolvedValue({
      access_token: 'token',
      session_public_id: 'session',
      session_refresh_secret: 'refresh-secret',
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshToken: vi
      .fn()
      .mockResolvedValue({ access_token: 'new-token', refresh_secret: 'new-refresh-secret' }),
    resetPassword: vi.fn().mockResolvedValue({
      access_token: 'token',
      session_public_id: 'session',
      session_refresh_secret: 'refresh-secret',
    }),
  };

  const authMethodService = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 1 }),
    delete: vi.fn().mockResolvedValue(undefined),
    forgotPassword: vi.fn().mockResolvedValue({ messageKey: 'success:forgotPassword' }),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue(undefined),
  };

  const emailLoginService = {
    sendCode: vi
      .fn()
      .mockResolvedValue({ messageKey: 'success:verificationCodeSent', expires_in_minutes: 15 }),
    login: vi.fn().mockResolvedValue({
      access_token: 'token',
      session_public_id: 'session',
      session_refresh_secret: 'refresh-secret',
    }),
  };

  const oauthService = {
    listProviders: vi.fn().mockReturnValue({ providers: ['google', 'github'] }),
    getRedirectUrl: vi
      .fn()
      .mockResolvedValue({ redirect_url: 'https://oauth.example/authorize', nonce: 'oauth-nonce' }),
    handleCallback: vi.fn().mockResolvedValue({
      access_token: 'token',
      session_public_id: 'session',
      session_refresh_secret: 'refresh-secret',
    }),
  };

  const mfaService = {
    verify: vi.fn().mockResolvedValue({ verified: true }),
    // sec-A finding #3: two-phase enrollment. `enrollInit` stages the secret in Redis and
    // returns only `{ secret, provisioning_uri }`; `enrollConfirm` verifies a code and
    // returns the freshly minted plaintext recovery codes plus the method_id.
    enrollInit: vi.fn().mockResolvedValue({ secret: 'secret', provisioning_uri: 'uri' }),
    enrollConfirm: vi.fn().mockResolvedValue({
      recovery_codes: ['CODE1', 'CODE2'],
      method_public_id: 'testmethodpub000000a',
    }),
    verifyLoginMfa: vi.fn().mockResolvedValue({
      access_token: 'token',
      session_public_id: 'session',
      session_refresh_secret: 'refresh-secret',
    }),
    listMfaMethods: vi.fn().mockResolvedValue([]),
    deleteMfa: vi.fn().mockResolvedValue(undefined),
  };

  const authSessionService = {
    list: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue(undefined),
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    revokeAllSessionsExceptCurrent: vi.fn().mockResolvedValue(undefined),
  };

  const webauthnService = {
    generateRegistrationOptions: vi.fn(),
    verifyRegistration: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthentication: vi.fn(),
  };

  const controller = createAuthController({
    authService: authService as never,
    authMethodService: authMethodService as never,
    emailLoginService: emailLoginService as never,
    oauthService: oauthService as never,
    mfaService: mfaService as never,
    webauthnService: webauthnService as never,
    authSessionService: authSessionService as never,
    authMeContextService: { getContext: vi.fn() } as never,
  });

  it('login sets session cookie and returns token', async () => {
    const reply = mockReply();
    await controller.login(mockRequest({ body: { email: 'a@b.com', password: 'pass' } }), reply);
    expect(authService.login).toHaveBeenCalled();
    expect(reply.setCookie).toHaveBeenCalled();
  });

  it('logout requires bearer token and clears cookie', async () => {
    const reply = mockReply();
    await controller.logout(
      mockRequest({ headers: { authorization: 'Bearer access-token', 'user-agent': 'vitest' } }),
      reply,
    );
    expect(authService.logout).toHaveBeenCalledWith('access-token');
    expect(reply.clearCookie).toHaveBeenCalled();
  });

  it('logout rejects missing authorization header', async () => {
    await expect(controller.logout(mockRequest(), mockReply())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('email login handlers delegate to the email login service', async () => {
    const loginReply = mockReply();
    await controller.sendEmailCode(
      mockRequest({ body: { email: 'user@example.com' } }),
      mockReply(),
    );
    await controller.emailLogin(
      mockRequest({ body: { email: 'user@example.com', code: 'ABCDEF' } }),
      loginReply,
    );
    expect(emailLoginService.sendCode).toHaveBeenCalled();
    expect(loginReply.setCookie).toHaveBeenCalled();
  });

  it('oauth handlers delegate to oauth service', async () => {
    await controller.listOauthProviders(mockRequest(), mockReply());
    await controller.oauthRedirect(mockRequest({ params: { provider: 'google' } }), mockReply());
    const callbackReply = mockReply();
    await controller.oauthCallback(
      mockRequest({
        params: { provider: 'google' },
        query: { code: 'code', state: 'state' },
      }),
      callbackReply,
    );
    expect(oauthService.listProviders).toHaveBeenCalled();
    expect(oauthService.getRedirectUrl).toHaveBeenCalled();
    expect(callbackReply.setCookie).toHaveBeenCalled();
  });

  it('oauthRedirect returns 501 for not implemented providers', async () => {
    vi.mocked(oauthService.getRedirectUrl).mockRejectedValueOnce(
      new NotImplementedError('errors:notImplemented'),
    );
    const reply = mockReply();
    await controller.oauthRedirect(mockRequest({ params: { provider: 'unknown' } }), reply);
    expect(reply.status).toHaveBeenCalledWith(501);
  });

  it('MFA handlers delegate to mfa service', async () => {
    const loginReply = mockReply();
    await controller.enrollMfa(mockRequest({ body: { method_type: 'MFA_TOTP' } }), mockReply());
    // sec-A finding #3: confirm is a separate handler at POST /auth/me/mfa/enroll/confirm.
    await controller.confirmEnrollMfa(mockRequest({ body: { code: '123456' } }), mockReply());
    await controller.verifyMfa(mockRequest({ body: { code: '123456' } }), mockReply());
    await controller.verifyMfaLogin(
      mockRequest({ body: { mfa_session_token: 'session-token', totp_code: '123456' } }),
      loginReply,
    );
    await controller.listMfaMethods(mockRequest(), mockReply());
    const deleteReply = mockReply();
    await controller.deleteMfa(
      mockRequest({ params: { mfa_method_id: 'mfa_a1b2c3d4e5f6g7h8i9j0k' } }),
      deleteReply,
    );
    expect(mfaService.enrollInit).toHaveBeenCalled();
    expect(mfaService.enrollConfirm).toHaveBeenCalled();
    expect(mfaService.verifyLoginMfa).toHaveBeenCalled();
    expect(deleteReply.code).toHaveBeenCalledWith(204);
  });

  it('verifyMfaLogin returns session_id and sets session cookie', async () => {
    const loginReply = mockReply();
    const responsePayload = await controller.verifyMfaLogin(
      mockRequest({ body: { mfa_session_token: 'session-token', totp_code: '123456' } }),
      loginReply,
    );
    expect(responsePayload.data).toMatchObject({
      access_token: 'token',
      session_id: 'session',
    });
    expect(loginReply.setCookie).toHaveBeenCalledWith(
      'session_id',
      'session.refresh-secret',
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('auth method and session handlers delegate to services', async () => {
    await controller.listAuthMethods(mockRequest(), mockReply());
    await controller.createAuthMethod(mockRequest({ body: { type: 'password' } }), mockReply());
    const deleteMethodReply = mockReply();
    await controller.deleteAuthMethod(
      mockRequest({ params: { auth_method_id: 'am_a1b2c3d4e5f6g7h8i9j0k' } }),
      deleteMethodReply,
    );
    await controller.listSessions(mockRequest(), mockReply());
    const revokeReply = mockReply();
    await controller.revokeSession(
      mockRequest({ params: { organization_id: generatePublicId('organization') } }),
      revokeReply,
    );
    expect(authMethodService.list).toHaveBeenCalled();
    expect(authSessionService.revoke).toHaveBeenCalled();
  });

  it('password and email verification handlers delegate to auth method service', async () => {
    await controller.forgotPassword(mockRequest({ body: { email: 'a@b.com' } }), mockReply());
    const resetReply = mockReply();
    await controller.resetPassword(
      mockRequest({ body: { token: 't', password: 'p' } }),
      resetReply,
    );
    const changeReply = mockReply();
    await controller.changePassword(mockRequest({ body: { password: 'new' } }), changeReply);
    // Reset now auto-logs-in via authService: it sets the session cookie instead of returning 204.
    expect(authService.resetPassword).toHaveBeenCalled();
    expect(resetReply.setCookie).toHaveBeenCalled();
  });

  it('refreshToken uses session cookie and revokeAllSessions does NOT clear the cookie', async () => {
    // sec-r4-A1: revokeAllSessions must NOT call clearSessionCookie — the caller's
    // own session is preserved (sec-new-A3) so the browser cookie must remain intact.
    const refreshReply = mockReply();
    await controller.refreshToken(
      mockRequest({ cookies: { session_id: 'session.refresh-secret' } }),
      refreshReply,
    );
    const revokeAllReply = mockReply();
    await controller.revokeAllSessions(mockRequest(), revokeAllReply);
    expect(authService.refreshToken).toHaveBeenCalledWith({
      sessionPublicId: 'session',
      refreshSecret: 'refresh-secret',
    });
    expect(refreshReply.setCookie).toHaveBeenCalledWith(
      'session_id',
      'session.new-refresh-secret',
      expect.objectContaining({ httpOnly: true }),
    );
    // The cookie must NOT be cleared — the caller's preserved session still needs it.
    expect(revokeAllReply.clearCookie).not.toHaveBeenCalled();
  });

  it('refreshToken rejects missing session cookie', async () => {
    await expect(controller.refreshToken(mockRequest(), mockReply())).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('deleteAuthMethod rejects invalid publicId param (too short)', async () => {
    await expect(
      controller.deleteAuthMethod(mockRequest({ params: { publicId: '0' } }), mockReply()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('logout rejects malformed bearer authorization header', async () => {
    await expect(
      controller.logout(
        mockRequest({ headers: { authorization: 'NotBearer token-value' } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('oauthRedirect returns 501 when provider is not supported', async () => {
    vi.mocked(oauthService.getRedirectUrl).mockRejectedValueOnce(
      new NotImplementedError('errors:notImplemented'),
    );
    const reply = mockReply();
    await controller.oauthRedirect(
      mockRequest({
        params: { provider: 'unknown' },
        t: vi.fn((key: string) => key) as never,
      }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(501);
  });

  it('oauthRedirect rethrows unexpected errors', async () => {
    vi.mocked(oauthService.getRedirectUrl).mockRejectedValueOnce(new Error('upstream failure'));
    await expect(
      controller.oauthRedirect(mockRequest({ params: { provider: 'google' } }), mockReply()),
    ).rejects.toThrow('upstream failure');
  });

  it('forgotPassword uses i18next when request.t is absent', async () => {
    const responsePayload = await controller.forgotPassword(
      mockRequest({ body: { email: 'a@b.com' }, t: undefined }),
      mockReply(),
    );
    expect(responsePayload.data).toHaveProperty('message');
  });

  it('emailLogin skips session cookie when session_public_id is absent', async () => {
    vi.mocked(emailLoginService.login).mockResolvedValueOnce({
      access_token: 'token-only',
    } as never);
    const reply = mockReply();
    await controller.emailLogin(mockRequest({ body: { email: 'a@b.com', code: 'ABCDEF' } }), reply);
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  it('oauthCallback sets session cookie and returns access token payload', async () => {
    const callbackReply = mockReply();
    await controller.oauthCallback(
      mockRequest({
        params: { provider: 'google' },
        query: { code: 'auth-code', state: 'state' },
      }),
      callbackReply,
    );
    expect(oauthService.handleCallback).toHaveBeenCalled();
    expect(callbackReply.setCookie).toHaveBeenCalled();
  });

  it('oauthRedirect returns 501 when error name is NotImplementedError', async () => {
    const notImplemented = new Error('not implemented');
    notImplemented.name = 'NotImplementedError';
    vi.mocked(oauthService.getRedirectUrl).mockRejectedValueOnce(notImplemented);
    const reply = mockReply();
    await controller.oauthRedirect(
      mockRequest({ params: { provider: 'unknown' }, t: vi.fn((key: string) => key) }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(501);
  });

  it('oauthRedirect returns 501 for plain errors with statusCode 501', async () => {
    vi.mocked(oauthService.getRedirectUrl).mockRejectedValueOnce({ statusCode: 501 });
    const reply = mockReply();
    await controller.oauthRedirect(
      mockRequest({ params: { provider: 'unknown' }, t: vi.fn((key: string) => key) }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(501);
  });

  it('oauthRedirect returns 501 for errors that include not supported message', async () => {
    vi.mocked(oauthService.getRedirectUrl).mockRejectedValueOnce(
      Object.assign(new Error('provider not supported'), { name: 'NotImplementedError' }),
    );
    const reply = mockReply();
    await controller.oauthRedirect(
      mockRequest({ params: { provider: 'unknown' }, t: vi.fn((key: string) => key) }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(501);
  });

  // sec-new-A3: DELETE /me/sessions must preserve the caller's current session.
  // sec-r4-A1: the session cookie must NOT be cleared — clearing it would invalidate
  // the preserved session's browser-side refresh token even though the DB row survives.
  it('revokeAllSessions calls revokeAllSessionsExceptCurrent with bearer token, skips revokeAllSessions, and does NOT clear the cookie (sec-new-A3 + sec-r4-A1)', async () => {
    const reply = mockReply();
    await controller.revokeAllSessions(
      mockRequest({
        headers: { authorization: 'Bearer current-session-token', 'user-agent': 'vitest' },
      }),
      reply,
    );
    expect(authSessionService.revokeAllSessionsExceptCurrent).toHaveBeenCalledWith({
      userPublicId: expect.any(String),
      currentAccessToken: 'current-session-token',
    });
    expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
    // Cookie must NOT be cleared — the preserved session still needs it.
    expect(reply.clearCookie).not.toHaveBeenCalled();
  });

  it('revokeAllSessions falls back to empty token when Authorization header is absent, does not clear cookie (sec-new-A3 + sec-r4-A1)', async () => {
    vi.mocked(authSessionService.revokeAllSessionsExceptCurrent).mockClear();
    const reply = mockReply();
    await controller.revokeAllSessions(mockRequest(), reply);
    expect(authSessionService.revokeAllSessionsExceptCurrent).toHaveBeenCalledWith({
      userPublicId: expect.any(String),
      currentAccessToken: '',
    });
    // Cookie must NOT be cleared — the caller's preserved session still needs it.
    expect(reply.clearCookie).not.toHaveBeenCalled();
  });

  it('sendEmailCode uses i18next fallback when request.t is absent', async () => {
    const responsePayload = await controller.sendEmailCode(
      mockRequest({ body: { email: 'a@b.com' }, t: undefined }),
      mockReply(),
    );
    expect(responsePayload.data).toHaveProperty('message');
  });

  it('login uses secure session cookies when COOKIE_SECURE is enabled', async () => {
    const { env } = await import('@/shared/config/env.config.js');
    const previousCookieSecure = env.COOKIE_SECURE;
    Object.assign(env, { COOKIE_SECURE: true });
    const reply = mockReply();
    await controller.login(
      mockRequest({ body: { email: 'a@b.com', password: 'pass' }, ip: undefined }),
      reply,
    );
    expect(reply.setCookie).toHaveBeenCalledWith(
      'session_id',
      expect.any(String),
      expect.objectContaining({ secure: true }),
    );
    Object.assign(env, { COOKIE_SECURE: previousCookieSecure });
  });

  it('oauthRedirect uses i18next fallback when request.t is absent', async () => {
    vi.mocked(oauthService.getRedirectUrl).mockRejectedValueOnce(
      new NotImplementedError('errors:notImplemented'),
    );
    const reply = mockReply();
    await controller.oauthRedirect(
      mockRequest({ params: { provider: 'unknown' }, t: undefined }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(501);
  });

  it('oauthCallback omits session cookie when session_public_id is absent', async () => {
    vi.mocked(oauthService.handleCallback).mockResolvedValueOnce({
      access_token: 'token-only',
    } as never);
    const reply = mockReply();
    await controller.oauthCallback(
      mockRequest({
        params: { provider: 'google' },
        query: { code: 'auth-code', state: 'oauth-state' },
      }),
      reply,
    );
    expect(oauthService.handleCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        code: 'auth-code',
        state: 'oauth-state',
        ipAddress: '127.0.0.1',
        userAgent: 'vitest',
      }),
    );
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  it('deleteAuthMethod rejects publicId with wrong format (uppercase)', async () => {
    await expect(
      controller.deleteAuthMethod(
        mockRequest({ params: { publicId: 'INVALIDFORMAT123456789' } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('forgotPassword returns raw payload when messageKey is absent', async () => {
    vi.mocked(authMethodService.forgotPassword).mockResolvedValueOnce({
      message: 'raw-response',
    } as never);
    const responsePayload = await controller.forgotPassword(
      mockRequest({ body: { email: 'a@b.com' } }),
      mockReply(),
    );
    expect(responsePayload.data).toEqual({ message: 'raw-response' });
  });

  /**
   * The eight `handlers/*.ts` factories are exercised transitively by the cases above, but nothing
   * asserted the composition itself. `createAuthController` is a flat spread of eight factory
   * results — dropping one line silently removes a whole flow's handlers, and the failure only
   * surfaces at route-registration time as an `undefined` handler.
   */
  describe('handler composition', () => {
    const container = {
      authService: authService as never,
      authMethodService: authMethodService as never,
      emailLoginService: emailLoginService as never,
      oauthService: oauthService as never,
      mfaService: mfaService as never,
      webauthnService: webauthnService as never,
      authSessionService: authSessionService as never,
      authMeContextService: { getContext: vi.fn() } as never,
    };

    const handlerFactories = [
      createAuthLoginHandlers,
      createAuthSessionHandlers,
      createAuthEmailLoginHandlers,
      createAuthOauthHandlers,
      createAuthAuthMethodHandlers,
      createAuthMfaHandlers,
      createAuthWebauthnHandlers,
      createAuthMeContextHandlers,
    ];

    it('exposes every handler contributed by all eight factories', () => {
      const composed = createAuthController(container);
      for (const factory of handlerFactories) {
        const contributed = Object.keys(factory(container));
        // A factory that contributes nothing would make this assertion vacuous.
        expect(contributed.length).toBeGreaterThan(0);
        for (const handlerName of contributed) {
          expect(composed).toHaveProperty(handlerName);
          expect(composed[handlerName as keyof typeof composed]).toBeTypeOf('function');
        }
      }
    });

    it('composes exactly the union of the factories — no extra and no shadowed handler', () => {
      const composed = createAuthController(container);
      const union = new Set(handlerFactories.flatMap((factory) => Object.keys(factory(container))));
      // Equal counts prove no factory was dropped AND that two factories are not fighting over
      // the same handler name (the later spread would silently win).
      expect(Object.keys(composed).sort()).toEqual([...union].sort());
    });
  });
});
