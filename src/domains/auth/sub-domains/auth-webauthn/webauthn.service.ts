import { createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { env } from '@/shared/config/env.config.js';
import { MAX_WEBAUTHN_CREDENTIALS_PER_USER } from '@/shared/constants/security.constants.js';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  assertEmailVerifiedForCredentialEnrollment,
  assertUserAccountActive,
} from '@/shared/utils/auth/account-status.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { WebauthnCredentialRepository } from './webauthn-credential.repository.js';
import { serializeWebauthnCredentialList } from './webauthn.serializer.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import {
  completeFirstFactorAuth,
  type FirstFactorAuthResult,
} from '@/domains/auth/shared/complete-first-factor-auth.js';
import { consumeWebauthnChallenge, createWebauthnChallenge } from './webauthn-challenge.js';
import {
  resolveWebauthnExpectedOrigin,
  resolveWebauthnRelyingPartyId,
  resolveWebauthnRelyingPartyName,
} from './webauthn.config.js';
import {
  validateWebauthnAuthenticateOptions,
  validateWebauthnAuthenticateVerify,
  validateWebauthnRegisterVerify,
} from './webauthn.validator.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/principal-database.context.js';
import { resolveVerifiedUserPrincipalScope } from '@/domains/auth/shared/verified-user-principal-scope.util.js';

/**
 * Result envelope returned by {@link WebauthnService.generateRegistrationOptions}.
 *
 * @remarks
 * - **Algorithm:** wraps the raw `@simplewebauthn/server` registration options
 *   plus the opaque `challenge_token` that the client must echo back at verify time.
 * - **Failure modes:** purely a shape; consumers should treat `options` as opaque.
 * - **Side effects:** none.
 * - **Notes:** the `challenge_token` indexes a Redis-stored challenge with a short TTL.
 */
export type WebauthnRegisterOptionsResult = {
  options: Awaited<ReturnType<typeof generateRegistrationOptions>>;
  challenge_token: string;
};

/**
 * Result envelope returned by {@link WebauthnService.generateAuthenticationOptions}.
 *
 * @remarks
 * - **Algorithm:** wraps the raw `@simplewebauthn/server` authentication options plus
 *   the opaque `challenge_token` paired with the user's pending challenge in Redis.
 * - **Failure modes:** purely a shape; consumers should treat `options` as opaque.
 * - **Side effects:** none.
 * - **Notes:** the `challenge_token` is consumed once at verify time and bound to the
 *   originating user via {@link consumeWebauthnChallenge}.
 */
export type WebauthnAuthenticateOptionsResult = {
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
  challenge_token: string;
};

/**
 * Passkey (WebAuthn) enrollment and login orchestrator.
 *
 * @remarks
 * - **Algorithm:** uses `@simplewebauthn/server` to produce registration and
 *   authentication options, persists the challenge in Redis via
 *   {@link createWebauthnChallenge}, and on verify consumes the challenge via
 *   {@link consumeWebauthnChallenge}. Registration stores the new credential in
 *   {@link webauthn_credentials}; authentication validates the assertion, bumps
 *   the stored signature counter via {@link WebauthnCredentialRepository.updateCounter},
 *   and mints a JWT + session.
 * - **Failure modes:** mismatched challenge user, replayed/forged assertions, or
 *   counter regression surface as `UnauthorizedError` or `ValidationError` with
 *   WebAuthn-specific i18n keys (`errors:webauthnInvalidChallenge`,
 *   `errors:webauthnAuthenticationFailed`, `errors:webauthnCredentialNotFound`, …). The
 *   `authenticate/options` step never reveals account existence: unknown emails and
 *   emails without passkeys receive deterministic decoy options instead of an error.
 * - **Side effects:** writes to {@link webauthn_credentials} (`createCredential`,
 *   `updateCounter`), to `auth.sessions` via {@link AuthSessionService.createSessionForUser},
 *   and to Redis (`webauthn:challenge:*`). Signs an RS256 JWT on successful login.
 * - **Notes:** RP ID and expected origin are resolved at call time from
 *   `WEBAUTHN_RP_ID` / `ALLOWED_ORIGINS` so the same binary serves multiple environments.
 */
export class WebauthnService {
  constructor(
    private readonly userService: UserService,
    private readonly authSessionService: AuthSessionService,
    private readonly credentialRepository: WebauthnCredentialRepository,
    private readonly redis: Redis,
    private readonly organizationSettingsService: OrganizationSettingsService,
    private readonly mfaService: MfaService,
    private readonly authMethodService: AuthMethodService,
  ) {}

