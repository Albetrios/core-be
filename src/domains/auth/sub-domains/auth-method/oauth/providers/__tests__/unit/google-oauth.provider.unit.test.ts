import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError } from '@/shared/errors/index.js';
import {
  buildGoogleOAuthRedirectUrl,
  exchangeGoogleOAuthCode,
} from '@/domains/auth/sub-domains/auth-method/oauth/providers/google-oauth.provider.js';

vi.mock('@/shared/config/env.config.js', async () => {
  const actual = await vi.importActual<typeof import('@/shared/config/env.config.js')>(
    '@/shared/config/env.config.js',
  );
  return {
    ...actual,
    env: {
      ...actual.env,
      OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
      OAUTH_GOOGLE_REDIRECT_URI: 'https://app.example/callback/google',
    },
  };
});

const outboundFetch = vi.fn();

vi.mock('@/infrastructure/outbound/index.js', () => ({
  outboundFetch: (...args: unknown[]) => outboundFetch(...args),
  buildOutboundFetchOptions: (options: unknown) => options,
}));

function jsonResponse(body: unknown) {
  return { json: async () => body } as Response;
}

describe('exchangeGoogleOAuthCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds an authorize URL carrying the PKCE S256 code_challenge', () => {
    const url = new URL(buildGoogleOAuthRedirectUrl('state-token', 'the-code-challenge'));
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(url.searchParams.get('code_challenge')).toBe('the-code-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('returns a normalised profile when Google reports a verified email', async () => {
    outboundFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'google-access-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          sub: 'google-sub-123',
          email: 'user@example.com',
          email_verified: true,
          name: 'Example User',
          picture: 'https://example.com/avatar.png',
        }),
      );

    const profile = await exchangeGoogleOAuthCode({ code: 'auth-code', codeVerifier: 'verifier' });

    expect(profile).toEqual({
      email: 'user@example.com',
      name: 'Example User',
      avatar_url: 'https://example.com/avatar.png',
      provider_user_id: 'google-sub-123',
    });

    const tokenRequest = outboundFetch.mock.calls[0]?.[0] as { init: { body: URLSearchParams } };
    expect(tokenRequest.init.body.get('code_verifier')).toBe('verifier');
  });

  it('rejects when email_verified is false (account-takeover guard)', async () => {
    outboundFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'google-access-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          sub: 'attacker-sub',
          email: 'victim@example.com',
          email_verified: false,
          name: 'Attacker',
        }),
      );

    const error = await exchangeGoogleOAuthCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({ messageKey: 'errors:googleEmailNotVerified' });
  });

  it('rejects when email_verified is absent (defaults to unverified)', async () => {
    outboundFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'google-access-token' }))
      .mockResolvedValueOnce(jsonResponse({ sub: 'google-sub-456', email: 'victim@example.com' }));

    await expect(
      exchangeGoogleOAuthCode({ code: 'auth-code', codeVerifier: 'verifier' }),
    ).rejects.toMatchObject({
      messageKey: 'errors:googleEmailNotVerified',
    });
  });
});
