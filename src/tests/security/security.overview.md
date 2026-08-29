`src/tests/security/`

# Security tests

## Purpose

Security-focused regression tests: header configuration, CORS, CSRF, rate-limit enforcement, anti-enumeration on auth endpoints, idempotency-key contract, and tenant-isolation invariants. These tests assert the platform's security posture stays put as the API evolves.

What this suite covers:

- Helmet headers present on every response (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).
- CORS allowlist behavior.
- CSRF model on the session-cookie refresh path (Origin + cookie checks).
- Rate-limit headers + 429 behavior.
- Auth anti-enumeration (identical responses for known / unknown emails).
- Online brute-force caps on passwordless email-code login (per-user attempt ceiling engages, and the capped rejection stays a generic 401 with no lockout/existence oracle — `auth/email-code-brute-force`).
- Idempotency-key contract: missing/malformed → 422, anonymous → 401, no cached entry on unauthenticated writes, **cross-actor isolation** (a shared `X-Idempotency-Key` value never replays one actor's response to another — `infrastructure/idempotency-cross-actor`).
- Recent-step-up enforcement on credential routes (a valid bearer WITHOUT a recent step-up is 403 — `authz/object-ownership`).
- Tenant-isolation invariants (claim-scoped organization, RLS scoping).

What it does **not** cover: dependency vulnerabilities (`pnpm audit`), penetration testing (offline, separate engagement), or full OWASP coverage.

## How to run

```bash
pnpm compose:up && pnpm compose:wait
pnpm db:migrate
pnpm test:security
```

## Fixtures and helpers

- Same as integration tests.
- Header assertions live in `headers/`.
- Auth anti-enumeration tests live in `auth/`.

## Dependencies

- **Postgres + Redis** — required for the auth + tenant tests; not strictly required for static header checks but the suite boots the full app.

## Failure modes

- **Helmet config drift** when upgrading Helmet → the asserted header list may need updating; review the new defaults before pinning.
- **Anti-enumeration drift** if a developer adds a new error code that distinguishes known / unknown email → flagged here; the fix is to use the same generic error for both paths.
