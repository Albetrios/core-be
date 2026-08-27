import { NotImplementedError, UnauthorizedError } from '@/shared/errors/index.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import { buildOutboundFetchOptions, outboundFetch } from '@/infrastructure/outbound/index.js';
import { ExternalServiceError } from '@/infrastructure/outbound/outbound-error.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { OAuthProfile } from '@/domains/auth/sub-domains/auth-method/oauth/oauth.types.js';

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

function getGitHubRedirectUri(): string {
  // The redirect URI is the SPA's provider-agnostic /callback page: the browser lands
  // there with `code`+`state`, and the SPA forwards them to this API's
  // GET /api/v1/auth/oauth/github/callback for the token exchange.
  return env.OAUTH_GITHUB_REDIRECT_URI ?? `${env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL}/callback`;
}

/** Builds the GitHub authorize URL (`https://github.com/login/oauth/authorize?...`) with the configured client id, callback URI, scopes (`read:user user:email`), CSRF `state`, and the PKCE S256 `code_challenge`. Throws `NotImplementedError` when `OAUTH_GITHUB_CLIENT_ID` is unset. */
export function buildGitHubOAuthRedirectUrl(state: string, codeChallenge: string): string {
  const clientId = env.OAUTH_GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new NotImplementedError('errors:githubOAuthNotConfigured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getGitHubRedirectUri(),
    scope: 'read:user user:email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

/** Input for {@link exchangeGitHubOAuthCode}: the authorization `code` returned by GitHub, the PKCE `codeVerifier` bound to the original authorize request, plus an optional request id used for outbound observability. */
export interface ExchangeGitHubOAuthCodeOptions {
  code: string;
  codeVerifier: string;
  requestId?: string;
}

/** Trades the GitHub authorization code for an access token, then fetches the user profile and requires a primary + verified email from the emails endpoint before returning a normalised {@link OAuthProfile}. Unverified or non-primary addresses are rejected to prevent find-or-link account takeover. Translates outbound failures to `UnauthorizedError` with provider-specific i18n keys. */
export async function exchangeGitHubOAuthCode(
  options: ExchangeGitHubOAuthCodeOptions,
): Promise<OAuthProfile> {
  const clientId = env.OAUTH_GITHUB_CLIENT_ID;
  const clientSecret = env.OAUTH_GITHUB_CLIENT_SECRET;
  if (!(clientId && clientSecret)) {
    throw new NotImplementedError('errors:githubOAuthNotConfigured');
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await outboundFetch(
      buildOutboundFetchOptions({
        name: 'oauth-github',
        url: GITHUB_TOKEN_URL,
        requestId: options.requestId,
        expectedStatus: 200,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code: options.code,
            code_verifier: options.codeVerifier,
          }),
        },
      }),
    );
  } catch (error) {
    if (error instanceof ExternalServiceError) {
      throw new UnauthorizedError('errors:githubExchangeFailed');
    }
    throw error;
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
  };
  if (tokenData.error || !tokenData.access_token) {
    throw new UnauthorizedError(
      'errors:githubTokenMissing',
      undefined,
      tokenData.error ?? 'GitHub token response missing access_token',
    );
  }

  let userResponse: Response;
  try {
    userResponse = await outboundFetch(
      buildOutboundFetchOptions({
        name: 'oauth-github',
        url: GITHUB_USER_URL,
        requestId: options.requestId,
        expectedStatus: 200,
        init: {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: 'application/vnd.github+json',
          },
        },
      }),
    );
  } catch (error) {
    if (error instanceof ExternalServiceError) {
      throw new UnauthorizedError('errors:githubFetchUserFailed');
    }
    throw error;
  }

  const userInfo = (await userResponse.json()) as {
    id?: number;
    name?: string;
    avatar_url?: string;
  };

  // Always resolve the email from the dedicated emails endpoint and require a
  // primary + verified address. The top-level `user.email` field and any
  // unverified fallback are intentionally ignored: linking by an
  // attacker-controlled unverified address would enable account takeover.
  let primaryVerifiedEmail: string | undefined;
  try {
    const emailsResponse = await outboundFetch(
      buildOutboundFetchOptions({
        name: 'oauth-github',
        url: GITHUB_EMAILS_URL,
        requestId: options.requestId,
        expectedStatus: 200,
        init: {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: 'application/vnd.github+json',
          },
        },
      }),
    );

    const emails = (await emailsResponse.json()) as {
      email: string;
      primary: boolean;
      verified: boolean;
    }[];
    primaryVerifiedEmail = emails.find(
      (emailRecord) => emailRecord.primary && emailRecord.verified,
    )?.email;
  } catch {
    // Email list is optional; the missing/unverified guard below handles it.
  }

  if (!(primaryVerifiedEmail && userInfo.id)) {
    throw new UnauthorizedError('errors:githubUserMissingVerifiedEmail');
  }

  const email = primaryVerifiedEmail;

  return omitUndefined({
    email,
    name: userInfo.name,
    avatar_url: userInfo.avatar_url,
    provider_user_id: String(userInfo.id),
  });
}
