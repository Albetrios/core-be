import { NotImplementedError, UnauthorizedError } from '@/shared/errors/index.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import { buildOutboundFetchOptions, outboundFetch } from '@/infrastructure/outbound/index.js';
import { ExternalServiceError } from '@/infrastructure/outbound/outbound-error.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { OAuthProfile } from '@/domains/auth/sub-domains/auth-method/oauth/oauth.types.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

function getGoogleRedirectUri(): string {
  // The redirect URI is the SPA's provider-specific /callback/google page: the browser
  // lands there with `code`+`state`, and the SPA forwards them to this API's
  // GET /api/v1/auth/oauth/google/callback for the token exchange.
  return (
    env.OAUTH_GOOGLE_REDIRECT_URI ?? `${env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL}/callback/google`
  );
}

/** Builds the Google authorize URL (`https://accounts.google.com/o/oauth2/v2/auth?...`) with the configured client id, callback URI, OIDC scopes, CSRF `state`, the PKCE S256 `code_challenge`, and offline + consent prompts. Throws `NotImplementedError` when `OAUTH_GOOGLE_CLIENT_ID` is unset. */
export function buildGoogleOAuthRedirectUrl(state: string, codeChallenge: string): string {
  const clientId = env.OAUTH_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new NotImplementedError('errors:googleOAuthNotConfigured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getGoogleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/** Input for {@link exchangeGoogleOAuthCode}: the authorization `code` returned by Google, the PKCE `codeVerifier` bound to the original authorize request, plus an optional request id used for outbound observability. */
export interface ExchangeGoogleOAuthCodeOptions {
  code: string;
  codeVerifier: string;
  requestId?: string;
}

/** Trades the Google authorization code for an access token, fetches the OIDC userinfo response, and returns a normalised {@link OAuthProfile}. Rejects responses whose `email_verified` is not strictly `true` to prevent find-or-link account takeover. Translates outbound failures to `UnauthorizedError` with provider-specific i18n keys. */
export async function exchangeGoogleOAuthCode(
  options: ExchangeGoogleOAuthCodeOptions,
): Promise<OAuthProfile> {
  const clientId = env.OAUTH_GOOGLE_CLIENT_ID;
  const clientSecret = env.OAUTH_GOOGLE_CLIENT_SECRET;
  if (!(clientId && clientSecret)) {
    throw new NotImplementedError('errors:googleOAuthNotConfigured');
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await outboundFetch(
      buildOutboundFetchOptions({
        name: 'oauth-google',
        url: GOOGLE_TOKEN_URL,
        requestId: options.requestId,
        expectedStatus: 200,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: options.code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: getGoogleRedirectUri(),
            grant_type: 'authorization_code',
            code_verifier: options.codeVerifier,
          }),
        },
      }),
    );
  } catch (error) {
    if (error instanceof ExternalServiceError) {
      throw new UnauthorizedError('errors:googleExchangeFailed');
    }
    throw error;
  }

  const tokenData = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    throw new UnauthorizedError('errors:googleTokenMissingAccessToken');
  }

  let userInfoResponse: Response;
  try {
    userInfoResponse = await outboundFetch(
      buildOutboundFetchOptions({
        name: 'oauth-google',
        url: GOOGLE_USERINFO_URL,
        requestId: options.requestId,
        expectedStatus: 200,
        init: {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        },
      }),
    );
  } catch (error) {
    if (error instanceof ExternalServiceError) {
      throw new UnauthorizedError('errors:googleFetchUserFailed');
    }
    throw error;
  }

  const userInfo = (await userInfoResponse.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  if (!(userInfo.email && userInfo.sub)) {
    throw new UnauthorizedError('errors:googleUserMissingEmailOrSub');
  }

  // Reject accounts whose email Google has not verified: linking by an
  // attacker-controlled unverified address would enable account takeover.
  if (userInfo.email_verified !== true) {
    throw new UnauthorizedError('errors:googleEmailNotVerified');
  }

  return omitUndefined({
    email: userInfo.email,
    name: userInfo.name,
    avatar_url: userInfo.picture,
    provider_user_id: userInfo.sub,
  });
}
