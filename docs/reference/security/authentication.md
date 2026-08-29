# Authentication

core-be supports password login, email verification-code login, OAuth (Google, GitHub), JWT access tokens, session cookies, MFA (TOTP), and organization API keys. Session CSRF and cookie rules are documented in [csrf-and-session-cookies.md](../security/csrf-and-session-cookies.md).

## Current methods

| Method                  | Entry routes                            | Notes                                            |
| ----------------------- | --------------------------------------- | ------------------------------------------------ |
| Email + password        | `POST /api/v1/auth/login`               | May return MFA challenge                         |
| Email verification-code | `POST /api/v1/auth/email/*`             | Passwordless email flow                          |
| OAuth                   | `GET /api/v1/auth/oauth/{provider}`     | PKCE + state cookie                              |
| API key                 | `Authorization: Bearer` with key prefix | Organization-scoped permissions                  |
| MFA                     | TOTP + recovery codes                   | Encrypted secrets at rest                        |
| WebAuthn / passkeys     | `POST /api/v1/auth/webauthn/*`          | FIDO2 credentials in `auth.webauthn_credentials` |

Implementation lives under `src/domains/auth/` (see [sub-domains-layout.md](../architecture/sub-domains-layout.md)).

## Account creation and bot abuse (no CAPTCHA vendor)

There is **no signup endpoint** — account creation is folded into the unified login flows, and both creation paths prove control of the email/identity before granting a session:

- **Email verification-code** — `POST /api/v1/auth/email/send-code` (auto-signs-up an unknown email as a passwordless user, then emails a one-time alphanumeric sign-in code; the account becomes usable only after `POST /api/v1/auth/email/login` consumes a valid code, which proves inbox control and flips `is_email_verified=true`; disposable domains blocked at send time)
- **OAuth** — `GET /api/v1/auth/oauth/{provider}/callback` (new users via `completeOAuthUserSession`; disposable domains blocked before `userService.createFromOAuth`; **claims** a bare invited placeholder — the provider proves control of the email, so the placeholder is flipped to verified and its personal organization provisioned, rather than being blocked by the unverified-account takeover guard)

**Invitation onboarding.** A user added to an organization by email gets a pre-created **bare** account (no credential, `is_email_verified=false`) so the `INVITED` membership has a `user_id`. "Bare" is determined by `AuthMethodService.hasActiveLoginCredential` — no password, **no** login-capable auth method (`PASSWORD`/`OAUTH`/`EMAIL_CODE`), **and no WebAuthn passkey** — so an account holding any real credential (including a passkey-only account) is never misclassified as claimable, regardless of its `is_email_verified` state. The invitee onboards via email verification-code or OAuth — both **claim** the bare row **and flip `is_email_verified=true`** because completing either flow proves control of the inbox. Accepting the invitation (`POST /api/v1/tenancy/invitations/{invitation_id}/accept`) requires authentication, an email **matching** the invitee, **and a verified email** — so a forwarded invite token cannot be used to join without proving email control. A bare invited row is created **without** a personal organization, so each onboarding path provisions one when it claims the account (email verification-code on the first successful login, OAuth post-commit) — best-effort + idempotent. Because that write is best-effort, the personal-organization **read path self-heals**: `GET /users/me` and `POST /auth/switch-to-personal` (via `ensurePersonalOrganization`) provision the organization on demand when personal is enabled and it is missing, so a swallowed signup-time failure never leaves a user stuck without a personal workspace; `tool:backfill-personal-orgs` can also recover misses eagerly.

**Invite-email squatting — eliminated.** Removing password signup closed the prior squatting vector (where a knower of an invited address could set a password on the bare row *without* proving email control). Now **every** account-creation / claim path (email verification-code, OAuth) requires email-control proof before a session is issued, so a bare invited row can only be claimed by someone who actually receives mail at that address.

**Disposable email:** `isDisposableEmailBlocked()` (package `disposable-email-domains-js`) runs on login, email verification-code send, password forgot, OAuth user creation, and member invitations. When blocked, the API returns **400** with `errors:disposableEmail`. Toggle with `BLOCK_DISPOSABLE_EMAIL` (default `true`).

**Rate limits:** Public auth routes (`/login`, `/email/*`, `/oauth/*`, password reset, MFA challenge) use `STRICT_PUBLIC_RATE_LIMIT` — **5 requests per minute per IP** in production (`5000` when `RATE_LIMIT_RELAXED_CAPS` is set, as it is for local development and the test suite). Excess traffic receives **429**.

