import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * sec-r5-followup-tc-3 regression — every credential-sensitive auth / MFA /
 * WebAuthn route MUST carry `STRICT_AUTHED_RATE_LIMIT` so a hijacked session
 * cannot churn password / MFA / passkey operations. The Round 5 preset-shape
 * test in `preset-authed-burst.security.test.ts` covers the PRESET; this test
 * covers the per-route APPLICATION. A future routes refactor that quietly
 * drops `...STRICT_AUTHED_RATE_LIMIT` from one of these specific entries
 * would fail here.
 *
 * Mirrors the policy-test pattern from sec-r4-I1/I2/I3
 * (`*-routes-rate-limit.policy.unit.test.ts`).
 */
describe('auth routes rate-limit policy (sec-r5-followup-tc-3)', () => {
  const authRoutesPath = join(process.cwd(), 'src/domains/auth/auth.routes.ts');
  const source = readFileSync(authRoutesPath, 'utf8');

  function findRouteBlock(httpMethod: string, urlLiteral: string): string {
    const escapedUrl = urlLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `zodApplication.<method>('<url>', { ... }`. Allow optional generic
    // params after the method (e.g. `zodApplication.delete<{ Params: ... }>`).
    const pattern = new RegExp(
      `zodApplication\\.${httpMethod}(?:<[^>]*>)?\\(\\s*'${escapedUrl}',\\s*\\{([\\s\\S]*?)\\n\\s{4,6}\\},\\n\\s{4,6}\\w`,
      'm',
    );
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`route block not found: ${httpMethod.toUpperCase()} ${urlLiteral}`);
    }
    return match[1] ?? '';
  }

  const STRICT_AUTHED_ROUTES: Array<{ method: string; url: string; description: string }> = [
    { method: 'post', url: '/password/change', description: 'authenticated password change' },
    { method: 'post', url: '/step-up', description: 'recent-step-up re-auth' },
    { method: 'post', url: '/me/mfa/enroll', description: 'MFA enrollment phase 1' },
    {
      method: 'post',
      url: '/me/mfa/enroll/confirm',
      description: 'MFA enrollment phase 2 (returns recovery codes)',
    },
    {
      method: 'post',
      url: '/me/webauthn/register/options',
      description: 'WebAuthn register options',
    },
    {
      method: 'post',
      url: '/me/webauthn/register/verify',
      description: 'WebAuthn register verify',
    },
  ];

  for (const route of STRICT_AUTHED_ROUTES) {
    it(`${route.method.toUpperCase()} ${route.url} has STRICT_AUTHED_RATE_LIMIT applied (${route.description})`, () => {
      const block = findRouteBlock(route.method, route.url);
      expect(block).toContain('...STRICT_AUTHED_RATE_LIMIT');
    });
  }
});

/**
 * Public-surface go-live guard — the UNAUTHENTICATED auth routes are the highest brute-force /
 * enumeration target. Their rate-limit / CAPTCHA / per-email throttle wiring lives only in the
 * route source (the burst-shape preset tests run on a throwaway app, not the real routes, because
 * the test env lifts public caps to 5000). A refactor that quietly dropped a preset or preHandler
 * from one of these specific public routes would silently reopen brute-force / enumeration and
 * pass every other test — this source-scan policy fails on exactly that.
 */
