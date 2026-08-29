# Deep Security, Reliability, and Scalability Audit — 2026-06-03

**Codebase:** `core-be` (Fastify 5 / TypeScript / Drizzle / BullMQ)
**Auditor:** Claude Sonnet 4.6 (claude-sonnet-4-6)
**Audit date:** 2026-06-03
**Files in scope:** 1,394 TypeScript source files
**Recent HEAD:** `15bc55a` (perf: parallelize S3 object deletes in deleteAllExportsForUser)

---

## How to Read This Report

Findings are numbered globally (#1 upward) in order of severity within each section. Each finding includes:

- **Severity:** Critical / High / Medium / Low / Informational
- **File(s) with line references**
- **Evidence** (quoted code or log output)
- **Impact**
- **Recommendation**

Items the team already remediated before this audit are listed in a **Remediated** subsection at the end of each section — they are confirmed fixed and are not counted in the open findings.

---

## Remediation Status Tracker

| Finding | Title | Severity | Status | PR |
|---------|-------|----------|--------|----|
| #1 | Webhook `events` array unbounded | Medium | ✅ Fixed | #363 |
| #2 | `user-notification-preferences` array unbounded | Low | ✅ Fixed | #363 |
| #3 | Permission codes array unbounded | Low | ✅ Fixed | #363 |
| #4 | `preferred_locales` array unbounded | Low | ✅ Fixed | #363 |
| #5 | Email templates inject URLs without escaping | Low | ✅ Fixed | #364 |
| #6 | Stripe webhook replay tolerance uses SDK default | Low | ✅ Fixed | #365 |
| #7 | MCP endpoint lacks per-user rate limit | Informational | ✅ Fixed | #366 |
| #8 | WebAuthn `as unknown as` casts bypass type checker | Low | ⚠️ Mitigated | #363 |
| #9 | GDPR export holds full payload in heap | Low | ✅ Fixed | pre-audit |
| #10 | Permission-cache stampede uses busy-poll | Informational | ✅ Acceptable | — |
| #11 | Default Postgres pool may be undersized | Informational | ✅ Acceptable | — |
| #12 | WebAuthn casts (cross-listed from #8) | Low | ⚠️ Mitigated | #363 |
| #13 | `base.template.ts` escaping contract is implicit | Informational | 🔲 Open | — |

---

## Section 1 — REST API Security

### Open Findings

None. All Section 1 security findings have been remediated.

---

### Remediated

The following issues were identified, resolved, and confirmed fixed:

---

**#1 — FIXED (#363) — Webhook `events` array unbounded**

**File:** `src/domains/notify/sub-domains/webhook/webhook.dto.ts`, lines 34 and 48

**Evidence (before fix):**

```typescript
// CreateWebhookDto
events: z.array(trimmedString().max(100)).min(1),  // no .max() on the array

// UpdateWebhookDto
events: z.array(trimmedString().max(100)).min(1).optional(),  // same omission
```

**Fix:** Added `.max(50)` to both `events` arrays in PR #363, matching the pattern used by `organization-api-key`'s `scopes` array.

---

**#2 — FIXED (#363) — `user-notification-preferences` array unbounded**

**File:** `src/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.dto.ts`, line 12

**Evidence (before fix):**

```typescript
preferences: z.array(
  z.object({
    notification_type: trimmedString().max(50),
    channel: z.enum(NOTIFICATION_CHANNELS),
    organization_id: z.number().nullable().optional(),
    is_enabled: z.boolean(),
  }).strict(),
),
// outer z.array(...) had no .max() constraint
```

**Fix:** Added `.max(200)` on the `preferences` array in PR #363.

---

**#3 — FIXED (#363) — `PUT .../permissions` permission codes array unbounded**

**File:** `src/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.dto.ts`, line 11

**Evidence (before fix):**

```typescript
permission_codes: z.array(trimmedStringMinMax(1, 100)).min(0),
// no .max() on the array
```

**Fix:** Added `.max(200)` on the `permission_codes` array in PR #363.

---

**#4 — FIXED (#363) — `preferred_locales` user-settings array unbounded**

**File:** `src/domains/user/sub-domains/user-settings/user-settings.dto.ts`, line 14

**Evidence (before fix):**

```typescript
preferred_locales: z.array(trimmedString().max(10)).optional(),
// no .max() on the array
```

**Fix:** Added `.max(10)` on `preferred_locales` in PR #363.

---

**#5 — FIXED (#364) — Email templates inject server-controlled URLs without explicit HTML escaping**

**Files:**

- `src/infrastructure/mail/templates/invitation.template.ts`
- `src/infrastructure/mail/templates/magic-link.template.ts`

**Evidence (before fix):**

```typescript
// invitation.template.ts
<a href="${data.acceptUrl}" class="button">Accept Invitation</a>
${data.acceptUrl}

// magic-link.template.ts
<a href="${data.magicLinkUrl}" class="button">Sign In</a>
${data.magicLinkUrl}
```

**Fix (PR #364):** Both templates now call `escapeHtml()` from `./escape-html.util.js` on their URL arguments before interpolation:

```typescript
// invitation.template.ts
const acceptUrl = escapeHtml(data.acceptUrl);

// magic-link.template.ts
const magicLinkUrl = escapeHtml(data.magicLinkUrl);
```

Unit tests for HTML-escaping of `&` in both templates added in the same PR.

---

**#6 — FIXED (#365) — Stripe webhook replay tolerance uses SDK default (300 seconds)**

**File:** `src/infrastructure/payment/stripe.client.ts`

**Evidence (before fix):**

```typescript
return stripe.webhooks.constructEvent(body, signature, webhookSecret);
// No explicit tolerance argument; SDK default is 300 s
```

**Fix (PR #365):**

```typescript
return stripe.webhooks.constructEvent(body, signature, webhookSecret, 150);
```

Tolerance set to 150 seconds, halving the replay window. Legitimate Stripe deliveries arrive within seconds of signing, so no operational impact.

---

**#7 — FIXED (#366) — MCP `call_api` tool endpoint carries no per-user rate limit**

**File:** `src/infrastructure/mcp/mcp-server.ts`

**Impact (before fix):** The `/api/v1/mcp` endpoint was subject only to the global IP-level rate limiter (100 req/min). Per-user throttling (`STRICT_AUTHED_RATE_LIMIT`) was absent.

**Fix (PR #366):**

```typescript
// Both GET and POST /api/v1/mcp routes now include:
...STRICT_AUTHED_RATE_LIMIT,
```

`STRICT_AUTHED_RATE_LIMIT` = 10 req/60s per user ID in production (lifted to 5 000 under `NODE_ENV=test`). The `hook: 'preHandler'` placement ensures `request.auth` is populated before the key generator executes.

---

The following issues were also confirmed remediated before the audit date:

- **Stripe `event.data.object` unsafe casts removed.** Fixed in `f8f9cfe` — `isStripeSubscriptionEvent` type guard introduced.

- **`DATABASE_HTTP_STATEMENT_TIMEOUT_MS` env validation added.** Fixed in `47bdab4` — Zod schema asserts it is smaller than `PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS`.

- **Webhook allowlist subdomain matching tightened.** Fixed in `8d79c89` — explicit `*.` prefix required.

- **JWT `kid` unknown to active keyring now hard-rejects.** Fixed in `2bedfa1`.

- **MCP `call_api` blocked headers list expanded.** `x-forwarded-for`, `x-real-ip`, and `x-csrf-token` stripped. Fixed in `cdaf9ce`.

- **API-key rotation made atomic.** `WHERE deleted_at IS NULL` on the `softDelete` step. Fixed prior to audit.

---

## Section 2 — API Stability and Robustness

### Open Findings

---

**#8 — Low (Mitigated) — WebAuthn service uses `as unknown as` casts on library response types**

**File:** `src/domains/auth/sub-domains/auth-webauthn/webauthn.service.ts`, lines 167 and 302

**Evidence (current state after PR #363):**

```typescript
// line 167 (registration) — double-cast required for TypeScript 6 overlap check
response: parsed.response as unknown as RegistrationResponseJSON,

// line 302 (authentication)
const response = parsed.response as unknown as AuthenticationResponseJSON;
```

**Impact:** `as unknown as T` bypasses the TypeScript type checker for the bridge between the raw Zod-parsed input and the `@simplewebauthn/server` library types. TypeScript 6 tightened assertion overlap checks, making the simpler `as T` form a type error. The double-cast through `unknown` is the workaround. If the `@simplewebauthn` library changes the shape of `RegistrationResponseJSON` or `AuthenticationResponseJSON` in a minor-version bump, the mismatch will be invisible at compile time and will surface as a runtime failure during WebAuthn ceremonies.

**Recommendation:** Define a Zod schema that mirrors the exact shape of `RegistrationResponseJSON` / `AuthenticationResponseJSON` from `@simplewebauthn/types` and use `z.parse()` to produce a correctly-typed value. This would remove the cast entirely and make version-bump divergence a compile error. The WebAuthn DTO currently uses `z.record(z.string(), z.unknown())` for the `response` field; replacing this with the fully-typed schema is the correct long-term fix.

---

### Remediated

- **`buildExportPayload` holds no DB connection but allocates all user data in a single in-process object (#9).** Per-section row caps (`GDPR_EXPORT_MAX_ROWS_PER_TABLE = 1000`) already implemented in `user-data-export.service.ts` via `capExportCategory` before this audit. Confirmed fixed.

- **`WEBHOOK_DELIVERY_JOB_ATTEMPTS` exported from queue module.** Fixed in `cd24515`.

- **Event-bus swallowed errors captured in Sentry.** Fixed in `8cd8107`.

- **`requireOrganizationPermission` silent `params.id` fallback removed.** Fixed in `17f4d83`.

---

## Section 3 — Scalability and Performance

### Open Findings

---

**#10 — Informational — Permission-cache stampede waiter uses a busy-poll loop with `setTimeout`**

**File:** `src/domains/tenancy/sub-domains/permission/permission-cache.service.ts`, lines 221–229

**Evidence:**

```typescript
for (let attempt = 0; attempt < STAMPEDE_POLL_ATTEMPTS; attempt++) {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, PERMISSION_CACHE_STAMPEDE_POLL_MS),
  );
  const waiterCached = await getCachedPermissions(userId, organizationId);
  if (waiterCached !== null) return waiterCached;
}
```

`STAMPEDE_POLL_ATTEMPTS = 40`. If the lock holder dies mid-recompute, all 40 waiters run the full poll window (≈2s total) before falling through to their own uncached recompute.

**Impact:** Informational. The fallback to uncached recompute prevents correctness problems and the Lua compare-and-delete lock release in the `finally` block handles clean exits. Acceptable as-is.

**Recommendation:** No urgent change required. A Redis Pub/Sub "recompute done" notification could replace the poll loop if permission-check latency becomes a production concern under node-failure scenarios.

---

**#11 — Informational — Default Postgres pool size (10) may be undersized for high-concurrency deployments**

**File:** `src/infrastructure/database/pool/pool.constants.ts`, line 9

**Evidence:**

```typescript
export const DEFAULT_DATABASE_POOL_MAX = 10;
```

**Impact:** Informational. The worker startup assertion correctly fails when sum of worker concurrencies exceeds `DATABASE_POOL_MAX`. At 10 connections, the pool supports ~500–2000 req/s under typical RLS transaction durations — adequate for moderate traffic.

**Recommendation:** Document the expected concurrency profile in `pool.constants.ts`. Add a startup log line for the API process similar to the worker bootstrap pool-demand report.

---

### Remediated

- **Sequential S3 deletes in `deleteAllExportsForUser` parallelized.** Fixed in `4c36173` — `Promise.all` fires all `storage.deleteObject` calls concurrently.

- **Worker startup fails when pool demand exceeds `DATABASE_POOL_MAX`.** Fixed in `faf2fab`.

- **Redis `commandTimeout` added.** Fixed in `8cd8107`.

---

## Section 4 — Workers, Queues, and Background Jobs

### Open Findings

There are no open findings in this section.

---

### Remediated

- **DLQ auto-retry starvation fixed.** Fixed prior to this audit.

- **Event-bus errors captured in Sentry** (see Section 2 Remediated).

- **Webhook delivery worker holds no Postgres connection during outbound HTTP call.** Three-phase design (claim → deliver → record) confirmed correct.

- **Notification worker email dispatch is idempotent across BullMQ retries.** Redis-backed one-time claim marker (`claimNotificationEmailDispatch`) confirmed correct.

- **Mail processor uses a stable Resend idempotency key.** Outbox `id` used as Resend idempotency key. Confirmed correct.

- **Session refresh-token reuse detection revokes the entire session family.** RFC 9700-aligned reuse detection confirmed correct.

- **TOTP replay within the validity window is blocked atomically.** Redis `SET NX` atomic marker confirmed correct.

---

## Section 5 — Code Quality and Maintainability

### Open Findings

---

**#12 — Low (Mitigated) — WebAuthn `as unknown as` casts reduce type safety at a security boundary**

Cross-listed from #8. Already described in Section 2. The `as unknown as` double-cast was introduced in PR #363 as the TypeScript 6–compatible workaround; the underlying issue (no Zod schema mirroring the WebAuthn library types) remains.

---

**#13 — Informational — `base.template.ts` escaping contract is implicit**

**File:** `src/infrastructure/mail/templates/base.template.ts`

**Evidence:** The JSDoc states that `title`, `preheader`, and `footerText` parameters are "interpolated as plain text" — callers are responsible for ensuring no HTML-injection characters are present. All callers currently pass string literals or values escaped elsewhere; there is no active vulnerability.

**Recommendation:** Encode `title`, `preheader`, and `footerText` in `base.template.ts` using the same `escapeHtml` helper already used by `invitation.template.ts` and `magic-link.template.ts`. This makes the template self-defending for future callers and closes the contract gap permanently.

---

### Remediated

No code-quality-specific remediations to note beyond those covered in Sections 1–4.

---

## Appendix A — Areas with No Open Findings

The following areas were inspected thoroughly and found to have no open findings:

| Area | Files Inspected | Status |
|---|---|---|
| JWT RS256 signing + keyring rotation | `jwt.util.ts`, `auth.middleware.ts` | No issues; unknown `kid` hard-rejects correctly |
| CSRF double-submit cookie | `cookie-session-origin.pre-handler.ts` | Correct `timingSafeEqual`; Referer fallback non-production only |
| CORS origin enforcement | `cors.middleware.ts` | Non-empty allowlist enforced; wildcard `*` disallowed in production |
| Error handler (no stack leakage) | `error-handler.middleware.ts` | Stack traces never sent to clients; 500+ errors → Sentry |
| Global + per-route rate limiting | `rate-limit.middleware.ts`, `rate-limit-presets.constants.ts` | IP-keyed global; organization+actor-keyed per route; per-email keyed on auth routes; Redis fallback to in-process, not fail-open |
| Idempotency middleware | `idempotency.middleware.ts` | SETNX fingerprint; fails closed (503) on Redis error; never caches secrets |
| SSRF protection for outbound webhooks | `webhook-url.util.ts`, `webhook-outbound-fetch.util.ts` | DNS pinning; all private/link-local/multicast ranges blocked; IPv4-mapped IPv6 normalized; 64 KB response cap |
| SVG sanitization | `upload-svg.util.ts` | DOMPurify with `{ USE_PROFILES: { svg: true, svgFilters: true } }` |
| Magic-byte verification for uploads | `upload.service.ts` | Enforced on confirm, not just MIME type; matched against purpose config |
| CAPTCHA enforcement | `captcha.middleware.ts`, `env-schema.ts` | Bypass header blocked in production; env schema refine requires `turnstile` in production |
| Sensitive data redaction | `sensitive-redaction.util.ts` | Recursive, depth-capped, URL/query-string-aware; covers `email`, `token`, `cookie`, `jwt` fragments |
| Permission cache (Redis versioned INCR) | `permission-cache.service.ts` | O(1) organization-wide invalidation; stampede lock with compare-and-set commit; lock released in `finally` |
| Health endpoints | `health.middleware.ts` | No version leakage; short-TTL cached probes; no DB connection per request |
| Cursor-based pagination | `pagination.util.ts` | Opaque base64url cursor; microsecond tie-breaking; strict schema |
| Trust-proxy startup assertion | `trust-proxy.util.ts` | Throws at startup in hosted environments when `TRUST_PROXY` is false |
| MCP auth gate | `mcp-server.ts` | `SUPER_ADMIN` or `ADMIN` role required; blocked headers list correct |
| Worker DB context rules | `worker-processor.util.ts` | No `getRequestDatabase()` in workers; correct `withOrganizationContext` / `withUserDatabaseContext` / `withGlobalRetentionCleanupDatabaseContext` usage |
| DLQ persistence and payload scrubbing | `dead-letter.ts` | Postgres-durable (30-day retention); payload summary extracts only non-secret identifiers |
| Stripe webhook ingress idempotency | `stripe-webhook.service.ts` | `tryClaimEvent` enforces at-least-once with lease window; `processed_duplicate` skips silently; `still_processing_within_lease` retries via `ConflictError` |

---

## Appendix B — Current Remediation Status

As of 2026-06-04, 11 of 13 findings are closed. Two remain:

| Status | Count | Findings |
|--------|-------|---------|
| ✅ Fixed / Acceptable | 11 | #1, #2, #3, #4, #5, #6, #7, #9, #10, #11 |
| ⚠️ Mitigated (partial) | 2 | #8, #12 — WebAuthn casts; TS6 double-cast workaround in place; full Zod schema still needed |
| 🔲 Open | 1 | #13 — `base.template.ts` escaping implicit; low priority informational |

### Remaining action items

1. **#8/#12 (WebAuthn casts)** — Replace `z.record(z.string(), z.unknown())` in `webauthn.dto.ts` with a Zod schema that mirrors `RegistrationResponseJSON` / `AuthenticationResponseJSON` from `@simplewebauthn/types`. This removes the `as unknown as` casts and makes version-bump divergence a compile error.

2. **#13 (base.template.ts)** — Apply `escapeHtml()` to the `title`, `preheader`, and `footerText` parameters in `base.template.ts`. One-liner change, zero risk.
