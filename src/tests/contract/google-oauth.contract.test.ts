import { exchangeGoogleOAuthCode } from '@/domains/auth/sub-domains/auth-method/oauth/providers/google-oauth.provider.js';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_FRONTEND_URL } from '@/shared/constants/index.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import nock from 'nock';
import { describe, expect, test } from 'vitest';

import googleTokenSuccessFixture from './fixtures/oauth/google.token.success.response.json' with {
  type: 'json',
};
import googleUserinfoSuccessFixture from './fixtures/oauth/google.userinfo.success.response.json' with {
  type: 'json',
};
import { registerThirdPartyContractTestIsolationHooks } from './helpers/register-contract-test-hooks.js';
import {
  GoogleTokenSuccessResponseContractSchema,
  GoogleUserinfoSuccessResponseContractSchema,
} from './schemas/oauth.schemas.js';

registerThirdPartyContractTestIsolationHooks();

const googleTokenHostnameOutbound = 'https://oauth2.googleapis.com';
const googleUserinfoHostnameOutbound = 'https://www.googleapis.com';

/**
 * OAuth was the one outbound integration with no wire-level contract coverage —
 * Stripe/Resend/S3/Turnstile pin their request shapes, while the Google code
 * exchange was only unit-tested behind mocks. These tests pin the actual HTTP
 * contract: the form-encoded token request (including the PKCE `code_verifier`
 * Google requires to match the original `code_challenge`), the Bearer userinfo
 * read, and the account-takeover guard that rejects unverified emails at the wire.
 */
describe('Google OAuth outbound contract (`google-oauth.provider`)', () => {
  const expectedGoogleRedirectUriOutbound =
    env.OAUTH_GOOGLE_REDIRECT_URI ?? `${env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL}/callback/google`;

  test('token exchange sends the documented form fields and userinfo carries the Bearer token', async () => {
    GoogleTokenSuccessResponseContractSchema.parse(googleTokenSuccessFixture);
    GoogleUserinfoSuccessResponseContractSchema.parse(googleUserinfoSuccessFixture);

    nock(googleTokenHostnameOutbound)
      .post('/token', (encodedOutboundBody) => {
        // nock hands form-encoded bodies to the matcher already querystring-parsed
        // (as a null-prototype record); keep the raw-string branch for safety.
        const decodedTokenRequestForm: Record<string, string> =
          typeof encodedOutboundBody === 'string'
            ? Object.fromEntries(new URLSearchParams(encodedOutboundBody))
            : { ...(encodedOutboundBody as Record<string, string>) };
        expect(decodedTokenRequestForm.code).toBe('contract-google-authorization-code');
        expect(decodedTokenRequestForm.client_id).toBe(env.OAUTH_GOOGLE_CLIENT_ID);
        expect(decodedTokenRequestForm.client_secret).toBe(env.OAUTH_GOOGLE_CLIENT_SECRET);
        expect(decodedTokenRequestForm.redirect_uri).toBe(expectedGoogleRedirectUriOutbound);
        expect(decodedTokenRequestForm.grant_type).toBe('authorization_code');
        expect(decodedTokenRequestForm.code_verifier).toBe('contract-google-pkce-verifier');
        return true;
      })
      .matchHeader('content-type', /application\/x-www-form-urlencoded/)
      .reply(200, googleTokenSuccessFixture);

    nock(googleUserinfoHostnameOutbound)
      .get('/oauth2/v3/userinfo')
      .matchHeader('authorization', `Bearer ${googleTokenSuccessFixture.access_token}`)
      .reply(200, googleUserinfoSuccessFixture);

    const normalizedGoogleProfileOutbound = await exchangeGoogleOAuthCode({
      code: 'contract-google-authorization-code',
      codeVerifier: 'contract-google-pkce-verifier',
    });

    expect(normalizedGoogleProfileOutbound).toEqual({
      email: googleUserinfoSuccessFixture.email,
      name: googleUserinfoSuccessFixture.name,
      avatar_url: googleUserinfoSuccessFixture.picture,
      provider_user_id: googleUserinfoSuccessFixture.sub,
    });
  });

  test('userinfo with email_verified !== true is rejected (find-or-link takeover guard at the wire)', async () => {
    nock(googleTokenHostnameOutbound).post('/token').reply(200, googleTokenSuccessFixture);
    nock(googleUserinfoHostnameOutbound)
      .get('/oauth2/v3/userinfo')
      .reply(200, { ...googleUserinfoSuccessFixture, email_verified: false });

    await expect(
      exchangeGoogleOAuthCode({
        code: 'contract-google-authorization-code',
        codeVerifier: 'contract-google-pkce-verifier',
      }),
    ).rejects.toThrow(UnauthorizedError);
  });

  test('token endpoint invalid_grant (HTTP 400) surfaces as UnauthorizedError, not a raw outbound failure', async () => {
    nock(googleTokenHostnameOutbound)
      .post('/token')
      .reply(400, { error: 'invalid_grant', error_description: 'Bad Request' });

    await expect(
      exchangeGoogleOAuthCode({
        code: 'contract-google-expired-code',
        codeVerifier: 'contract-google-pkce-verifier',
      }),
    ).rejects.toThrow(UnauthorizedError);
  });
});