  async generateRegistrationOptions(
    userPublicId: string,
    _requestOrigin?: string,
  ): Promise<WebauthnRegisterOptionsResult> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) {
      throw new UnauthorizedError('errors:userNotFound');
    }
    // Pre-hijacking guard: an unverified (e.g. attacker-pre-registered) account must not seed a
    // passkey that would survive the real owner's password-reset recovery (sec — account
    // pre-hijacking, Trojan-credential variant).
    assertEmailVerifiedForCredentialEnrollment(user);

    const existingCredentials = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => this.credentialRepository.listActiveByUserId(user.id),
    );
    const relyingPartyId = resolveWebauthnRelyingPartyId();
    const options = await generateRegistrationOptions({
      rpName: resolveWebauthnRelyingPartyName(),
      rpID: relyingPartyId,
      userName: user.email,
      userDisplayName: user.email,
      userID: Buffer.from(user.public_id, 'utf8'),
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        // sec-r4-A2: align with the verify-time requirement (verifyRegistrationResponse
        // calls with requireUserVerification: true). Setting 'preferred' here let a
        // UV-incapable authenticator (no biometric / PIN) finish the registration
        // round-trip and produce a credential that could NEVER authenticate — the
        // verify step would always fail. 'required' surfaces UV capability as a hard
        // requirement at enrollment time instead of after the credential is minted.
        userVerification: 'required',
      },
    });

    const challengeToken = await createWebauthnChallenge(
      this.redis,
      'registration',
      user.public_id,
      options.challenge,
    );

    return { options, challenge_token: challengeToken };
  }

  async verifyRegistration(
    userPublicId: string,
    body: unknown,
    requestOrigin?: string,
  ): Promise<{ verified: boolean; credential_id: string }> {
    const parsed = validateWebauthnRegisterVerify(body);
    const challenge = await consumeWebauthnChallenge(
      this.redis,
      parsed.challenge_token,
      'registration',
    );
    if (challenge.user_public_id !== userPublicId) {
      throw new UnauthorizedError('errors:webauthnInvalidChallenge');
    }

    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) {
      throw new UnauthorizedError('errors:userNotFound');
    }

    const expectedOrigin = resolveWebauthnExpectedOrigin(requestOrigin);
    const verification = await verifyRegistrationResponse({
      response: parsed.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin,
      expectedRPID: resolveWebauthnRelyingPartyId(),
      requireUserVerification: true,
    });

    if (!(verification.verified && verification.registrationInfo)) {
      throw new ValidationError('errors:webauthnRegistrationFailed');
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    let created: Awaited<ReturnType<WebauthnCredentialRepository['createCredential']>>;
    try {
      created = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(user.public_id),
        async () => {
          // Serialize the count + insert under a per-user advisory lock so concurrent registrations
          // cannot both pass the cap check and overshoot MAX_WEBAUTHN_CREDENTIALS_PER_USER. The xact
          // lock auto-releases at commit.
          await this.credentialRepository.acquireCreationQuotaLock(user.id);
          const activeCount = await this.credentialRepository.countActiveByUserId(user.id);
          if (activeCount >= MAX_WEBAUTHN_CREDENTIALS_PER_USER) {
            throw new ConflictError('errors:webauthnCredentialMaxReached', {
              max: MAX_WEBAUTHN_CREDENTIALS_PER_USER,
            });
          }
          return this.credentialRepository.createCredential({
            user_id: user.id,
            credential_id: credential.id,
            public_key: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
            device_type: credentialDeviceType,
            backed_up: credentialBackedUp,
            transports: credential.transports ?? [],
          });
        },
      );
    } catch (error) {
      // This passkey is already enrolled (webauthn_credentials_credential_id_unique).
      // excludeCredentials is only a client-side hint, so a replayed/forced registration
      // can still collide — surface a clean 409 rather than an unhandled 500.
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictError('errors:webauthnCredentialExists');
      }
      throw error;
    }

    return { verified: true, credential_id: created.credential_id };
  }

  async generateAuthenticationOptions(
    body: unknown,
    _requestOrigin?: string,
  ): Promise<WebauthnAuthenticateOptionsResult> {
    const parsed = validateWebauthnAuthenticateOptions(body);
    // `email` is required at the DTO layer (sec-A finding #24). The runtime check is
    // retained only as a defense-in-depth for tests/callers that bypass the validator;
    // the DTO produces a typed value so this branch should be unreachable in normal flow.
    const user = await this.userService.findByEmail(parsed.email);
    // Anti-enumeration (timing): the decoy below equalizes the response SHAPE, but a KNOWN email
    // otherwise incurs an extra user-context credential query that an unknown email skips — a
    // measurable timing oracle that re-opens what the decoy closes. Run the SAME user-context lookup
    // on both paths; an unknown/credential-less email uses a non-resolvable synthetic context (the
    // RLS policy + `user_id = 0` filter return zero rows), so the DB work matches.
    const lookupUserPublicId = user?.public_id ?? `decoy:${generatePublicId('authMethod')}`;
    const lookupUserId = user?.id ?? 0;
    const credentials = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(lookupUserPublicId),
      () => this.credentialRepository.listActiveByUserId(lookupUserId),
    );

    // Anti-enumeration: never let the response reveal whether `email` maps to an account
    // that has passkeys. Unknown accounts (and known accounts without credentials) receive
    // structurally identical decoy options keyed deterministically on the email, so the
    // 200 + allowCredentials payload is indistinguishable from a genuine challenge. The
    // follow-up verify fails uniformly because no authenticator can satisfy the decoy.
    if (!user || credentials.length === 0) {
      return this.buildDecoyAuthenticationOptions(parsed.email);
    }

    const options = await generateAuthenticationOptions({
      rpID: resolveWebauthnRelyingPartyId(),
      allowCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports as AuthenticatorTransportFuture[],
      })),
      // sec-r4-A2: verifyAuthenticationResponse requires user verification, so the
      // options round-trip must also require it. 'preferred' let UV-incapable
      // authenticators round-trip successfully and then always fail verify.
      userVerification: 'required',
    });

    const challengeToken = await createWebauthnChallenge(
      this.redis,
      'authentication',
      user.public_id,
      options.challenge,
    );

    return { options, challenge_token: challengeToken };
  }

  /**
   * Builds decoy authentication options for an email that has no usable passkey, so the
   * `authenticate/options` endpoint cannot be used as an account/credential enumeration oracle.
   *
   * @remarks
   * - **Algorithm:** derives a single stable decoy credential id from
   *   `HMAC-SHA256(SECRETS_ENCRYPTION_KEY, "webauthn-auth-decoy:" + lowercased email)` so
   *   repeated probes for the same email return identical credential descriptors (a real
   *   account's credential ids are likewise stable). Generates real `simplewebauthn` options
   *   around that decoy and stores a challenge bound to a non-resolvable synthetic user.
   * - **Failure modes:** none surfaced to the caller — the point is to return a 200 that mirrors
   *   the genuine shape; the eventual verify fails uniformly via the standard credential lookup.
   * - **Side effects:** writes a short-lived `webauthn:challenge:*` entry to Redis.
   * - **Notes:** the synthetic `decoy:<publicId>` owner never matches a real user, so even if the
   *   client echoes the challenge back, `verifyAuthentication` rejects it like any other mismatch.
   */
  private async buildDecoyAuthenticationOptions(
    email: string,
  ): Promise<WebauthnAuthenticateOptionsResult> {
    const decoyCredentialId = createHmac('sha256', env.SECRETS_ENCRYPTION_KEY)
      .update(`webauthn-auth-decoy:${email.toLowerCase()}`)
      .digest()
      .toString('base64url');

    const options = await generateAuthenticationOptions({
      rpID: resolveWebauthnRelyingPartyId(),
      allowCredentials: [{ id: decoyCredentialId, transports: ['internal'] }],
      // sec-r4-A2: keep the decoy structurally identical to a genuine challenge so
      // the anti-enumeration guarantee holds.
      userVerification: 'required',
    });

    const challengeToken = await createWebauthnChallenge(
      this.redis,
      'authentication',
      `decoy:${generatePublicId('authMethod')}`,
      options.challenge,
    );

    return { options, challenge_token: challengeToken };
  }

  async verifyAuthentication(
    body: unknown,
    ipAddress: string,
    requestOrigin?: string,
    userAgent?: string,
  ): Promise<FirstFactorAuthResult> {
    const parsed = validateWebauthnAuthenticateVerify(body);
    const challenge = await consumeWebauthnChallenge(
      this.redis,
      parsed.challenge_token,
      'authentication',
    );

    const response = parsed.response as AuthenticationResponseJSON;
    // Defense-in-depth: when the authenticator returns a `userHandle` (resident/discoverable
    // credentials), it MUST decode to the challenged user's public id — registration sets
    // `userID = utf8(public_id)`. The credential↔user binding is enforced below by the id-scoped
    // lookup + signature, so this is not load-bearing today; it pins the invariant so a future
    // usernameless flow that resolves the user FROM `userHandle` cannot regress into account confusion.
    const assertedUserHandle = response.response.userHandle;
    if (
      assertedUserHandle !== undefined &&
      Buffer.from(assertedUserHandle, 'base64url').toString('utf8') !== challenge.user_public_id
    ) {
      throw new UnauthorizedError('errors:webauthnInvalidChallenge');
    }
    // The challenge binds this assertion to a user; auth.webauthn_credentials is FORCE RLS keyed on
    // app.current_user_id, so look the credential up inside that user's context.
    const storedCredential = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(challenge.user_public_id),
      () => this.credentialRepository.findActiveByCredentialId(response.id),
    );
    if (storedCredential?.user_id === undefined) {
      throw new UnauthorizedError('errors:webauthnCredentialNotFound');
    }

    const user = await this.userService.requireUserRecordByPublicId(challenge.user_public_id);
    if (!user || user.id !== storedCredential.user_id) {
      throw new UnauthorizedError('errors:webauthnInvalidChallenge');
    }
    // sec-U1: also rejects soft-deleted users.
    assertUserAccountActive({ status: user.status, deleted_at: user.deleted_at });

    const expectedOrigin = resolveWebauthnExpectedOrigin(requestOrigin);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin,
      expectedRPID: resolveWebauthnRelyingPartyId(),
      requireUserVerification: true,
      credential: {
        id: storedCredential.credential_id,
        publicKey: Buffer.from(storedCredential.public_key, 'base64url'),
        counter: storedCredential.counter,
        transports: storedCredential.transports as AuthenticatorTransportFuture[],
      },
    });

    if (!verification.verified) {
      throw new UnauthorizedError('errors:webauthnAuthenticationFailed');
    }

    const { newCounter } = verification.authenticationInfo;
    await withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(user.public_id), () =>
      this.credentialRepository.updateCounter(storedCredential.credential_id, newCounter),
    );

    return completeFirstFactorAuth({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        status: user.status,
        is_email_verified: user.is_email_verified,
        is_mfa_enabled: user.is_mfa_enabled,
      },
      ipAddress,
      userAgent,
      organizationSettingsService: this.organizationSettingsService,
      mfaService: this.mfaService,
      authSessionService: this.authSessionService,
      // Non-pinned path: self-heal a missing personal org into the token (item #5).
      ensurePersonalOrganizationOnMiss: true,
    });
  }

  /**
   * Lists the authenticated user's active (non-revoked) passkeys for the management UI.
   *
   * @remarks
   * - **Algorithm:** resolves the user record, then reads active credentials under the owner DB
   *   context and projects each through {@link serializeWebauthnCredentialList}.
   * - **Failure modes:** `UnauthorizedError` when the user record is missing.
   * - **Side effects:** transient owner-scoped DB context only.
   * - **Notes:** sec-r5-M3 — never emits credential material, the raw WebAuthn `credential_id`
   *   blob, or internal ids; the external `id` is the opaque `wac_` public id.
   */
  async listCredentials(userPublicId: string) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) {
      throw new UnauthorizedError('errors:userNotFound');
    }
    const rows = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => this.credentialRepository.listActiveByUserId(user.id),
    );
    return serializeWebauthnCredentialList(rows);
  }

  /**
   * Revokes one of the authenticated user's passkeys by its public id, refusing to remove the
   * user's last remaining login credential.
   *
   * @remarks
   * - **Algorithm:** under the owner DB context, takes the shared per-user credential-mutation
   *   advisory lock (the same one `deleteMfa` uses, so concurrent passkey/MFA mutations serialize),
   *   resolves the target passkey by public id, and — when it is the only active passkey — refuses
   *   the revoke unless the user retains a login-capable auth method
   *   ({@link AuthMethodService.hasLoginCapableMethod}). Otherwise soft-revokes via
   *   {@link WebauthnCredentialRepository.revokeByUserId} (sets `revoked_at`).
   * - **Failure modes:** `UnauthorizedError` (missing user), `NotFoundError` (no such owned active
   *   passkey), `ConflictError` (`errors:webauthnCannotRevokeLastCredential`) when the revoke would
   *   strip a passkey-only user of every login credential.
   * - **Side effects:** writes `revoked_at` on the credential row; the partial unique index keeps the
   *   raw `credential_id` re-registrable afterwards.
   * - **Notes:** sec-r5-M3 — wires the previously-orphaned `revokeByUserId`. A user with a password /
   *   OAuth / magic-link method may remove every passkey.
   */
  async revokeCredential(userPublicId: string, credentialPublicId: string): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) {
      throw new UnauthorizedError('errors:userNotFound');
    }
    await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      async () => {
        // Serialize concurrent credential mutations for this user so the "is this the last
        // login credential?" check + revoke cannot interleave with a sibling passkey/MFA delete.
        await this.authMethodService.acquireCredentialMutationLock(user.id);
        const active = await this.credentialRepository.listActiveByUserId(user.id);
        const target = active.find((credential) => credential.public_id === credentialPublicId);
        if (!target) {
          throw new NotFoundError('Passkey');
        }
        if (active.length <= 1) {
          const hasOtherLoginMethod = await this.authMethodService.hasLoginCapableMethod(
            user.public_id,
          );
          if (!hasOtherLoginMethod) {
            throw new ConflictError('errors:webauthnCannotRevokeLastCredential');
          }
        }
        await this.credentialRepository.revokeByUserId(user.id, target.id);
      },
    );
  }
}