**CAPTCHA (Cloudflare Turnstile):** When `CAPTCHA_PROVIDER=turnstile` and `CAPTCHA_SECRET` are set, public auth routes require `X-Captcha-Token` from the client widget:

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/email/send-code`
- `POST /api/v1/auth/email/login`
- `POST /api/v1/auth/password/forgot`
- `POST /api/v1/auth/password/reset`
- `POST /api/v1/auth/mfa/login`
- `GET /api/v1/auth/oauth/:provider` (OAuth initiation)

Schema default is `CAPTCHA_PROVIDER=disabled`. In `development`, verification is skipped when Turnstile is not configured (via the `CAPTCHA_FAIL_OPEN` flag). Optional `CAPTCHA_BYPASS_HEADER` (non-production only) allows local testing. Failures return **401** with `errors:captchaRequired` or `errors:captchaInvalid`.

**Production boot guard.** Because `captchaPreHandler` fail-closes when CAPTCHA is unconfigured, a production deploy with the default `CAPTCHA_PROVIDER=disabled` would turn login, email verification-code (send + login), password recovery, MFA challenge, and OAuth initiation into **401**s. Boot fails in production unless Turnstile is fully configured (see `src/shared/config/env-schema.ts`):

| Posture                   | Required env                                    | Auth-route behavior                                                   |
| ------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| **Production (required)** | `CAPTCHA_PROVIDER=turnstile` + `CAPTCHA_SECRET` | Verify `X-Captcha-Token`; fail-closed on missing or invalid tokens.   |
| **Development**           | Default `CAPTCHA_PROVIDER=disabled`             | Middleware fail-opens; optional `CAPTCHA_BYPASS_HEADER` for local UX. |

Outside production (`development`), the middleware fail-opens by default when Turnstile is not configured.

## Email verification-code environment safety

`EmailLoginService.sendCode` **never** returns the raw sign-in code in the JSON body. The code leaves the service only via the `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` event payload (consumed by the mail handler) and the resulting email — identical behavior across every environment. Login is `POST /api/v1/auth/email/login` with `{ email, code }`, gated by a per-user attempt cap. Codes are 6-char alphanumeric and persisted only as a keyed, user-scoped HMAC (never plaintext, never bare sha256).

**Verify-attempt cap resets on each fresh code.** The per-user attempt counter is cleared whenever a new code is issued. This closes a victim-lockout DoS: without it, an attacker who burned the cap would keep the legitimate owner locked out of redeeming a new code. Brute-force is not weakened — each issued code is an independent random target over a large keyspace, only one code is live at a time (each send invalidates the prior), a successful login invalidates any remaining code, and `send-code` is rate-limited per email + IP.

| Guard                     | When it runs                                                  |
| ------------------------- | ------------------------------------------------------------- |
| Zod `FRONTEND_URL` refine | Boot — when set, `FRONTEND_URL` must be a valid `http(s)` URL |

**Test code path:** tests subscribe to `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` via the `captureNextVerificationCode(email)` helper in `src/tests/helpers/verification-code.helper.ts` to obtain the raw code for assertions.

**Deployed environments (Railway development, production):** any valid public `FRONTEND_URL` is accepted. The previous environment-based inline-token leak and its localhost-only `FRONTEND_URL` restriction have been removed.

## WebAuthn (passkeys)

Passkeys use `@simplewebauthn/server` with challenges stored in Redis (`webauthn:challenge:*`, 5-minute TTL).

| Route                                             | Auth   | Purpose                                                 |
| ------------------------------------------------- | ------ | ------------------------------------------------------- |
| `POST /api/v1/auth/me/webauthn/register/options`  | JWT    | Begin enrolment (returns `options` + `challenge_token`) |
| `POST /api/v1/auth/me/webauthn/register/verify`   | JWT    | Complete enrolment; persists public key                 |
| `POST /api/v1/auth/webauthn/authenticate/options` | Public | Begin sign-in (`email` required)                        |
| `POST /api/v1/auth/webauthn/authenticate/verify`  | Public | Complete sign-in; issues JWT + session cookie           |

Environment:

- `WEBAUTHN_RP_ID` — relying party hostname (defaults to first `ALLOWED_ORIGINS` host or `localhost`)
- `WEBAUTHN_RP_NAME` — display name in the passkey prompt (default `core-be`)
- Request `Origin` header is preferred for verification when present

MFA recovery codes (10 single-use) remain under the MFA sub-domain for TOTP backup.

## Related

- [frontend-auth-guide.md](../api/frontend-auth-guide.md) — frontend SPA integration (Bearer + reactive refresh, headers, organization switching)
- [csrf-and-session-cookies.md](../security/csrf-and-session-cookies.md)
- [api-versioning.md](../api/api-versioning.md)
- [data-lifecycle-deletion.md](../data/data-lifecycle-deletion.md) — session retention
- [`src/domains/auth/auth.overview.md`](../../../src/domains/auth/auth.overview.md) — domain overview, the five credential types, anti-enumeration invariant
- [`src/domains/auth/sub-domains/auth-method/auth-method.overview.md`](../../../src/domains/auth/sub-domains/auth-method/auth-method.overview.md) — credential records, token flows
- [`src/domains/auth/sub-domains/auth-mfa/auth-mfa.overview.md`](../../../src/domains/auth/sub-domains/auth-mfa/auth-mfa.overview.md) — TOTP enrolment and challenge
- [`src/domains/auth/sub-domains/auth-webauthn/auth-webauthn.overview.md`](../../../src/domains/auth/sub-domains/auth-webauthn/auth-webauthn.overview.md) — passkey ceremonies
- [`src/POLICIES.md`](../../../src/POLICIES.md) — `JWT_*`, `EMAIL_CODE/VERIFICATION_CODE_*`, `MFA_*`, `LOCKOUT_*`, `STRICT_PUBLIC_RATE_LIMIT` policy constants
