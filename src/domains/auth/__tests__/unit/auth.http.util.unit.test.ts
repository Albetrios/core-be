import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '@/shared/config/env.config.js';
import { SECONDS_PER_DAY } from '@/shared/constants/index.js';
import { OAUTH_STATE_TTL_SECONDS } from '@/shared/constants/ttl.constants.js';
import { NotImplementedError } from '@/shared/errors/index.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  OAUTH_NONCE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearCsrfCookie,
  clearOauthNonceCookie,
  clearSessionCookie,
  getOauthNonceCookieOptions,
  formatSessionCookieValue,
  generateCsrfToken,
  generateRefreshSecret,
  getCsrfCookieOptions,
  getIpAddress,
  getSessionCookieOptions,
  getUserAgent,
  isOauthProviderNotImplementedError,
  parseSessionCookieValue,
  readOauthNonceCookie,
  readRequestOrigin,
  setOauthNonceCookie,
  setSessionCookie,
} from '@/domains/auth/auth.http.util.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

/**
 * `auth.http.util.ts` owns the entire CSRF + session-cookie surface described in
 * `docs/reference/security/csrf-and-session-cookies.md` — cookie flags, the opaque cookie
 * encoding, CSRF/refresh token generation, the OAuth browser-binding nonce, and the client-IP /
 * Origin readers. Every one of those guarantees was previously exercised only *through* routes,
 * so a regression that dropped `sameSite` from the CSRF cookie or made `parseSessionCookieValue`
 * accept a malformed value would very likely still have passed the suite. These cases pin each
 * guarantee individually.
 */

