import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError } from '@/shared/errors/index.js';
import {
  buildGitHubOAuthRedirectUrl,
  exchangeGitHubOAuthCode,
} from '@/domains/auth/sub-domains/auth-method/oauth/providers/github-oauth.provider.js';

vi.mock('@/shared/config/env.config.js', async () => {
  const actual = await vi.importActual<typeof import('@/shared/config/env.config.js')>(
    '@/shared/config/env.config.js',
  );
  return {
    ...actual,
    env: {
      ...actual.env,
      OAUTH_GITHUB_CLIENT_ID: 'github-client-id',
      OAUTH_GITHUB_CLIENT_SECRET: 'github-client-secret',
      OAUTH_GITHUB_REDIRECT_URI: 'https://app.example/callback/github',
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

describe('exchangeGitHubOAuthCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds an authorize URL carrying the PKCE S256 code_challenge', () => {
    const url = new URL(buildGitHubOAuthRedirectUrl('state-token', 'the-code-challenge'));
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(url.searchParams.get('code_challenge')).toBe('the-code-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('returns a normalised profile using the primary verified email', async () => {
    outboundFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'github-access-token' }))
      .mockResolvedValueOnce(
        jsonResponse({ id: 4242, name: 'Octo Cat', avatar_url: 'https://github.example/a.png' }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'octo@example.com', primary: true, verified: true },
        ]),
      );

    const profile = await exchangeGitHubOAuthCode({ code: 'auth-code', codeVerifier: 'verifier' });

    expect(profile).toEqual({
      email: 'octo@example.com',
      name: 'Octo Cat',
      avatar_url: 'https://github.example/a.png',
      provider_user_id: '4242',
    });

    const tokenRequest = outboundFetch.mock.calls[0]?.[0] as { init: { body: string } };
    expect(JSON.parse(tokenRequest.init.body).code_verifier).toBe('verifier');
  });

  it('rejects when the primary email is not verified (no unverified fallback)', async () => {
    outboundFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'github-access-token' }))
      .mockResolvedValueOnce(jsonResponse({ id: 99, name: 'Attacker' }))
      .mockResolvedValueOnce(
        jsonResponse([{ email: 'victim@example.com', primary: true, verified: false }]),
      );

    const error = await exchangeGitHubOAuthCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({ messageKey: 'errors:githubUserMissingVerifiedEmail' });
  });

  it('does not fall back to an unverified non-primary email', async () => {
    outboundFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'github-access-token' }))
      .mockResolvedValueOnce(jsonResponse({ id: 7, name: 'Attacker' }))
      .mockResolvedValueOnce(
        jsonResponse([{ email: 'victim@example.com', primary: false, verified: false }]),
      );

    await expect(
      exchangeGitHubOAuthCode({ code: 'auth-code', codeVerifier: 'verifier' }),
    ).rejects.toMatchObject({
      messageKey: 'errors:githubUserMissingVerifiedEmail',
    });
  });
});
