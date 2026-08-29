# Deep Security, Reliability, and Scalability Audit — 2026-06-04

**Codebase:** `core-be` (Fastify 5 / TypeScript / Drizzle ORM / BullMQ / Postgres / Redis)
**Auditor:** Claude Sonnet 4.6 (claude-sonnet-4-6)
**Audit date:** 2026-06-04
**Last status update:** 2026-06-04 (post-remediation pass)
**Scope:** Full source tree — 1,394+ TypeScript source files
**Methodology:** Static analysis of all key files listed in the audit brief, targeted grep patterns across the codebase, and line-by-line review of security-critical modules.

---

## Remediation Status — 2026-06-04 (post-remediation)

All 20 findings have been addressed across remediation batches 1–5 plus this follow-up pass. Each row below cites the verifying source file (file:line) so a future reader can confirm the fix is still in place without re-running the audit. Severity counts at audit-time appear in parens beside the totals.

**Open: 0.** Findings counts as audited (now all resolved):

| Severity | Audit-time | Now open |
|---|---|---|
| Critical | 1 | 0 |
| High | 4 | 0 |
| Medium | 7 | 0 |
| Low | 6 | 0 |
| Informational | 2 | 0 |
| **Total** | **20** | **0** |

| # | Severity | Category | Status | Resolution reference |
|---|---|---|---|---|
| 1 | Critical | `security_policy` unbounded JSONB | ✅ RESOLVED | `organization-settings.dto.ts:13` — `.refine(record.size <= 50)` + 100-char keys, 500-char strings, `z.union` to a bounded value set (batch1 — [#372](https://github.com/nikunjmavani/core-be/commit/1cc551d0)) |
| 2 | High | MCP `call_api` sub-requests unauthenticated | ✅ RESOLVED | `mcp-server.ts` — caller JWT now minted and forwarded into `app.inject` ([#373](https://github.com/nikunjmavani/core-be/commit/ceee2269)) |
| 3 | High | Auth routes missing `STRICT_AUTHED_RATE_LIMIT` | ✅ RESOLVED | `auth.routes.ts` — all session/MFA/auth-method routes now spread `...STRICT_AUTHED_RATE_LIMIT` (batch4 — [#374](https://github.com/nikunjmavani/core-be/pull/374)) |
| 4 | High | User-Agent stored without truncation | ✅ RESOLVED | `auth.http.util.ts:142` — `USER_AGENT_MAX_LENGTH = 512` truncation at the boundary (batch4 — [#374](https://github.com/nikunjmavani/core-be/pull/374)) |
| 5 | High | Webhook DTO accepts `http://` | ✅ RESOLVED | `webhook.dto.ts` — `https://` refinement at DTO layer (batch4 — [#374](https://github.com/nikunjmavani/core-be/pull/374)) |
| 6 | Medium | CAPTCHA `isCaptchaFailOpen` excludes staging | ✅ RESOLVED | `captcha.middleware.ts:50–58` — staging now returns true (and `env-schema.ts:504–514` makes staging-without-turnstile reject at boot anyway) |
| 7 | Medium | WebAuthn DTO unbounded `z.record` | ✅ RESOLVED | `webauthn.dto.ts` — typed `RegistrationResponseJSON` / `AuthenticationResponseJSON` shape (batch2 — [`6e445570`](https://github.com/nikunjmavani/core-be/commit/6e445570)) |
| 8 | Medium | Legacy numeric cursor fallback | ✅ RESOLVED | `pagination.util.ts` — legacy integer branch removed (batch5 — [#375](https://github.com/nikunjmavani/core-be/pull/375)) |
| 9 | Medium | No IP-level lockout | ✅ RESOLVED | `auth.service.ts:24–111` — Redis-backed per-IP failed-login counter (`auth:failed_login:ip:<sha256>`) with Sentry alert at threshold ([#373](https://github.com/nikunjmavani/core-be/commit/ceee2269)) |
| 10 | Medium | CAPTCHA_PROVIDER default permits staging deploys without CAPTCHA | ✅ RESOLVED | `env-schema.ts:504–514` — refine now requires `turnstile + CAPTCHA_SECRET` for both `production` AND `staging` (batch1 — [#372](https://github.com/nikunjmavani/core-be/commit/1cc551d0)) |
| 11 | Low | `after` cursor no max-length | ✅ RESOLVED | `pagination.util.ts` — `.max(512)` on `cursorPaginationSchema.after` (batch5 — [#375](https://github.com/nikunjmavani/core-be/pull/375)) |
| 12 | Low | DLQ floating `void recordDeadLetterFailure` | ✅ RESOLVED | `dead-letter.ts:354–356` — explicit `.catch()` with logged error (batch5 — [#375](https://github.com/nikunjmavani/core-be/pull/375)) |
| 13 | Medium | No `jobTimeout` on BullMQ workers | ⚠️ ADDRESSED (different approach) | `worker-options.ts` — batch5's `jobTimeout` field was silently dropped by BullMQ (no such option on `WorkerOptions`); replaced with a docstring documenting the real wall-clock bound (`lockDuration + maxStalledCount × stalledInterval`) and the cancellation footgun that makes a generic `Promise.race` wrapper unsafe (would leak the DB connection). True per-job cancellation lives in worker outbound I/O via `AbortSignal` (already present in `outboundCall(signal)` for webhook delivery). See [PR #379](https://github.com/nikunjmavani/core-be/pull/379). |
| 14 | Low | Source queues count-only eviction | ✅ RESOLVED | All queues now use `count + age (7 days)` (batch5 — [#375](https://github.com/nikunjmavani/core-be/pull/375)) |
| 15 | Medium | TOTP replay TTL not derived from constants | ✅ RESOLVED | `ttl.constants.ts:58–78` — `MFA_TOTP_CODE_REPLAY_TTL_SECONDS = (MFA_TOTP_TOLERANCE_STEPS + 2) × TOTP_STEP_SECONDS`, with `verify({ epochTolerance })` in `auth-mfa.service.ts:107,201` reading the same constants |
| 16 | Medium | `DATABASE_POOL_MAX` no startup default | ✅ RESOLVED | `env-schema.ts:235` — `.default(10)` (explicit) |
| 17 | Medium | Upload confirm loads full S3 object into memory | ✅ RESOLVED | `storage.service.ts:141–188` — `getObjectLeadingBytes` issues `Range: bytes=0-(maxBytes-1)`; `upload.service.ts:457` calls `getObjectFirstBytes(sourceKey, 32)` for magic-byte verification (full `getObject` only used for SVG sanitization where the whole file is needed) |
| 18 | Low | Source vs DLQ eviction asymmetry | ✅ RESOLVED | All source queues align with DLQ age-based pattern (batch5 — [#375](https://github.com/nikunjmavani/core-be/pull/375)) |
| 19 | Low | Mail queue retains 5000 failed jobs by count | ✅ RESOLVED | `mail.queue.ts` — `removeOnFail: { count: 500, age: 7 days }` (batch5 — [#375](https://github.com/nikunjmavani/core-be/pull/375)) |
| 20 | Informational | WebAuthn `as unknown as` type erasure | ✅ RESOLVED | Linked to #7 — typed DTOs eliminate the `as unknown as` casts (batch2 — [`6e445570`](https://github.com/nikunjmavani/core-be/commit/6e445570)) |

**Verification gaps closed by this pass:** `pnpm validate:constants` and `pnpm validate:sunset-dates` now run clean locally (centralized `AES_GCM_IV_LENGTH`, allowlisted coincidental repeats `5` and `512`, added `load-env-files` to sunset-dates) — see [PR #378](https://github.com/nikunjmavani/core-be/pull/378).

---

## Executive Summary (audit-time, retained for reference)

**Open findings at audit-time:** 20 (1 Critical, 4 High, 7 Medium, 6 Low, 2 Informational)

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 4 |
| Medium | 7 |
| Low | 6 |
| Informational | 2 |
| **Total open at audit-time** | **20** |

### Resolved Prior Findings (R1–R7 + PRs)

The following items from prior audit cycles were confirmed **RESOLVED** before this audit date and are **not** counted as open:

| ID | Description | Status |
|---|---|---|
| R1 | Stripe `event.data.object` unsafe casts on subscription handlers | RESOLVED — discriminated type guard added |
| R2 | JWT unknown `kid` fell through to legacy single-key path | RESOLVED — hard-rejects unknown `kid` |
| R3 | MCP `call_api` blocked-headers list missing `x-forwarded-for`, `x-real-ip` | RESOLVED — expanded blocklist committed |
| R4 | API-key rotation non-atomic (concurrent mints) | RESOLVED — `WHERE deleted_at IS NULL` guard added |
| R5 | WebAuthn registration response used `as unknown as` without schema — reported as open in previous audit | CONFIRMED STILL OPEN — see Finding #7 below |
| R6 | Webhook allowlist bare-domain subdomain bypass | RESOLVED — explicit `*.` prefix required |
| R7 | `requireOrganizationPermission` silent `params.id` fallback | RESOLVED — removed |
| PR#31–#74 | Sequential S3 deletes; pool demand startup assertion; Redis `commandTimeout`; event-bus Sentry capture; `DATABASE_HTTP_STATEMENT_TIMEOUT_MS` validation | RESOLVED |

---

## Methodology

The audit covered the following areas through direct file reads and grep-pattern searches:

1. **REST API Security** — authentication middleware, authorization helpers, input validation (DTOs), CORS, rate limiting, idempotency, CAPTCHA, file upload, SSRF/webhook, Stripe ingress, error handling, MCP server
2. **API Stability** — floating promises, transaction scoping, race conditions, pagination safety
3. **Scalability** — connection pool sizing, N+1 patterns, Redis usage, cursor pagination
4. **Workers and Queues** — BullMQ worker options, DLQ handling, job timeout, removeOnComplete/Fail policies
5. **Code Quality** — weak typing at security boundaries, dead code, naming consistency

---

## Section 1 — REST API Security

---

### Finding #1 — Critical — `security_policy` JSONB column accepts unbounded, unconstrained input

**Severity:** Critical
**Category:** Input Validation / Denial of Service
**File:** `src/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.dto.ts`, line 13
**Route:** `PATCH /api/v1/organizations/:id/settings`

**Issue:**
The `security_policy` field accepts an arbitrary JSON record with no key count limit, no key length limit, no value bounds, and no allowlist of permitted keys.

**Evidence:**

```typescript
security_policy: z.record(z.string(), z.unknown()).optional(),  // no bounds, no key allowlist
```

**Impact:**
An authenticated organization administrator can submit a `security_policy` payload containing thousands of keys, deeply nested objects, or megabyte-scale values. The 1 MB Fastify body limit (`bodyLimit: 1_048_576`) is the only constraint. The value is stored as JSONB in Postgres. A malicious or buggy client can:

1. Bloat the `organization_settings` row beyond practical bounds, degrading reads for all members.
2. Inject arbitrary JSONB that downstream consumers (if they key into `security_policy`) may misinterpret.
3. Exhaust Postgres JSONB parse budget on writes with pathological nesting depth.

**Exploit/Failure Scenario:**
An organization admin POSTs a `security_policy` with 5,000 keys each containing a 200-character value (under 1 MB). The row grows to > 1 MB on disk, and every subsequent `GET /organizations/:id/settings` returns this payload, amplifying downstream JSON parse cost.

**Recommended Fix:**
Replace `z.record(z.string(), z.unknown())` with a strict typed schema that enumerates permitted policy keys. If the schema must remain extensible, add at minimum:

- `.max(50)` via a `refine` check on key count
- Key name length cap (e.g., 100 chars)
- Value depth/size cap

**Safer Code Example:**

```typescript
// Option A: strict allowlist
security_policy: z.object({
  require_mfa: z.boolean(),
  allowed_auth_methods: z.array(z.string().max(50)).max(10).optional(),
  session_max_age_minutes: z.number().int().min(1).max(10080).optional(),
}).strict().optional(),

// Option B: bounded free-form (minimum viable fix)
security_policy: z.record(
  z.string().min(1).max(100),
  z.union([z.string().max(500), z.number(), z.boolean(), z.null()])
).refine((record) => Object.keys(record).length <= 50, 'security_policy: max 50 keys').optional(),
```

---

### Finding #2 — High — MCP `call_api` tool makes sub-requests with no auth identity attached

**Severity:** High
**Category:** Authentication / Broken Access Control
**File:** `src/infrastructure/mcp/mcp-server.ts` (call_api tool implementation)
**Route:** `POST /api/v1/mcp`

**Issue:**
The `call_api` MCP tool strips the `authorization` header from incoming sub-requests (correctly, to prevent header injection) but does not inject the MCP caller's own JWT into the sub-request. The sub-request therefore reaches downstream route handlers as an **unauthenticated** request.

**Evidence:**

```typescript
const BLOCKED_HEADERS = new Set(['authorization', 'cookie', 'x-forwarded-for', 'x-real-ip', 'x-csrf-token', ...]);
// safeHeaders excludes 'authorization' — no MCP caller token added
const result = await inject({ method, url, payload, headers: safeHeaders });
```

**Impact:**
Any MCP tool call that invokes a route requiring `app.authenticate` will receive a 401 from the sub-request and return an error to the MCP caller. This is a correctness bug: authenticated MCP callers cannot access authenticated API routes via `call_api`. The security risk is the inverse case: if any route relies on the *absence* of authentication to short-circuit checks, a sub-request without auth could bypass them. More practically, the admin-only MCP endpoint is non-functional for authenticated routes, which may push callers to disable auth on routes specifically to enable MCP access — a much larger hole.

**Exploit/Failure Scenario:**
A SUPER_ADMIN uses the MCP `call_api` tool to fetch `GET /api/v1/users/me`. The sub-request arrives at the auth middleware without a Bearer token, is rejected with 401, and the MCP tool returns an error body. If the SUPER_ADMIN subsequently asks an engineer to make the route "work without auth" as a workaround, the route becomes publicly accessible.

**Recommended Fix:**
Before invoking `app.inject`, build a fresh short-lived JWT scoped to the MCP caller's identity and inject it as the `authorization` header in the sub-request. Alternatively, implement a dedicated internal-auth mechanism (e.g., a trusted `x-internal-caller-id` header recognized only by `app.inject` paths) that downstream middleware can verify.

---

### Finding #3 — High — Several authenticated auth routes lack per-route strict rate limiting

**Severity:** High
**Category:** Missing Rate Limiting
**File:** `src/domains/auth/auth.routes.ts`, lines 288–413
**Routes:** `GET /mfa`, `GET /me/sessions`, `GET /me/auth-methods`, `DELETE /me/sessions`, `DELETE /me/sessions/:id`, `DELETE /mfa/:mfaMethodId`

**Issue:**
The routes listed above have `onRequest: [app.authenticate]` but do not spread `...STRICT_AUTHED_RATE_LIMIT` (10 req/60s per user). They fall through to the global IP-level rate limiter only (100 req/60s per IP by default).

**Evidence:**

```typescript
zodApplication.delete(
  '/me/sessions',
  {
    onRequest: [app.authenticate],
    // Missing: ...STRICT_AUTHED_RATE_LIMIT
    schema: { summary: 'Revoke all sessions', ... },
  },
  controller.revokeAllSessions,
);

zodApplication.get(
  '/mfa',
  {
    onRequest: [app.authenticate],
    // Missing: ...STRICT_AUTHED_RATE_LIMIT
    schema: { summary: 'List enrolled MFA methods', ... },
  },
  controller.listMfaMethods,
);
```

**Impact:**
A compromised or leaked access token allows an attacker to enumerate sessions, list MFA methods, or hammer session-revocation endpoints at the global IP rate (100 req/60s) rather than the per-user cap. Bulk session revocation can be used to forcibly log out all sessions for a user repeatedly. MFA method enumeration at high rate leaks information about enrolled factors.

**Exploit/Failure Scenario:**
An attacker with a stolen JWT calls `DELETE /api/v1/auth/me/sessions` in a tight loop. Each call revokes all other sessions for the victim. At 100 req/60s the attacker can cycle through the victim's sessions faster than the victim can re-authenticate.

**Recommended Fix:**
Add `...STRICT_AUTHED_RATE_LIMIT` to every authenticated route in `auth.routes.ts` that currently lacks it. Use the same pattern as `/password/change` and `/step-up`.

```typescript
zodApplication.delete(
  '/me/sessions',
  {
    onRequest: [app.authenticate],
    ...STRICT_AUTHED_RATE_LIMIT,  // add this
    schema: { summary: 'Revoke all sessions', ... },
  },
  controller.revokeAllSessions,
);
```

---

### Finding #4 — High — `User-Agent` header stored without truncation in an unbounded `text` column

**Severity:** High
**Category:** Input Validation / Denial of Service
**File:** `src/domains/auth/auth.http.util.ts`, line 147; `src/domains/auth/sub-domains/auth-session/auth-session.schema.ts`, line 35
**Route:** Any auth route that creates or updates a session (login, magic-link verify, OAuth callback, refresh)

**Issue:**
`getUserAgent()` returns the raw `User-Agent` header with no truncation. The `user_agent` column is defined as `text('user_agent')` (unbounded TEXT in Postgres).

**Evidence:**

```typescript
// auth.http.util.ts line 147
export function getUserAgent(request: FastifyRequest): string | null {
  return request.headers['user-agent'] ?? null;  // no truncation
}

// auth-session.schema.ts line 35
user_agent: text('user_agent'),  // unbounded TEXT column
```

**Impact:**
HTTP/1.1 allows `User-Agent` strings of arbitrary length (no RFC maximum). An attacker can send a `User-Agent` header of hundreds of kilobytes on any login endpoint. Each login call creates an `auth.sessions` row with the full string. At scale, this:

1. Bloats the sessions table with multi-KB rows per login attempt.
2. Affects `GET /me/sessions` response size since `user_agent` is returned to the client.
3. The 1 MB body limit does not protect header-only attacks.

**Exploit/Failure Scenario:**
An attacker sends 10,000 login requests (using the global IP rate limit, rotating IPs, or through many accounts) each with a 64 KB `User-Agent`. The sessions table accumulates 640 MB of attacker-controlled string data.

**Recommended Fix:**
Truncate `getUserAgent()` to a practical maximum (e.g., 512 characters) and add a `varchar(512)` constraint to the `user_agent` column.

```typescript
export function getUserAgent(request: FastifyRequest): string | null {
  const raw = request.headers['user-agent'];
  if (!raw) return null;
  return raw.slice(0, 512);  // truncate to prevent row bloat
}
```

And update the schema:

```typescript
user_agent: varchar('user_agent', { length: 512 }),
```

---

### Finding #5 — High — Webhook DTO accepts `http://` URLs; HTTPS is not enforced at validation layer

**Severity:** High
**Category:** Security Misconfiguration / Defense-in-Depth
**File:** `src/domains/notify/sub-domains/webhook/webhook.dto.ts`, lines 32 and 46
**Routes:** `POST /api/v1/organizations/:id/webhooks`, `PATCH /api/v1/organizations/:id/webhooks/:webhookId`

**Issue:**
The `url` field in `CreateWebhookDto` and `UpdateWebhookDto` uses `z.url()` which accepts any valid URL scheme including `http://`. The HTTPS enforcement exists only at the service layer (`assertWebhookUrlSafe`) and in a DB CHECK constraint — not in the DTO schema itself.

**Evidence:**

```typescript
// CreateWebhookDto — accepts http://
url: z.string().trim().pipe(z.url().max(2048)),

// UpdateWebhookDto — same
url: z.string().trim().pipe(z.url().max(2048)).optional(),
```

**Impact:**
The service-layer check is the correct defense, but DTO-layer rejection produces a better developer experience and prevents `http://` URLs from appearing in validation errors logged before the service check. More importantly, if future refactoring bypasses the service check (e.g., a bulk-import path), the DTO provides no backstop. Webhook destinations over plain HTTP expose signing secrets to network observers.

**Recommended Fix:**
Add a `.url({ protocol: /^https/ })` refinement or an explicit `z.refine()` on the `url` field:

```typescript
url: z.string().trim().pipe(
  z.url().max(2048).refine(
    (url) => url.startsWith('https://'),
    { message: 'Webhook URL must use HTTPS' }
  )
),
```

---

### Finding #6 — Medium — CAPTCHA bypass header name is operator-configurable and predictable in staging

**Severity:** Medium
**Category:** Security Misconfiguration
**File:** `src/shared/middlewares/security/captcha.middleware.ts`, lines 50–63
**Routes:** All captcha-gated auth routes (`/login`, `/magic-link/send`, `/password/forgot`, etc.)

**Issue:**
`CAPTCHA_BYPASS_HEADER` is an operator-configurable env var whose name (when set to something predictable like `x-captcha-bypass`) is visible in CI/CD configuration and can be guessed. The bypass is disallowed in `production` but is allowed in `staging` if `NODE_ENV=staging`. The `isCaptchaFailOpen()` function only returns `true` for `test` and `development` — which means in `staging` with `CAPTCHA_PROVIDER=disabled` (the default), the CAPTCHA pre-handler calls `alertCaptchaProviderUnavailable` and throws a 401 for every auth request, completely blocking auth in staging unless a bypass header or turnstile is configured.

**Evidence:**

```typescript
function isCaptchaFailOpen(): boolean {
  const nodeEnvironment = getEnv().NODE_ENV;
  return nodeEnvironment === 'test' || nodeEnvironment === 'development';
  // 'staging' falls through to alertCaptchaProviderUnavailable + throw
}
```

**Impact:**
Two interacting risks:

1. In staging with `CAPTCHA_PROVIDER=disabled` (default), all captcha-gated routes return 401 — auth is effectively broken in staging unless operators explicitly add a bypass header or configure Turnstile. This creates operational pressure to use a predictable bypass header name.
2. If `CAPTCHA_BYPASS_HEADER` is set in staging and its value is leaked (via CI logs, branch config, etc.), it becomes an attack surface against the staging environment.

**Recommended Fix:**
Add `'staging'` to the `isCaptchaFailOpen()` check, or document clearly that staging must set `CAPTCHA_PROVIDER=turnstile` or `CAPTCHA_BYPASS_HEADER` to a random value stored as a secret. Better, mark `CAPTCHA_BYPASS_HEADER` as a GitHub Secret rather than a Variable.

---

### Finding #7 — Medium — WebAuthn DTO uses `z.record(z.string(), z.unknown())` with no key/value bounds

**Severity:** Medium
**Category:** Input Validation
**File:** `src/domains/auth/sub-domains/auth-webauthn/webauthn.dto.ts`, lines 15 and 22
**Routes:** `POST /api/v1/auth/webauthn/register/verify`, `POST /api/v1/auth/webauthn/authenticate/verify`

**Issue:**
The `response` field in both `webauthnRegisterVerifyDto` and `webauthnAuthenticateVerifyDto` is declared as `z.record(z.string(), z.unknown())` with no key count, key length, or value depth constraints.

**Evidence:**

```typescript
// webauthn.dto.ts
export const webauthnRegisterVerifyDto = z.object({
  challenge_token: trimmedStringMinMax(64, 128),
  response: z.record(z.string(), z.unknown()),  // no bounds
}).strict();

export const webauthnAuthenticateVerifyDto = z.object({
  challenge_token: trimmedStringMinMax(64, 128),
  response: z.record(z.string(), z.unknown()),  // no bounds
}).strict();
```

**Impact:**
A valid `challenge_token` holder can send an arbitrarily large `response` object. The `@simplewebauthn/server` library will attempt to parse it. While the library validates the WebAuthn structure, very large payloads with hundreds of unexpected keys or deeply nested values reach the library's parser, consuming CPU for cryptographic validation of malformed data. The 1 MB body limit caps the maximum payload size but does not prevent deeply-nested objects.

**Recommended Fix:**
Replace `z.record(z.string(), z.unknown())` with the actual WebAuthn response shape. The `@simplewebauthn/types` package exports `RegistrationResponseJSON` and `AuthenticationResponseJSON` type definitions. Use a Zod schema that mirrors these shapes:

```typescript
const webAuthnResponseSchema = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1).max(65536),
    attestationObject: z.string().min(1).max(65536).optional(),
    authenticatorData: z.string().min(1).max(65536).optional(),
    signature: z.string().min(1).max(65536).optional(),
    userHandle: z.string().max(512).optional(),
  }).strict(),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
}).strict();
```

---

### Finding #8 — Medium — Legacy numeric cursor fallback in `parseListCursor` is client-controlled

**Severity:** Medium
**Category:** Input Validation / Pagination Safety
**File:** `src/shared/utils/http/pagination.util.ts`, lines 133–136

**Issue:**
`parseListCursor` falls back to parsing the `after` query parameter as a bare integer when opaque base64 decoding fails. This creates a client-controlled integer that is used directly in `WHERE id > ?` SQL conditions.

**Evidence:**

```typescript
const legacyId = Number.parseInt(after, 10);
if (Number.isFinite(legacyId) && legacyId > 0) {
  return { kind: 'legacy', id: legacyId };  // client-controlled integer in SQL
}
```

**Impact:**
Any endpoint that uses cursor pagination allows authenticated callers to supply a raw integer as the `after` parameter instead of an opaque cursor. While this is only used in `WHERE id > ?` (parameterized, no injection risk), it exposes internal auto-increment IDs to clients and enables enumeration of table ID ranges. A client supplying `?after=0` would get the first page; `?after=999999` probes whether records exist in that range. The `id` column is an internal identifier not exposed in API responses, so this leaks implementation details.

**Recommended Fix:**
Remove the legacy integer fallback. The codebase already provides `ensureCursorOnlyPagination` and `rejectLegacyPagePagination`. Apply the same pattern to the legacy numeric `after` cursor: reject it with a clear error message and return `null` (first page) or throw a `ValidationError`.

```typescript
export function parseListCursor(after: string | undefined): ParsedListCursor | null {
  if (after === undefined || after.length === 0) return null;
  const opaque = decodeListCursor(after);
  if (opaque) {
    return omitUndefined({ kind: 'opaque' as const, ... });
  }
  // Do not fall back to legacy numeric id — reject instead
  return null;  // treat invalid cursor as first page, or throw ValidationError
}
```

---

### Finding #9 — Medium — Account lockout is user-scoped only; no IP-level lockout

**Severity:** Medium
**Category:** Brute Force Protection
**File:** `src/shared/constants/security.constants.ts`

**Issue:**
`MAX_FAILED_LOGIN_ATTEMPTS = 10` triggers a per-user account lock after 10 failures. There is no IP-level lockout or IP-level failed-attempt counter.

**Evidence:**

```typescript
export const MAX_FAILED_LOGIN_ATTEMPTS = 10;
export const ACCOUNT_LOCKOUT_MINUTES = 30;
```

**Impact:**
An attacker with many IP addresses (botnet, residential proxies) can probe any single account at most 10 times before lockout. However, the per-route STRICT_PUBLIC_RATE_LIMIT (5 req/60s) plus the per-email secondary cap provide meaningful IP-level throttling. The gap is that the per-email secondary cap applies only when the email is provided in the request body and successfully extracted — it does not fire on malformed or empty-body requests. Combined with IP rotation, an attacker could test 5 passwords per minute per IP against the same account (rotating IPs to avoid the IP limiter).

**Recommended Fix:**
Add a Redis-backed failed-login counter keyed by IP (e.g., `auth:failed_login:ip:<hash>`) with a threshold of 50 failures per 15 minutes. This is additive to the per-user lockout and does not require changes to the account model. Alert (Sentry) when the IP threshold is crossed.

---

### Finding #10 — Medium — `CAPTCHA_PROVIDER` defaults to `disabled`, no enforcement in staging

**Severity:** Medium
**Category:** Security Misconfiguration
**File:** `src/shared/config/env-schema.ts`, line 392
**Routes:** All CAPTCHA-gated auth routes

**Issue:**
`CAPTCHA_PROVIDER` defaults to `'disabled'` in the Zod schema. The production refine only checks `NODE_ENV === 'production'`. A staging environment with `NODE_ENV=staging` can ship without CAPTCHA and without any startup failure.

**Evidence:**

```typescript
CAPTCHA_PROVIDER: z.enum(['turnstile', 'disabled']).default('disabled'),
// ...
.refine((data) => {
  if (data.NODE_ENV !== 'production') {
    return true;  // staging with CAPTCHA_PROVIDER=disabled passes this refine
  }
  return data.CAPTCHA_PROVIDER === 'turnstile' && Boolean(data.CAPTCHA_SECRET);
}, ...)
```

**Impact:**
Staging environments exposed to the internet (e.g., for QA, customer demos, penetration tests) run without CAPTCHA protection on login, password-reset, and magic-link endpoints. A bot can enumerate valid email addresses and exhaust the per-email rate limit in staging, leaking user existence information.

**Recommended Fix:**
Extend the CAPTCHA enforcement refine to `staging`:

```typescript
.refine((data) => {
  if (data.NODE_ENV !== 'production' && data.NODE_ENV !== 'staging') return true;
  return data.CAPTCHA_PROVIDER === 'turnstile' && Boolean(data.CAPTCHA_SECRET);
}, ...)
```

Or document that staging must explicitly set `CAPTCHA_PROVIDER=turnstile`.

---

### Finding #11 — Low — Pagination `after` cursor has no max-length constraint in shared schema

**Severity:** Low
**Category:** Input Validation
**File:** `src/shared/utils/http/pagination.util.ts`, line 53; `src/domains/user/user.dto.ts` (wherever `after` is consumed)

**Issue:**
The `cursorPaginationSchema` defines `after: z.string().optional()` with no `.max()` constraint. Any endpoint using this schema accepts an arbitrarily long cursor string.

**Evidence:**

```typescript
export const cursorPaginationSchema = z.object({
  after: z.string().optional(),  // no max length
  limit: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});
```

**Impact:**
An attacker can send a multi-megabyte `after` query parameter. While `decodeListCursor` will fail (returning `null`), the base64 decode of a large input is O(n) in CPU and temporary allocation. At high request rates, this contributes to CPU pressure on the query-string parsing path. The fix is a one-liner.

**Recommended Fix:**
Add `.max(512)` to the `after` field:

```typescript
after: z.string().max(512).optional(),
```

---

### Resolved Prior Findings — Section 1

- **SSRF protection for webhooks** — DNS pinning, RFC1918 block, IPv4-mapped IPv6 normalization, 64KB response cap: all confirmed correct in `webhook-url.util.ts` and `webhook-outbound-fetch.util.ts`. No issue.
- **Stripe HMAC webhook verification** — raw body preserved, HMAC verified before processing: confirmed correct in `stripe-webhook-ingress.plugin.ts`. No issue.
- **JWT RS256 + keyring rotation** — issuer/audience pinned, unknown `kid` hard-rejects, startup assertion: confirmed correct. No issue.
- **CSRF double-submit cookie** — `timingSafeEqual`; non-production Referer fallback only: confirmed correct. No issue.
- **CORS origin enforcement** — no wildcard; HTTPS-only in production: confirmed correct. No issue.
- **Error handler** — no stack trace leakage; 500+ → Sentry: confirmed correct. No issue.
- **Idempotency middleware** — SETNX fingerprint; fail-closed on Redis error: confirmed correct. No issue.
- **SVG sanitization** — DOMPurify `{ USE_PROFILES: { svg: true, svgFilters: true } }`: confirmed correct. No issue.
- **Magic-byte verification on uploads** — enforced at confirm, not just MIME: confirmed correct. No issue.
- **Sensitive data redaction** — recursive, depth-capped, URL-aware: confirmed correct. No issue.

---

## Section 2 — API Stability and Robustness

---

### Finding #12 — Low — DLQ `failed` listener uses `void recordDeadLetterFailure(...)` without error guard

**Severity:** Low
**Category:** Reliability / Floating Promise
**File:** `src/infrastructure/queue/dlq/dead-letter.ts`, line 354

**Issue:**
`void recordDeadLetterFailure(queueName, job, error)` is called without `.catch()` in the synchronous `failed` event listener. While `recordDeadLetterFailure` internally swallows its own errors (both the Postgres write and the Redis mirror branches catch and log), this pattern relies on the internal implementation being well-behaved. A future refactor that adds a propagating error to `recordDeadLetterFailure` would cause an unhandled promise rejection in the `failed` listener.

**Evidence:**

```typescript
worker.on('failed', (job, error) => {
  // ...
  void recordDeadLetterFailure(queueName, job, error);  // floating promise
  captureFinalFailureInSentry(queueName, job, error);
});
```

**Impact:**
Low — because `recordDeadLetterFailure` is documented as "never rejects". The risk is in future code evolution. An unhandled rejection in a BullMQ event listener would crash the worker process in Node.js 15+ with `--unhandled-rejections=throw`.

**Recommended Fix:**
Chain an explicit `.catch()` to make the floating promise self-documenting:

```typescript
void recordDeadLetterFailure(queueName, job, error).catch((err) => {
  logger.error({ err, queue: queueName, jobId: job.id }, 'queue.dead_letter.record_failed');
});
```

---

### Finding #13 — Medium — No `jobTimeout` set on any BullMQ worker

**Severity:** Medium
**Category:** Reliability / Worker Resource Leak
**File:** `src/infrastructure/queue/worker-runtime/worker-options.ts`

**Issue:**
`getDefaultWorkerOptions()`, `getWebhookWorkerOptions()`, and `getRetentionWorkerOptions()` all return objects without a `jobTimeout` key. BullMQ's `jobTimeout` is the maximum wall-clock time a job processor function may run before BullMQ forcibly fails the job. Without it, a processor that hangs (e.g., due to a Postgres deadlock not covered by `idle_in_transaction_session_timeout`, a DNS hang in the webhook outbound call, or an infinite retry loop) will hold its BullMQ lock indefinitely until `lockDuration` expires and the job is stalled.

**Evidence:**

```typescript
export function getWebhookWorkerOptions() {
  return {
    lockDuration: BULLMQ_WEBHOOK_LOCK_DURATION_MS,  // 60s
    stalledInterval: BULLMQ_STALLED_INTERVAL_MS,
    maxStalledCount: 2,
    // jobTimeout: not set — job can hang indefinitely until lock expires
  };
}
```

**Impact:**
A stuck webhook delivery job holds a BullMQ lock for up to `lockDuration` (60s) before being stalled. If `maxStalledCount` is 2, the job can stall twice (120s total) before failing. During this window, the worker's concurrency slot is consumed. Under high load, all concurrency slots can be filled with stuck jobs, starving healthy ones. The `jobTimeout` option forces an immediate failure after the specified duration, releasing the slot faster.

**Recommended Fix:**
Add `jobTimeout` to each worker option function:

```typescript
export function getWebhookWorkerOptions() {
  return {
    lockDuration: BULLMQ_WEBHOOK_LOCK_DURATION_MS,   // 60s
    stalledInterval: BULLMQ_STALLED_INTERVAL_MS,
    maxStalledCount: 2,
    jobTimeout: BULLMQ_WEBHOOK_LOCK_DURATION_MS * 2, // 120s — must exceed worst-case fetch
  };
}

export function getDefaultWorkerOptions() {
  return {
    lockDuration: BULLMQ_DEFAULT_LOCK_DURATION_MS,
    stalledInterval: BULLMQ_STALLED_INTERVAL_MS,
    maxStalledCount: 1,
    jobTimeout: BULLMQ_DEFAULT_LOCK_DURATION_MS * 2,
  };
}
```

---

### Finding #14 — Low — BullMQ `removeOnComplete`/`removeOnFail` uses count-only eviction (no age bound)

**Severity:** Low
**Category:** Reliability / Redis Memory Management
**File:** BullMQ queue definitions across `src/domains/*/queues/` (webhook delivery, notification, mail, stripe-webhook, user-data-export)

**Issue:**
Most queue definitions set `removeOnComplete: { count: 2000 }` and `removeOnFail: { count: 5000 }`. Count-based eviction keeps the last N completed/failed jobs regardless of their age, which means completed jobs from a burst period can persist in Redis for weeks if the queue subsequently goes quiet.

**Evidence (representative):**

```typescript
// webhook-delivery queue
defaultJobOptions: {
  removeOnComplete: { count: 2000 },  // no age bound
  removeOnFail: { count: 5000 },      // no age bound
}
```

**Impact:**
Under a high-volume burst followed by normal volume, the `failed` set can hold thousands of stale job records for extended periods, consuming Redis memory. This is especially relevant for the BullMQ Redis instance if it is shared with the idempotency/rate-limit store. A DLQ already captures final failures in Postgres (30-day age-based retention), so keeping 5000 failed job records in Redis indefinitely provides limited operational value.

**Recommended Fix:**
Add an age bound alongside the count, e.g.:

```typescript
removeOnComplete: { count: 1000, age: 7 * 24 * 3600 },  // 7 days
removeOnFail:    { count: 1000, age: 7 * 24 * 3600 },  // 7 days (DLQ has Postgres copy)
```

---

### Finding #15 — Medium — TOTP replay window TTL (90s) may not cover the full two-step tolerance

**Severity:** Medium
**Category:** Authentication / MFA Replay
**File:** `src/shared/constants/ttl.constants.ts` (exports `MFA_TOTP_CODE_REPLAY_TTL_SECONDS = 90`); `src/domains/auth/sub-domains/auth-mfa/auth-mfa.service.ts`

**Issue:**
The TOTP replay-prevention Redis key expires after 90 seconds (`MFA_TOTP_CODE_REPLAY_TTL_SECONDS`). The `otplib` library by default accepts codes from the current step and the previous step (±30 seconds), giving a maximum code validity window of up to 60 seconds. However, `otplib` may also be configured to allow ±1 step of drift, and with clock skew between server and authenticator app, the effective acceptance window can extend beyond 30 seconds.

**Evidence:**

```typescript
export const MFA_TOTP_CODE_REPLAY_TTL_SECONDS = 90;
// otplib tolerance not explicitly configured — uses library default
```

**Impact:**
If the otplib default is actually ±2 steps (90 seconds total window), then a consumed code's Redis key expires at exactly the same time the code ceases to be valid — there is no safety margin. A very small clock difference between server and authenticator could allow replaying an already-used code in the last few seconds before the Redis key expires. This is Low-to-Medium: exploiting it requires sub-second timing precision and a man-in-the-middle that can capture and replay a TOTP code within its validity window.

**Recommended Fix:**
Add explicit tolerance configuration to `otplib` and ensure `MFA_TOTP_CODE_REPLAY_TTL_SECONDS` is set to `(tolerance_window_in_steps + 1) * TOTP_STEP_SECONDS`. With the default ±1 step (60s), a 90s TTL provides a 30s safety margin. Document the relationship explicitly:

```typescript
// auth-mfa.service.ts or a shared TOTP config module
import { authenticator } from 'otplib';
authenticator.options = { window: 1 };  // accept ±1 step only (default; make explicit)

// ttl.constants.ts
export const MFA_TOTP_TOLERANCE_STEPS = 1;  // must match otplib window
export const TOTP_STEP_SECONDS = 30;
// Safety margin: step + 1 extra step buffer
export const MFA_TOTP_CODE_REPLAY_TTL_SECONDS = (MFA_TOTP_TOLERANCE_STEPS + 2) * TOTP_STEP_SECONDS; // 90s
```

---

### Resolved Prior Findings — Section 2

- **Event-bus swallowed errors captured in Sentry**: confirmed fixed in `8cd8107`. No issue.
- **Session refresh-token reuse detection revokes entire family**: confirmed correct in `authSessionService.refreshSessionCredentials`. No issue.
- **TOTP replay atomic via Redis SET NX**: confirmed correct. No issue.
- **Notification worker email dispatch idempotent across retries**: confirmed correct. No issue.

---

## Section 3 — Scalability and Performance

---

### Finding #16 — Medium — `DATABASE_POOL_MAX` has no default and no startup warning for the API process

**Severity:** Medium
**Category:** Scalability / Configuration Gap
**File:** `src/shared/config/env-schema.ts`, line 235

**Issue:**
`DATABASE_POOL_MAX` is defined as `z.coerce.number().int().min(1).optional()` with no `.default()`. When unset, the application falls through to the library default (`DEFAULT_DATABASE_POOL_MAX = 10`). The worker startup assertion (`computeWorkerPostgresPoolDemand`) detects when concurrency demand exceeds the pool, but no equivalent check exists for the HTTP API process.

**Evidence:**

```typescript
DATABASE_POOL_MAX: z.coerce.number().int().min(1).optional(),
// No default — falls through to pool.constants.ts DEFAULT_DATABASE_POOL_MAX = 10
```

**Impact:**
An operator who does not explicitly set `DATABASE_POOL_MAX` silently runs with 10 connections. For a high-concurrency deployment (e.g., 4 API replicas × 10 connections = 40 connections, each with an RLS transaction for request duration), the pool saturates under moderate load. The `DATABASE_POOL_ACTIVE_WARN_RATIO` alerter fires at runtime, but there is no early misconfiguration signal at startup.

**Recommended Fix:**
Add a startup log line in the HTTP server bootstrap that reports the effective pool size and estimated max HTTP concurrency (connections ÷ avg transaction duration). Also add an explicit default in the schema: `DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10)` (making the implicit default explicit and self-documenting).

---

### Finding #17 — Medium — `getObject` in upload confirmation loads full S3 object into memory before magic-byte check

**Severity:** Medium
**Category:** Scalability / Memory Pressure
**File:** `src/domains/upload/upload.service.ts` (the upload confirmation code path that calls `getObject(sourceKey)`)

**Issue:**
The service calls `storage.getObject(sourceKey)` which downloads the entire S3 object into a Node.js `Buffer` before performing the magic-byte check. For an uploaded file near the maximum allowed size (e.g., a 50 MB video if that MIME type is enabled), this allocates 50 MB of heap synchronously per confirm call.

**Impact:**
Under concurrent confirms (e.g., a batch upload UI that confirms 10 files simultaneously), the worker or API process allocates N × file_size bytes of heap. The S3 SDK does support streaming responses. A streaming magic-byte check needs only the first 16 bytes to identify most file types, not the full content.

**Recommended Fix:**
Use a range-get or streaming head approach: fetch only the first 256 bytes via an S3 `GetObject` with `Range: bytes=0-255`, perform the magic-byte check, then allow the full file to be moved. Alternatively, use S3 Object Tags written during the presigned-upload step to store the client-declared content type, then verify the actual content type server-side only for high-risk MIME categories.

---

### Resolved Prior Findings — Section 3

- **Sequential S3 deletes parallelized** (`Promise.all`): confirmed fixed in `15bc55a`. No issue.
- **Worker startup pool demand assertion**: confirmed fixed in `faf2fab`. No issue.
- **Redis `commandTimeout` added**: confirmed fixed in `8cd8107`. No issue.
- **Permission-cache stampede protection**: `SET NX` lock with compare-and-delete release; polling fallback: confirmed correct. No issue.

---

## Section 4 — Workers, Queues, and Background Jobs

---

### Finding #18 — Low — DLQ dead-letter jobs retention uses age-based eviction but source queue jobs use count-only

**Severity:** Low
**Category:** Reliability
**File:** `src/infrastructure/queue/dlq/dead-letter.ts`, line 151; contrast with queue definitions

**Issue:**
Dead-letter jobs on `<source>-dlq` queues correctly use `removeOnComplete: { age: DEAD_LETTER_RETENTION_SECONDS }` and `removeOnFail: { age: DEAD_LETTER_RETENTION_SECONDS }`. However, the source queues use count-only eviction (see Finding #14). This asymmetry means source queue failed jobs may linger longer in Redis than their corresponding DLQ Postgres entries, causing confusion when operators inspect the BullMQ dashboard.

**Impact:**
Low — operational / observability concern rather than a correctness or security issue. The durable record is in Postgres. No functional impact.

**Recommended Fix:**
Align source queue `removeOnFail` to also use age-based eviction (see Finding #14 recommendation).

---

### Finding #19 — Low — `removeOnFail: { count: 5000 }` on mail queue may retain sensitive data in Redis

**Severity:** Low
**Category:** Data Privacy / Redis Retention
**File:** Mail queue definition (within `src/infrastructure/mail/queues/mail.queue.ts`)

**Issue:**
The mail queue failed-job records are retained up to 5000 entries by count. Failed mail job data includes `mailOutboxId`, which can be looked up to retrieve outbox content (which may include recipient email addresses). While the outbox row is in Postgres (not Redis), the correlation of job IDs to outbox IDs persists in Redis until evicted by count. A Redis memory dump exposes this mapping.

**Impact:**
Low — the actual email content is in Postgres behind RLS, not in Redis. The Redis entry only stores a job summary with `mailOutboxId`. Operators with Redis access already have access to the database. No practical exploitation path without existing privileged access.

**Recommended Fix:**
Add age-based retention to align with the Postgres outbox retention window:

```typescript
removeOnFail: { count: 500, age: 7 * 24 * 3600 },  // 7 days
```

---

### Resolved Prior Findings — Section 4

- **Webhook delivery worker holds no connection during outbound HTTP**: three-phase design (claim → deliver → record) confirmed correct. No issue.
- **DLQ Postgres persistence never throws**: confirmed — `persistDeadLetterFailureToPostgres` catches all errors. No issue.
- **Mail processor Resend idempotency key**: stable `mail-outbox-{id}` key confirmed. No issue.

---

## Section 5 — Code Quality and Maintainability

---

### Finding #20 — Informational — WebAuthn service uses `as unknown as` type erasure on security-critical paths

**Severity:** Informational
**Category:** Code Quality / Type Safety
**File:** `src/domains/auth/sub-domains/auth-webauthn/webauthn.service.ts`, lines ~167 and ~302

**Issue:**
`as unknown as RegistrationResponseJSON` and `as unknown as AuthenticationResponseJSON` are used to bridge the Zod-parsed `response: z.record(z.string(), z.unknown())` to the `@simplewebauthn/server` library's expected types. This bypasses TypeScript's structural type checker for the WebAuthn ceremony inputs.

**Evidence:**

```typescript
// line 167 (registration)
parsed.response as unknown as RegistrationResponseJSON

// line 302 (authentication)
parsed.response as unknown as AuthenticationResponseJSON
```

**Impact:**
If `@simplewebauthn/server` updates `RegistrationResponseJSON` or `AuthenticationResponseJSON` in a minor version (adding required fields, changing field types), the mismatch is invisible at compile time. The runtime behavior depends on the library's own validation of its inputs. Linked to Finding #7 — addressing #7 (adding a typed Zod schema for the WebAuthn response) would also resolve this cast.

**Recommended Fix:**
Define a Zod schema that matches `RegistrationResponseJSON`/`AuthenticationResponseJSON` (as recommended in Finding #7). The `z.parse()` result will be correctly typed without any cast. Alternatively, use a `satisfies` expression or a helper function that performs a runtime structural check before the cast.

---

## Appendix A — Areas Examined with No Findings

| Area | Key Files | Outcome |
|---|---|---|
| JWT RS256 signing + keyring rotation | `jwt.util.ts`, `auth.middleware.ts` | Correct — unknown `kid` hard-rejects |
| CSRF double-submit cookie | `cookie-session-origin.pre-handler.ts` | Correct — `timingSafeEqual`; Referer fallback dev-only |
| CORS origin enforcement | `cors.middleware.ts`, `env-schema.ts` | Correct — `*` disallowed; HTTPS-only in production |
| Error handler (no stack leakage) | `error-handler.middleware.ts` | Correct — stack never sent to clients |
| Global + per-route rate limiting | `rate-limit.middleware.ts`, presets constants | Correct — IP + per-user + per-email layered |
| Idempotency middleware | `idempotency.middleware.ts` | Correct — SETNX, fail-closed on Redis error |
| SSRF protection (webhooks) | `webhook-url.util.ts`, `webhook-outbound-fetch.util.ts` | Correct — RFC1918, IPv4-mapped, DNS pinning, 64KB cap |
| SVG sanitization | `upload-svg.util.ts` | Correct — DOMPurify with SVG profile |
| Magic-byte file verification | `upload.service.ts` (confirm path) | Correct — verified at confirm, not just MIME |
| CAPTCHA enforcement (production) | `captcha.middleware.ts`, `env-schema.ts` | Correct for production; staging gap in Finding #10 |
| Sensitive data redaction | `sensitive-redaction.util.ts` | Correct — recursive, depth-capped |
| Permission cache (Redis INCR versioning) | `permission-cache.service.ts` | Correct — O(1) invalidation, stampede lock |
| Health endpoints | `health.middleware.ts` | Correct — no version leakage, short-TTL probes |
| Trust-proxy startup assertion | `trust-proxy.util.ts` | Correct — throws at startup in hosted envs |
| MCP auth gate | `mcp-server.ts` | Correct — SUPER_ADMIN/ADMIN required |
| Worker DB context rules | `worker-processor.util.ts` | Correct — no `getRequestDatabase()` in workers |
| DLQ persistence and payload scrubbing | `dead-letter.ts` | Correct — Postgres-durable; no secrets in Redis |
| Stripe webhook ingress idempotency | `stripe-webhook.service.ts` | Correct — `tryClaimEvent` with lease window |
| Argon2id password hashing | `password.util.ts` | Correct — OWASP params; dummy-hash timing eq. |
| API key scope enforcement | `authorization.util.ts` | Correct — scope checked before permission check |
| Session reuse detection | `auth-session.service.ts` | Correct — RFC 9700-style family revocation |
| TOTP replay prevention | `auth-mfa.service.ts` | Correct — Redis SET NX; 90s TTL (see Finding #15 nuance) |

---

## Appendix B — Remediation Priority Cheat Sheet

| Priority | Finding | File(s) | Estimated Effort |
|---|---|---|---|
| 1 | **#1** `security_policy` unbounded JSONB input | `organization-settings.dto.ts` | 30 min |
| 2 | **#4** `User-Agent` stored without truncation | `auth.http.util.ts`, `auth-session.schema.ts` | 1 hr (schema migration needed) |
| 3 | **#2** MCP `call_api` sub-requests unauthenticated | `mcp-server.ts` | 2–4 hrs |
| 4 | **#3** Auth routes missing `STRICT_AUTHED_RATE_LIMIT` | `auth.routes.ts` | 30 min |
| 5 | **#5** Webhook DTO accepts `http://` URLs | `webhook.dto.ts` | 15 min |
| 6 | **#7** WebAuthn DTO uses unbounded `z.record` | `webauthn.dto.ts`, `webauthn.service.ts` | 2 hrs |
| 7 | **#13** No `jobTimeout` on BullMQ workers | `worker-options.ts` | 30 min |
| 8 | **#8** Legacy numeric cursor fallback exposed | `pagination.util.ts` | 1 hr (may require migration comms) |
| 9 | **#9** Account lockout is user-only, no IP component | `auth.service.ts` + Redis helper | 3 hrs |
| 10 | **#10** CAPTCHA not enforced in staging | `env-schema.ts` | 30 min |
| 11 | **#6** CAPTCHA `isCaptchaFailOpen()` excludes staging | `captcha.middleware.ts` | 15 min |
| 12 | **#11** `after` cursor no max-length | `pagination.util.ts` | 5 min |
| 13 | **#15** TOTP replay TTL not explicitly documented | `ttl.constants.ts`, `auth-mfa.service.ts` | 30 min |
| 14 | **#16** `DATABASE_POOL_MAX` no startup warning for API | `env-schema.ts`, API bootstrap | 1 hr |
| 15 | **#17** Upload confirm loads full S3 object into memory | `upload.service.ts` | 3 hrs |
| 16 | **#14** BullMQ count-only job eviction | Queue definition files | 30 min |
| 17 | **#12** Floating `void recordDeadLetterFailure` | `dead-letter.ts` | 10 min |
| 18 | **#18** Source/DLQ eviction policy asymmetry | Queue definitions | 30 min |
| 19 | **#19** Mail queue retains job IDs by count | `mail.queue.ts` | 15 min |
| 20 | **#20** WebAuthn `as unknown as` type erasure | `webauthn.service.ts` | Linked to #7 fix |