/** Cookie path both the session and CSRF cookies are scoped to (mirrors the module-private const). */
const SESSION_COOKIE_PATH = '/api/v1/auth';
/** Cookie path the single-use OAuth nonce cookie is scoped to. */
const OAUTH_COOKIE_PATH = '/api/v1/auth/oauth';
/** 32 random bytes base64url-encoded is always 43 characters (no `=` padding). */
const BASE64URL_32_BYTE_LENGTH = 43;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function mockReply(): FastifyReply {
  return {
    setCookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
}

function mockRequest(overrides: Record<string, unknown> = {}): FastifyRequest {
  return attachPrincipalScope({
    headers: {},
    cookies: {},
    ip: '203.0.113.7',
    ...overrides,
  }) as unknown as FastifyRequest;
}

describe('auth.http.util — session cookie options', () => {
  it('scopes the session cookie httpOnly, sameSite from config, and to the auth API surface', () => {
    const options = getSessionCookieOptions();
    // httpOnly is the whole point: JS must never be able to read the refresh secret.
    expect(options.httpOnly).toBe(true);
    // sameSite is config-driven (COOKIE_SAMESITE), not hardcoded — a cross-site SPA needs `none`,
    // and hardcoding `strict` made every cookie-authenticated /api/v1/auth route 401 for it.
    expect(options.sameSite).toBe(env.COOKIE_SAMESITE);
    expect(options.path).toBe(SESSION_COOKIE_PATH);
  });

  it('keeps the CSRF cookie on the same sameSite as the session cookie', () => {
    // Double-submit only works if both cookies travel together: a stricter SameSite on either one
    // silently breaks every mutating cross-site call while login still appears to succeed.
    expect(getCsrfCookieOptions().sameSite).toBe(getSessionCookieOptions().sameSite);
  });

  it('drives `secure` from config and bounds maxAge by AUTH_SESSION_MAX_AGE_DAYS', () => {
    const options = getSessionCookieOptions();
    // `secure` is config-driven (COOKIE_SECURE), not hardcoded — production refines it to true.
    expect(options.secure).toBe(env.COOKIE_SECURE);
    // A bounded maxAge: never a session cookie (undefined) and never unbounded.
    expect(options.maxAge).toBe(env.AUTH_SESSION_MAX_AGE_DAYS * SECONDS_PER_DAY);
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it('leaves the CSRF cookie readable by the SPA (NOT httpOnly) for double-submit', () => {
    // The double-submit contract requires the client to read this cookie and mirror it into
    // the `x-csrf-token` header — making it httpOnly would silently break every mutating call.
    expect(getCsrfCookieOptions().httpOnly).toBe(false);
    expect(CSRF_HEADER_NAME).toBe('x-csrf-token');
  });

  it('still applies the secure/sameSite/path/maxAge hardening to the CSRF cookie', () => {
    const csrf = getCsrfCookieOptions();
    const session = getSessionCookieOptions();
    expect(csrf.secure).toBe(env.COOKIE_SECURE);
    expect(csrf.sameSite).toBe(env.COOKIE_SAMESITE);
    expect(csrf.path).toBe(SESSION_COOKIE_PATH);
    // The CSRF token must not outlive the session it protects.
    expect(csrf.maxAge).toBe(session.maxAge);
  });
});

describe('auth.http.util — session cookie value encoding', () => {
  it('round-trips a formatted value back to its two halves', () => {
    const raw = formatSessionCookieValue('sess_abc123', 'refresh-secret-value');
    expect(raw).toBe('sess_abc123.refresh-secret-value');
    expect(parseSessionCookieValue(raw)).toEqual({
      sessionPublicId: 'sess_abc123',
      refreshSecret: 'refresh-secret-value',
    });
  });

  it('returns null for a legacy session-id-only cookie (no separator)', () => {
    // Pre-refresh-secret cookies carried the session id alone; they must be rejected rather
    // than parsed into an empty secret that would compare equal to a missing stored hash.
    expect(parseSessionCookieValue('sess_abc123')).toBeNull();
  });

  it('returns null when either half is empty', () => {
    expect(parseSessionCookieValue('.refresh-secret')).toBeNull();
    expect(parseSessionCookieValue('sess_abc123.')).toBeNull();
    expect(parseSessionCookieValue('.')).toBeNull();
    expect(parseSessionCookieValue('')).toBeNull();
  });

  it('splits on the FIRST separator so extra separators stay inside the secret', () => {
    // The session public id never contains a `.`; the secret half is returned verbatim so a
    // value carrying extra separators cannot be used to smuggle a different session id.
    expect(parseSessionCookieValue('sess_abc123.a.b.c')).toEqual({
      sessionPublicId: 'sess_abc123',
      refreshSecret: 'a.b.c',
    });
  });
});

describe('auth.http.util — token generation', () => {
  it('generates a URL-safe CSRF token of the expected length', () => {
    const token = generateCsrfToken();
    expect(token).toHaveLength(BASE64URL_32_BYTE_LENGTH);
    // base64url only — a `+`, `/`, or `=` would need escaping in a cookie/header round-trip.
    expect(token).toMatch(BASE64URL_PATTERN);
  });

  it('generates a URL-safe refresh secret of the expected length', () => {
    const secret = generateRefreshSecret();
    expect(secret).toHaveLength(BASE64URL_32_BYTE_LENGTH);
    expect(secret).toMatch(BASE64URL_PATTERN);
  });

  it('never repeats a CSRF token or a refresh secret across calls', () => {
    const csrfTokens = new Set(Array.from({ length: 50 }, () => generateCsrfToken()));
    const refreshSecrets = new Set(Array.from({ length: 50 }, () => generateRefreshSecret()));
    // A constant (or seeded) generator here would make every session's CSRF token guessable.
    expect(csrfTokens.size).toBe(50);
    expect(refreshSecrets.size).toBe(50);
  });
});

describe('auth.http.util — cookie writes', () => {
  it('setSessionCookie writes the encoded session value AND refreshes the CSRF cookie', () => {
    const reply = mockReply();
    setSessionCookie(reply, 'sess_abc123', 'refresh-secret-value');

    expect(reply.setCookie).toHaveBeenCalledWith(
      SESSION_COOKIE_NAME,
      'sess_abc123.refresh-secret-value',
      expect.objectContaining({ httpOnly: true, path: SESSION_COOKIE_PATH }),
    );
    // Rotating the session without rotating the CSRF token would leave the old token valid.
    expect(reply.setCookie).toHaveBeenCalledWith(
      CSRF_COOKIE_NAME,
      expect.stringMatching(BASE64URL_PATTERN),
      expect.objectContaining({ httpOnly: false }),
    );
  });

  it('clearSessionCookie clears BOTH cookies, each mirroring its own set', () => {
    const reply = mockReply();
    clearSessionCookie(reply);
    // A clear is itself a Set-Cookie: at `SameSite=none` one that omits the attribute defaults to
    // Lax and the browser drops it cross-site, so the cookie would survive logout.
    expect(reply.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, getSessionCookieOptions());
    expect(reply.clearCookie).toHaveBeenCalledWith(CSRF_COOKIE_NAME, getCsrfCookieOptions());
  });
});

describe('auth.http.util — OAuth nonce cookie', () => {
  it('promotes the nonce cookie to `none` when the session cookies are cross-site', () => {
    // The SPA sets this cookie via a cross-site XHR (`GET /auth/oauth/:provider`). Per RFC 6265bis
    // a browser IGNORES a non-`none` cookie arriving on a cross-site subresource response, so a
    // `lax` nonce would never be stored and every callback would 401 on the nonce check — the exact
    // flow COOKIE_SAMESITE=none exists to make work.
    expect(getOauthNonceCookieOptions().sameSite).toBe(
      env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax',
    );
  });

  it("never uses `strict` — that would block the provider's top-level redirect back", () => {
    expect(getOauthNonceCookieOptions().sameSite).not.toBe('strict');
  });

  it('writes the nonce httpOnly, sameSite=lax, scoped to the callback path and the state TTL', () => {
    const reply = mockReply();
    setOauthNonceCookie(reply, 'nonce-value');
    // sameSite=lax (not strict) so the cookie survives the top-level navigation back from the
    // provider; the TTL matches the Redis `state` so a stale nonce cannot outlive its state.
    expect(reply.setCookie).toHaveBeenCalledWith(OAUTH_NONCE_COOKIE_NAME, 'nonce-value', {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax',
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
  });

  it('reads the nonce back and treats absent or empty values as undefined', () => {
    expect(readOauthNonceCookie(mockRequest({ cookies: { oauth_nonce: 'nonce-value' } }))).toBe(
      'nonce-value',
    );
    expect(readOauthNonceCookie(mockRequest({ cookies: {} }))).toBeUndefined();
    // An empty string must not be treated as a present nonce — it would compare equal to the
    // "no nonce" branch in consumeOAuthState and defeat the browser binding.
    expect(readOauthNonceCookie(mockRequest({ cookies: { oauth_nonce: '' } }))).toBeUndefined();
    expect(readOauthNonceCookie(mockRequest({ cookies: undefined }))).toBeUndefined();
  });

  it('clears the nonce on the OAuth path so it is genuinely single-use', () => {
    const reply = mockReply();
    clearOauthNonceCookie(reply);
    // A mismatched path — or a missing SameSite at `none` — would leave the cookie alive in the
    // browser and replayable, so the clear mirrors the set exactly.
    expect(reply.clearCookie).toHaveBeenCalledWith(
      OAUTH_NONCE_COOKIE_NAME,
      getOauthNonceCookieOptions(),
    );
  });
});

describe('auth.http.util — request readers', () => {
  it('getIpAddress prefers request.ip and falls back to loopback', () => {
    expect(getIpAddress(mockRequest({ ip: '198.51.100.4' }))).toBe('198.51.100.4');
    // Fastify populates `ip` on every real request; the fallback keeps the audit/session write
    // from failing its NOT NULL column when it does not.
    expect(getIpAddress(mockRequest({ ip: undefined }))).toBe('127.0.0.1');
  });

  it('getUserAgent truncates to the varchar(512) column width and normalizes absence to null', () => {
    expect(getUserAgent(mockRequest({ headers: { 'user-agent': 'vitest' } }))).toBe('vitest');
    expect(getUserAgent(mockRequest({ headers: {} }))).toBeNull();
    const oversized = 'a'.repeat(600);
    // Storing the raw header would blow the varchar(512) column and 500 the login.
    expect(getUserAgent(mockRequest({ headers: { 'user-agent': oversized } }))).toHaveLength(512);
  });

  it('readRequestOrigin returns the header and undefined for non-browser callers', () => {
    expect(readRequestOrigin(mockRequest({ headers: { origin: 'https://app.example.com' } }))).toBe(
      'https://app.example.com',
    );
    expect(readRequestOrigin(mockRequest({ headers: {} }))).toBeUndefined();
    // An empty Origin must read as absent, not as an origin that could match an empty allowlist entry.
    expect(readRequestOrigin(mockRequest({ headers: { origin: '' } }))).toBeUndefined();
  });
});

describe('auth.http.util — OAuth provider-not-implemented detection', () => {
  it('detects every shape the provider adapters throw', () => {
    expect(
      isOauthProviderNotImplementedError(new NotImplementedError('errors:notImplemented')),
    ).toBe(true);
    expect(isOauthProviderNotImplementedError({ statusCode: 501 })).toBe(true);
    expect(isOauthProviderNotImplementedError({ name: 'NotImplementedError' })).toBe(true);
    expect(isOauthProviderNotImplementedError(new Error('provider not supported'))).toBe(true);
  });

  it('does not swallow unrelated failures as a 501', () => {
    // Misclassifying a real provider/network failure as "not implemented" would hide an outage
    // behind a feature-request message instead of surfacing the 5xx.
    expect(isOauthProviderNotImplementedError(new Error('token exchange failed'))).toBe(false);
    expect(isOauthProviderNotImplementedError({ statusCode: 500 })).toBe(false);
    expect(isOauthProviderNotImplementedError(undefined)).toBe(false);
  });
});

describe('auth.http.util — cookie clears mirror their sets', () => {
  // A clear is itself a Set-Cookie. At `SameSite=none` a clear that omits the attribute defaults to
  // Lax, so the browser drops it in the cross-site context and the cookie survives logout —
  // leaving a credential-shaped value in the jar. @fastify/cookie overrides expires/maxAge/signed
  // and passes everything else through, so handing it the full options object is safe.
  it('clearSessionCookie carries the session cookie attributes', () => {
    const reply = mockReply();
    clearSessionCookie(reply);
    const [name, options] = (reply.clearCookie as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, Record<string, unknown>];
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(options.sameSite).toBe(getSessionCookieOptions().sameSite);
    expect(options.secure).toBe(env.COOKIE_SECURE);
    expect(options.path).toBe(SESSION_COOKIE_PATH);
  });

  it('clearCsrfCookie carries the CSRF cookie attributes', () => {
    const reply = mockReply();
    clearCsrfCookie(reply);
    const [name, options] = (reply.clearCookie as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, Record<string, unknown>];
    expect(name).toBe(CSRF_COOKIE_NAME);
    expect(options.sameSite).toBe(getCsrfCookieOptions().sameSite);
    expect(options.path).toBe(SESSION_COOKIE_PATH);
  });

  it('clearOauthNonceCookie carries the nonce cookie attributes', () => {
    const reply = mockReply();
    clearOauthNonceCookie(reply);
    const [name, options] = (reply.clearCookie as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, Record<string, unknown>];
    expect(name).toBe(OAUTH_NONCE_COOKIE_NAME);
    expect(options.sameSite).toBe(getOauthNonceCookieOptions().sameSite);
    expect(options.path).toBe(OAUTH_COOKIE_PATH);
  });
});
