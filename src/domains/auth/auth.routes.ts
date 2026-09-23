import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { captchaPreHandler } from '@/shared/middlewares/security/captcha.middleware.js';
import {
  requireRecentStepUpPreHandler,
  requireStrongRecentStepUpPreHandler,
} from '@/shared/middlewares/core/recent-step-up.middleware.js';
import {
  MODERATE_AUTHED_RATE_LIMIT,
  REFRESH_RATE_LIMIT,
  STRICT_AUTHED_RATE_LIMIT,
  STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS,
  STRICT_PUBLIC_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { createAuthController } from './auth.controller.js';
import {
  authMethodPublicIdParamsDto,
  ChangePasswordDto,
  CreateAuthMethodDto,
  EmailLoginDto,
  EmailSendCodeDto,
  ForgotPasswordDto,
  LoginDto,
  MfaEnrollConfirmDto,
  MfaEnrollDto,
  MfaLoginVerifyDto,
  MfaVerifyDto,
  mfaMethodIdParamsDto,
  OauthCallbackQueryDto,
  oauthProviderParamsDto,
  ResetPasswordDto,
  sessionIdParamsDto,
  StepUpVerifyDto,
} from './auth.dto.js';
import {
  webauthnAuthenticateOptionsDto,
  webauthnAuthenticateVerifyDto,
  webauthnCredentialIdParamsDto,
  webauthnRegisterVerifyDto,
} from './sub-domains/auth-webauthn/webauthn.dto.js';

/** Fastify plugin that registers all `/api/v1/auth/*` routes — login, logout, refresh, email verification-code login, OAuth, password, MFA, WebAuthn, sessions, and auth-method management. */
export const authRoutesPlugin: FastifyPluginAsync = async (app) => {
  const controller = createAuthController(app.authDomain);
  const zodApplication = app.withTypeProvider<ZodTypeProvider>();

  // Per-identity (per-email) throttle layered on top of the IP-only STRICT_PUBLIC_RATE_LIMIT.
  // Applied to unauthenticated credential and outbound-email endpoints so abuse cannot bypass
  // the cap by rotating spoofed IPs (defense in depth alongside Turnstile CAPTCHA).
  const perEmailRateLimit = app.rateLimit(STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS);

  // Public — strict rate limits on login/magic-link/password endpoints
  zodApplication.post('/login', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [perEmailRateLimit, captchaPreHandler],
    schema: {
      summary: 'Login with email and password',
      description:
        'Authenticates a user with email and password credentials. Returns access and refresh tokens on success. If MFA is enabled, returns a challenge requiring a second factor.',
      tags: ['Auth'],
      body: LoginDto,
    },
    handler: controller.login,
  });
  zodApplication.post(
    '/logout',
    {
      ...STRICT_PUBLIC_RATE_LIMIT,
      schema: {
        summary: 'Logout current session',
        description:
          'Invalidates the current session and refresh token. Requires a valid bearer token.',
        tags: ['Auth'],
      },
    },
    controller.logout,
  );
  zodApplication.post('/email/send-code', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [perEmailRateLimit, captchaPreHandler],
    schema: {
      summary: 'Send email sign-in code',
      description:
        'Sends a one-time alphanumeric verification code to the provided email address for passwordless login or sign-up. Always returns a uniform success (no account enumeration) and the code expires after a short period. Re-call this endpoint to resend a code.',
      tags: ['Email Login'],
      body: EmailSendCodeDto,
    },
    handler: controller.sendEmailCode,
  });
  zodApplication.post('/email/login', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [captchaPreHandler],
    schema: {
      summary: 'Log in with an email verification code',
      description:
        'Validates the 6-character email verification code and returns an access token + session on success (auto-signing-up an unknown email). If MFA is enabled, returns a challenge requiring a second factor.',
      tags: ['Email Login'],
      body: EmailLoginDto,
    },
    handler: controller.emailLogin,
  });
  zodApplication.get(
    '/oauth/providers',
    {
      ...STRICT_PUBLIC_RATE_LIMIT,
      schema: {
        summary: 'List available OAuth providers',
        description:
          'Returns a list of configured OAuth providers (e.g. Google, GitHub) available for login.',
        tags: ['OAuth'],
      },
    },
    controller.listOauthProviders,
  );
  zodApplication.get('/oauth/:provider', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [captchaPreHandler],
    schema: {
      summary: 'Initiate OAuth flow',
      description:
        'Returns the OAuth provider authorization URL and nonce cookie for a browser client to begin the login flow.',
      tags: ['OAuth'],
      params: oauthProviderParamsDto,
    },
    handler: controller.oauthRedirect,
  });
  zodApplication.get('/oauth/:provider/callback', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    schema: {
      summary: 'OAuth callback',
      description:
        'Handles the OAuth provider callback after user authorization. Exchanges the code for tokens and creates or links the user account.',
      tags: ['OAuth'],
      params: oauthProviderParamsDto,
      querystring: OauthCallbackQueryDto,
    },
    handler: controller.oauthCallback,
  });
  zodApplication.post('/password/forgot', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [perEmailRateLimit, captchaPreHandler],
    schema: {
      summary: 'Request password reset',
      description:
        'Sends a password reset email to the user. Returns 200 even if the email is not registered (to prevent enumeration).',
      tags: ['Password'],
      body: ForgotPasswordDto,
    },
    handler: controller.forgotPassword,
  });
  zodApplication.post('/password/reset', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [captchaPreHandler],
    schema: {
      summary: 'Reset password with token',
      description:
        'Resets the user password using a valid reset token received via email, revokes all prior sessions, marks the email verified (the token proves email control), clears any failed-login lockout, and logs the user in immediately (returns an access token and sets the session cookie). MFA-enabled users receive an mfa_required challenge instead of a session.',
      tags: ['Password'],
      body: ResetPasswordDto,
    },
    handler: controller.resetPassword,
  });
  zodApplication.post(
    '/mfa/login',
    {
      ...STRICT_PUBLIC_RATE_LIMIT,
      // sec-new-A1: add bot-protection at the MFA step. The mfa_session_token is
      // single-use (GETDEL), so per-email rate-limiting is already enforced at
      // POST /auth/login (which mints the token). Captcha here adds a second
      // friction layer against automated TOTP guessing from accumulated tokens.
      preHandler: [captchaPreHandler],
      schema: {
        summary: 'Complete MFA during login',
        description:
          'Completes the login flow for an MFA-enabled account. Requires the short-lived mfa_session_token issued by POST /auth/login after password verification, plus a valid TOTP or recovery code. Returns access and refresh tokens and sets the session cookie on success.',
        tags: ['MFA'],
        body: MfaLoginVerifyDto,
      },
    },
    controller.verifyMfaLogin,
  );
  zodApplication.post('/webauthn/authenticate/options', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    preHandler: [perEmailRateLimit, captchaPreHandler],
    schema: {
      summary: 'Begin passkey authentication',
      description:
        'Returns WebAuthn authentication options and an opaque challenge token for a passwordless login ceremony. The client echoes the challenge back at /auth/webauthn/authenticate/verify. Public endpoint used during login.',
      tags: ['WebAuthn'],
      body: webauthnAuthenticateOptionsDto,
    },
    handler: controller.webauthnAuthenticateOptions,
  });
  zodApplication.post('/webauthn/authenticate/verify', {
    ...STRICT_PUBLIC_RATE_LIMIT,
    schema: {
      summary: 'Complete passkey authentication',
      description:
        'Verifies the assertion response from a WebAuthn authentication ceremony and, on success, returns access and refresh tokens and sets the session cookie. Public endpoint used during login.',
      tags: ['WebAuthn'],
      body: webauthnAuthenticateVerifyDto,
    },
    handler: controller.webauthnAuthenticateVerify,
  });
  zodApplication.post(
    '/refresh',
    {
      ...REFRESH_RATE_LIMIT,
      schema: {
        summary: 'Refresh access token',
        description:
          'Exchanges a valid session cookie for a new short-lived access token. The session_id httpOnly cookie is sent automatically by the browser. When ALLOWED_ORIGINS is set, requests that include an Origin header must match that allowlist (403 otherwise); requests without Origin are allowed for non-browser clients.',
        tags: ['Token'],
      },
    },
    controller.refreshToken,
  );
  zodApplication.post(
    '/switch-to-personal',
    {
      onRequest: [app.authenticate],
      // Per-user cap: each switch re-mints a JWT and hits the DB, so throttle like the other
      // moderate authed operations rather than leaving it on the global limiter alone.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Switch to personal organization',
        description:
          "Re-mints the access token scoped to the caller's personal organization (no body — the server resolves it; can never 403). Returns a new access token; the client swaps its Bearer to it.",
        tags: ['Organization'],
      },
    },
    controller.switchToPersonalOrganization,
  );
  zodApplication.post(
    '/switch-to-organization',
    {
      onRequest: [app.authenticate],
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Switch active organization',
        description:
          "Re-mints the access token scoped to the given organization after validating the caller's active membership (403 if not a member). Returns a new access token; the client swaps its Bearer to it.",
        tags: ['Organization'],
        body: z.object({
          organization_id: z
            .string()
            .min(1)
            .describe('Target organization id (`org_…`) the caller is an active member of.'),
        }),
      },
    },
    controller.switchToOrganization,
  );

  // Authenticated
  zodApplication.post(
    '/password/change',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Change current password',
        description:
          "Changes the authenticated user's password. Requires the current password for verification.",
        tags: ['Password'],
        body: ChangePasswordDto,
      },
    },
    controller.changePassword,
  );
  zodApplication.post(
    '/step-up',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Step-up (re-authenticate)',
        description:
          'Opens a short "recent step-up" window required before sensitive credential mutations. Re-verify with your password, or — for a passwordless account with no MFA — a 6-character email verification code (bootstrap-only, so the account can enroll its first MFA/passkey). MFA users must complete an MFA verification instead. An email-code window can enroll a factor but cannot perform destructive mutations (revoking sessions, deleting a credential / MFA / auth-method), which require a password or MFA step-up. Returns 401 for a wrong password/code.',
        tags: ['Auth'],
        body: StepUpVerifyDto,
      },
    },
    controller.stepUp,
  );
  zodApplication.post(
    '/me/mfa/enroll',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Begin MFA enrollment (phase 1 of 2)',
        description:
          'Stages a TOTP secret in Redis and returns it with a provisioning URI for authenticator app setup. Phase 2 (`POST /auth/me/mfa/enroll/confirm`) verifies a fresh code and atomically persists the auth method, generates recovery codes, and flips is_mfa_enabled. Nothing is written to Postgres at this step.',
        tags: ['MFA'],
        body: MfaEnrollDto,
      },
    },
    controller.enrollMfa,
  );
  zodApplication.post(
    '/me/mfa/enroll/confirm',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Confirm MFA enrollment (phase 2 of 2)',
        description:
          'Verifies a 6-digit TOTP code against the secret staged by `POST /auth/me/mfa/enroll`. On success the auth method is persisted, recovery codes are generated and hashed, and is_mfa_enabled is flipped. The plaintext recovery codes are returned EXACTLY ONCE in this response.',
        tags: ['MFA'],
        body: MfaEnrollConfirmDto,
      },
    },
    controller.confirmEnrollMfa,
  );
  zodApplication.post(
    '/me/webauthn/register/options',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Begin passkey registration',
        description:
          'Returns WebAuthn registration options and an opaque challenge token the client echoes back at /auth/me/webauthn/register/verify. Requires recent step-up authentication.',
        tags: ['WebAuthn'],
        body: z.object({}).strict(),
      },
    },
    controller.webauthnRegisterOptions,
  );
  zodApplication.post(
    '/me/webauthn/register/verify',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Complete passkey registration',
        description:
          'Verifies the attestation response from a WebAuthn registration ceremony and persists the credential. Requires recent step-up authentication.',
        tags: ['WebAuthn'],
        body: webauthnRegisterVerifyDto,
      },
    },
    controller.webauthnRegisterVerify,
  );
  zodApplication.get(
    '/me/webauthn/credentials',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List registered passkeys',
        description:
          'Returns the authenticated user’s active WebAuthn passkeys (opaque id, device type, transports, created/last-used timestamps). Never returns credential material or the raw WebAuthn credential blob.',
        tags: ['WebAuthn'],
      },
    },
    controller.webauthnListCredentials,
  );
  zodApplication.delete<{ Params: { credential_id: string } }>(
    '/me/webauthn/credentials/:credential_id',
    {
      onRequest: [app.authenticate],
      // Destructive: a bootstrap email-code step-up window must not revoke a credential (sec-A2).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Revoke a passkey',
        description:
          'Revokes one of the authenticated user’s passkeys by its opaque id. Requires recent step-up authentication. Refused with 409 if it would remove a passkey-only user’s last remaining login credential.',
        tags: ['WebAuthn'],
        params: webauthnCredentialIdParamsDto,
      },
    },
    controller.webauthnRevokeCredential,
  );
  zodApplication.get(
    '/me/mfa',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List enrolled MFA methods',
        description: 'Returns all MFA methods enrolled by the authenticated user.',
        tags: ['MFA'],
      },
    },
    controller.listMfaMethods,
  );
  zodApplication.delete<{ Params: { mfa_method_id: string } }>(
    '/me/mfa/:mfa_method_id',
    {
      onRequest: [app.authenticate],
      // Destructive: a bootstrap email-code step-up window must not delete an MFA method (sec-A2).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Remove MFA method',
        description:
          'Deletes an enrolled MFA method. Cannot remove the last MFA method if MFA is required by organization policy.',
        tags: ['MFA'],
        params: mfaMethodIdParamsDto,
      },
    },
    controller.deleteMfa,
  );
  zodApplication.delete(
    '/me/sessions',
    {
      onRequest: [app.authenticate],
      // sec-A7: a stolen bearer must not be able to kick the legitimate user out of their
      // own browser. Requiring recent step-up forces the attacker to also possess the
      // second factor (or password for non-MFA users — sec-A1 blocks the password-only
      // step-up path for MFA-enabled accounts). A STRONG step-up is required, so a bootstrap
      // email-code window (passwordless-no-MFA) can enroll a factor but never revoke sessions.
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Revoke all sessions',
        description:
          'Revokes all active sessions for the authenticated user except the current one. Requires recent step-up authentication.',
        tags: ['Session'],
      },
    },
    controller.revokeAllSessions,
  );
  zodApplication.post(
    '/me/mfa/verify',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Verify MFA code',
        description:
          'Validates a TOTP code to complete MFA verification during login or enrollment confirmation.',
        tags: ['MFA'],
        body: MfaVerifyDto,
      },
    },
    controller.verifyMfa,
  );
  zodApplication.get(
    '/me/context',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Get my session context',
        description:
          "Returns the authenticated caller's identity, active organization (with type-derived capabilities), the permission codes the caller holds in that organization, and their global role. One authoritative call for rendering a permission-aware UI — identical for personal and team organizations. The organizations the caller belongs to are NOT here: that list is paginated and lives at GET /users/me/organizations.",
        tags: ['Auth'],
      },
    },
    controller.getMeContext,
  );
  zodApplication.get(
    '/me/auth-methods',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List my auth methods',
        description:
          'Returns all authentication methods (password, OAuth, magic link) linked to the authenticated user.',
        tags: ['Auth Method'],
      },
    },
    controller.listAuthMethods,
  );
  zodApplication.post(
    '/me/auth-methods',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRecentStepUpPreHandler],
      config: { ...STRICT_AUTHED_RATE_LIMIT.config },
      schema: {
        summary: 'Add auth method',
        description:
          "Links a new authentication method (e.g. OAuth provider) to the authenticated user's account.",
        tags: ['Auth Method'],
        body: CreateAuthMethodDto,
      },
    },
    controller.createAuthMethod,
  );
  zodApplication.delete<{ Params: { auth_method_id: string } }>(
    '/me/auth-methods/:auth_method_id',
    {
      onRequest: [app.authenticate],
      // Destructive: a bootstrap email-code step-up window must not remove an auth method (sec-A2).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Remove auth method',
        description:
          "Removes an authentication method from the user's account. Cannot remove the last auth method.",
        tags: ['Auth Method'],
        params: authMethodPublicIdParamsDto,
      },
    },
    controller.deleteAuthMethod,
  );
  zodApplication.get(
    '/me/sessions',
    {
      onRequest: [app.authenticate],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'List my active sessions',
        description:
          'Returns all active sessions for the authenticated user, including the source IP and parsed device/browser info.',
        tags: ['Session'],
      },
    },
    controller.listSessions,
  );
  zodApplication.delete<{ Params: { session_id: string } }>(
    '/me/sessions/:session_id',
    {
      onRequest: [app.authenticate],
      // sec-A7: see the comment on DELETE /me/sessions above — same threat model (strong step-up).
      preHandler: [requireStrongRecentStepUpPreHandler],
      ...STRICT_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Revoke a specific session',
        description:
          'Revokes a specific session by its ID. Cannot revoke the current session (use logout instead). Requires recent step-up authentication.',
        tags: ['Session'],
        params: sessionIdParamsDto,
      },
    },
    controller.revokeSession,
  );
};
