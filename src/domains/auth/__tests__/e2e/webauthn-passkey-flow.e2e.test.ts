import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestTokenWithActiveSession } from '@/tests/helpers/test-auth.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import { database } from '@/infrastructure/database/connection.js';
import { getElevatedDatabase } from '@/tests/helpers/elevated-database.js';
import { webauthn_credentials } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.schema.js';
import type { FastifyInstance } from 'fastify';
import type * as SimpleWebAuthnServerModule from '@simplewebauthn/server';

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof SimpleWebAuthnServerModule>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

describe('Auth e2e: WebAuthn passkey enrolment and sign-in', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    vi.mocked(verifyRegistrationResponse).mockReset();
    vi.mocked(verifyAuthenticationResponse).mockReset();
  });

  it('registers a passkey while authenticated, then signs in with WebAuthn', async () => {
    const user = await createTestUser({
      email: 'webauthn-passkey-flow@example.com',
      isEmailVerified: true,
    });
    const { token, sessionPublicId } = await generateTestTokenWithActiveSession(
      app,
      user.public_id,
    );
    await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);
    const credentialId = 'e2e-test-credential-id';
    const publicKeyBytes = Buffer.from('e2e-test-public-key');

    const registerOptionsResponse = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/me/webauthn/register/options'),
      token,
      payload: {},
    });
    expect(registerOptionsResponse.statusCode).toBe(200);
    const registerOptionsBody = registerOptionsResponse.json() as {
      data: { options: { challenge: string }; challenge_token: string };
    };
    expect(registerOptionsBody.data.options.challenge).toBeTruthy();
    expect(registerOptionsBody.data.challenge_token).toBeTruthy();

    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: credentialId,
          publicKey: publicKeyBytes,
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    } as unknown as Awaited<ReturnType<typeof verifyRegistrationResponse>>);

    const registerVerifyResponse = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/me/webauthn/register/verify'),
      token,
      payload: {
        challenge_token: registerOptionsBody.data.challenge_token,
        response: {
          id: credentialId,
          rawId: credentialId,
          response: { clientDataJSON: 'dGVzdA', attestationObject: 'dGVzdA' },
          type: 'public-key',
        },
      },
    });
    expect(registerVerifyResponse.statusCode).toBe(200);
    const registerVerifyBody = registerVerifyResponse.json() as {
      data: { verified: boolean; credential_id: string };
    };
    expect(registerVerifyBody.data.verified).toBe(true);
    expect(registerVerifyBody.data.credential_id).toBe(credentialId);

    const authenticateOptionsResponse = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/webauthn/authenticate/options'),
      payload: { email: user.email },
    });
    expect(authenticateOptionsResponse.statusCode).toBe(200);
    const authenticateOptionsBody = authenticateOptionsResponse.json() as {
      data: { options: { challenge: string }; challenge_token: string };
    };
    expect(authenticateOptionsBody.data.options.challenge).toBeTruthy();
    expect(authenticateOptionsBody.data.challenge_token).toBeTruthy();

    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 1,
      },
    } as unknown as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);

    const authenticateVerifyResponse = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/webauthn/authenticate/verify'),
      payload: {
        challenge_token: authenticateOptionsBody.data.challenge_token,
        response: {
          id: credentialId,
          rawId: credentialId,
          response: { clientDataJSON: 'dGVzdA', authenticatorData: 'dGVzdA', signature: 'dGVzdA' },
          type: 'public-key',
        },
      },
    });

    expect(authenticateVerifyResponse.statusCode).toBe(200);
    const signInBody = authenticateVerifyResponse.json() as {
      data: { access_token: string };
    };
    expect(signInBody.data.access_token).toBeTruthy();

    const cookies = authenticateVerifyResponse.headers['set-cookie'];
    const sessionCookie = Array.isArray(cookies)
      ? cookies.find((cookie: string) => cookie.startsWith('session_id='))
      : typeof cookies === 'string' && cookies.startsWith('session_id=')
        ? cookies
        : undefined;
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');

    const storedCredentials = await getElevatedDatabase().select().from(webauthn_credentials);
    expect(storedCredentials).toHaveLength(1);
    expect(storedCredentials[0]?.credential_id).toBe(credentialId);
    expect(storedCredentials[0]?.counter).toBe(1);
  });

  it('rejects re-registering an already-enrolled passkey with 409 (not a 500)', async () => {
    const user = await createTestUser({
      email: 'webauthn-duplicate-credential@example.com',
      isEmailVerified: true,
    });
    const { token, sessionPublicId } = await generateTestTokenWithActiveSession(
      app,
      user.public_id,
    );
    const credentialId = 'duplicate-passkey-credential-id';
    const publicKeyBytes = Buffer.from('duplicate-passkey-public-key');

    async function registerSamePasskey() {
      // The register ceremony is a step-up-sensitive operation; re-seed each pass so
      // the second attempt is rejected by the unique constraint, not by a stale step-up.
      await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);
      const optionsResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/webauthn/register/options'),
        token,
        payload: {},
      });
      expect(optionsResponse.statusCode).toBe(200);
      const challengeToken = (optionsResponse.json() as { data: { challenge_token: string } }).data
        .challenge_token;

      vi.mocked(verifyRegistrationResponse).mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: {
            id: credentialId,
            publicKey: publicKeyBytes,
            counter: 0,
            transports: ['internal'],
          },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      } as unknown as Awaited<ReturnType<typeof verifyRegistrationResponse>>);

      return injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/webauthn/register/verify'),
        token,
        payload: {
          challenge_token: challengeToken,
          response: {
            id: credentialId,
            rawId: credentialId,
            response: { clientDataJSON: 'dGVzdA', attestationObject: 'dGVzdA' },
            type: 'public-key',
          },
        },
      });
    }

    const first = await registerSamePasskey();
    expect(first.statusCode).toBe(200);

    const second = await registerSamePasskey();
    expect(second.statusCode).toBe(409);

    // The collision must not have written a duplicate row.
    const storedCredentials = await getElevatedDatabase().select().from(webauthn_credentials);
    expect(storedCredentials).toHaveLength(1);
    expect(storedCredentials[0]?.credential_id).toBe(credentialId);
  });
});