describe('auth public-route rate-limit + captcha policy (public go-live surface)', () => {
  const authRoutesPath = join(process.cwd(), 'src/domains/auth/auth.routes.ts');
  const source = readFileSync(authRoutesPath, 'utf8');

  // Captures the first `{ ... }` options object of a `zodApplication.<method>('<url>', { ... }`
  // registration via brace matching, so it works for both the 2-arg (handler-inside-options) and
  // 3-arg (handler-as-third-arg) call shapes used across auth.routes.ts.
  function findRouteOptionsObject(httpMethod: string, urlLiteral: string): string {
    const escapedUrl = urlLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callPattern = new RegExp(
      `zodApplication\\.${httpMethod}(?:<[^>]*>)?\\(\\s*'${escapedUrl}'\\s*,`,
    );
    const callMatch = callPattern.exec(source);
    if (!callMatch) {
      throw new Error(`route registration not found: ${httpMethod.toUpperCase()} ${urlLiteral}`);
    }
    const objectStart = source.indexOf('{', callMatch.index + callMatch[0].length);
    if (objectStart === -1) {
      throw new Error(`options object not found: ${httpMethod.toUpperCase()} ${urlLiteral}`);
    }
    let depth = 0;
    for (let index = objectStart; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(objectStart, index + 1);
      }
    }
    throw new Error(`unbalanced options object: ${httpMethod.toUpperCase()} ${urlLiteral}`);
  }

  // IP-keyed strict public cap — must be present on every unauthenticated credential / token /
  // outbound-email / OAuth route so brute-force and enumeration cannot run unbounded.
  const STRICT_PUBLIC_ROUTES: Array<{ method: string; url: string }> = [
    { method: 'post', url: '/login' },
    { method: 'post', url: '/email/send-code' },
    { method: 'post', url: '/email/login' },
    { method: 'post', url: '/password/forgot' },
    { method: 'post', url: '/password/reset' },
    { method: 'post', url: '/mfa/login' },
    { method: 'post', url: '/webauthn/authenticate/options' },
    { method: 'post', url: '/webauthn/authenticate/verify' },
    { method: 'get', url: '/oauth/providers' },
    { method: 'get', url: '/oauth/:provider' },
    { method: 'get', url: '/oauth/:provider/callback' },
  ];
  for (const route of STRICT_PUBLIC_ROUTES) {
    it(`${route.method.toUpperCase()} ${route.url} carries STRICT_PUBLIC_RATE_LIMIT`, () => {
      expect(findRouteOptionsObject(route.method, route.url)).toContain(
        '...STRICT_PUBLIC_RATE_LIMIT',
      );
    });
  }

  // CAPTCHA (Turnstile) on the public credential / outbound-email / OAuth-initiation forms.
  const CAPTCHA_PROTECTED_ROUTES: Array<{ method: string; url: string }> = [
    { method: 'post', url: '/login' },
    { method: 'post', url: '/email/send-code' },
    { method: 'post', url: '/email/login' },
    { method: 'post', url: '/password/forgot' },
    { method: 'post', url: '/password/reset' },
    { method: 'post', url: '/mfa/login' },
    { method: 'post', url: '/webauthn/authenticate/options' },
    { method: 'get', url: '/oauth/:provider' },
  ];
  for (const route of CAPTCHA_PROTECTED_ROUTES) {
    it(`${route.method.toUpperCase()} ${route.url} carries captchaPreHandler`, () => {
      expect(findRouteOptionsObject(route.method, route.url)).toContain('captchaPreHandler');
    });
  }

  // Per-identity (per-email) throttle layered on the IP cap so spoofed-IP rotation cannot bypass
  // the public limit on the highest-value credential / email-sending endpoints.
  const PER_EMAIL_THROTTLED_ROUTES: Array<{ method: string; url: string }> = [
    { method: 'post', url: '/login' },
    { method: 'post', url: '/email/send-code' },
    { method: 'post', url: '/password/forgot' },
    { method: 'post', url: '/webauthn/authenticate/options' },
  ];
  for (const route of PER_EMAIL_THROTTLED_ROUTES) {
    it(`${route.method.toUpperCase()} ${route.url} carries the per-email throttle`, () => {
      expect(findRouteOptionsObject(route.method, route.url)).toContain('perEmailRateLimit');
    });
  }

  it('POST /refresh carries REFRESH_RATE_LIMIT', () => {
    expect(findRouteOptionsObject('post', '/refresh')).toContain('...REFRESH_RATE_LIMIT');
  });

  // The organization-switch POSTs each re-mint a JWT and hit the DB per call, so they carry a per-user
  // MODERATE cap (not left on the global limiter alone). Pins the preset against a silent drop.
  for (const url of ['/switch-to-personal', '/switch-to-organization']) {
    it(`POST ${url} carries MODERATE_AUTHED_RATE_LIMIT`, () => {
      expect(findRouteOptionsObject('post', url)).toContain('...MODERATE_AUTHED_RATE_LIMIT');
    });
  }
});
