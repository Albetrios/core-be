# Round 4 Post-Audit Residual Risk Review

**Date:** 2026-06-09 (multi-lens audit of dev HEAD after Round 4 PRs #497–#526 + main back-merge)
**Auditor:** Claude (7-lane parallel multi-agent workflow with 2 adversarial skeptics per finding)

## Section 1: Executive Verdict

Dev HEAD is **ready for production traffic** with one tracked operational gating action (disable `DLQ_AUTO_RETRY_ENABLED` until `async-queue-1` is fixed, or land the fix first). No confirmed finding rises to a production-blocking authentication-bypass, authorization-bypass, or data-confidentiality breach. The two confirmed findings are: a state-consistency / documentation gap on PASSWORD auth-method revocation (informational, not attacker-walkable) and a medium-severity audit-integrity + availability bug in the DLQ auto-retry sweeper where RLS denies the audit INSERT, causing replay rows to loop forever and starve later DLQ jobs. The remaining seven findings are partial — real coverage or hygiene gaps with at least one defense layer already in place — and are appropriate as Round 5 / backlog tasks rather than ship-blockers.

| Lens | Verdict | Notes |
| --- | --- | --- |
| auth-session | PASS (1 informational) | PASSWORD revoke leaves `users.password_hash`; state-drift only, no auth bypass |
| authz-rls | PASS | No confirmed residual finding |
| input-validation | PASS | No confirmed residual finding |
| ratelimit-dos | PARTIAL (3) | api-key, member-role, notification-policy lack per-organization cap + route-level limiter |
| crypto-secrets | PARTIAL (1) | `mail_outbox.html` persists live tokens with no purge sweep |
| async-queue | FAIL (1 medium) | DLQ auto-retry audit INSERT denied by RLS; loop + starvation |
| test-coverage | PARTIAL (3) | Turnstile contract, STRICT_AUTHED/EXPENSIVE_AUTHED burst, deprecated-route inventory |

**Headline numbers:** 9 total candidate findings → **2 confirmed**, **7 partial**, **0 refuted**.

## Section 2: Confirmed findings (real residual risks)

### 2.1 `auth-session-info-1` — PASSWORD auth-method revocation does not clear `users.password_hash`

**Severity:** Informational — **Category:** State-consistency / UX (no auth bypass)

**Evidence files + line ranges:**

- `src/domains/auth/sub-domains/auth-method/auth-method.service.ts:132-155`
- `src/domains/auth/sub-domains/auth-method/auth-method.repository.ts:1-20`
- `src/domains/auth/auth.service.ts:113-204`
- `src/domains/user/user.repository.ts:1-40`

**What the code does:** `AuthMethodService.delete(...)` revokes a login-capable auth method by setting `auth_methods.revoked_at` via `AuthMethodRepository.revoke`. It deliberately blocks removal of the *last* login-capable method (`LOGIN_CAPABLE_METHOD_TYPES` guard at lines 141–150), but nothing in this path or anywhere else (grep across `src/` for `password_hash` shows only `updatePassword` + seeds) nullifies `auth.users.password_hash`. Login (`auth.service.ts:113-204`) checks credentials via `userService.findByEmail` → `auth.resolve_user_for_authentication_by_email` (the `SECURITY DEFINER` `SETOF auth.users` resolver), then `verifyPassword(parsed.password, user.password_hash)`. `auth_methods.revoked_at` is never consulted at login. Net effect: a user who has `[PASSWORD, OAUTH]` and "removes" PASSWORD via `DELETE /me/auth-methods/:publicId` sees the password method disappear from `listAuthMethods` (filtered by `revoked_at IS NULL`), but can still authenticate with the original password via `POST /auth/login`.

**Real-world attack walkthrough:** Not attacker-walkable as a security boundary. The `DELETE /me/auth-methods/:publicId` route is gated by `app.authenticate` + `requireRecentStepUpPreHandler`, so only the account owner can hit it, and removing the method does not grant a stolen-credential attacker any capability they did not already have (the password was already valid before). Real-world impact is UX state-drift: an owner who deletes the PASSWORD method to *disable* password login (e.g. after suspected credential leak) gets a false sense of security and may not rotate the password, leaving the leaked credential live.

**Recommendation:** Either (a) document that `DELETE /me/auth-methods/:publicId` for a PASSWORD row is a metadata revoke only and direct users to `/auth/password/change` or `/auth/password/forgot` to actually rotate, or (b) when LOGIN_CAPABLE PASSWORD is revoked, also set `users.password_hash = NULL` inside the same `withUserDatabaseContext` transaction so the user view ("I removed my password") matches the auth view ("password no longer authenticates"). Option (b) makes the invariant real.

**Round 5 or backlog:** **Backlog**. Informational severity, no security boundary crossed; either doc-tightening or a small atomic service change. Track as a normal task.

### 2.2 `async-queue-1` — DLQ replay audit INSERT denied by RLS → every replay loops forever and starves all later DLQ jobs

**Severity:** Medium — **Category:** Audit Integrity / Availability — DLQ replay blocked by RLS (OWASP A09 Logging Failures)

**Evidence files + line ranges:**

- `src/infrastructure/queue/dlq/dlq-replay.util.ts:213-231` (recordDlqAutoRetryAuditEntry)
- `src/infrastructure/queue/dlq/dlq-replay.util.ts:156-185` (recordDlqReplayAuditEntry)
- `src/infrastructure/queue/dlq/dlq-replay.util.ts:251-297`
- `src/infrastructure/queue/dlq/dlq-auto-retry.processor.ts:83-127`
- `src/infrastructure/queue/dlq/dead-letter.repository.ts:30-50`
- `migrations/20260608041000_audit_insert_rls_drop_privilege_bypass.sql:20-32`
- `src/tests/security/rls/audit-insert-rls-privilege-bypass.security.test.ts:63-119`

**What the code does:** After `sec-r4-D1` the `audit.logs` INSERT policy is `organization_id = (SELECT id FROM tenancy.organizations WHERE public_id = current_setting('app.current_organization_id', true))` with **no escape arms**. Both DLQ audit writers — `recordDlqAutoRetryAuditEntry` (called from `autoReplayDeadLetterFromLedger`) and `recordDlqReplayAuditEntry` (called from the SUPER_ADMIN CLI `replayDeadLetterJob`) — call `database.insert(logs).values({...})` **with no `organization_id` AND no `app.current_organization_id` GUC**. The auto-retry processor only wraps the sweep in `withSystemTableWorkerContext`, which pins ALS but never executes `SET LOCAL app.current_organization_id`; the CLI runs entirely outside any context. `WITH CHECK` collapses to `NULL = NULL` → INSERT rejected. `audit-insert-rls-privilege-bypass.security.test.ts:63-90` proves this exact scenario (real `organization_id` + no GUC → "new row violates row-level security policy"). The throw inside `autoReplayDeadLetterFromLedger` is caught at `dlq-auto-retry.processor.ts:124`, skipping `recordDlqAutoRetryAttempt` (line 122) so the Redis counter never advances and the budget-exhausted branch (lines 84–92) that calls `markDeadLetterJobAutoRetryResolved` is unreachable.

**Real-world attack walkthrough:** No attacker needed. The sweeper runs every 5 minutes, selects 20 oldest rows where `auto_retry_resolved_at IS NULL ORDER BY failed_at ASC`. For each: `sourceQueue.add(...)` succeeds, audit INSERT throws (RLS), outer catch logs and continues without bumping the Redis counter. The next sweep selects the **same rows again**, repeating forever. Downstream app-layer idempotency (`tryMarkSending → in_flight`, mail outbox `already_sent`, stripe `processed_duplicate`) prevents duplicate sends, but each cycle still burns a Postgres checkout + BullMQ job + worker run per stuck row. Once ≥20 distinct reconstructable rows accumulate (one stuck webhook URL is enough to fill the head over time), the oldest-first scan permanently occupies its 20-row window and newer mail / stripe / notification DLQ rows are **never** auto-retried — the auto-retry subsystem is dead system-wide. Concurrently every privileged replay (auto + manual CLI) leaves no `queue.dlq.auto_retried` / `queue.dlq.replayed` row in `audit.logs`, defeating the tamper-evident trail. Attacker amplification: any actor with `webhook:manage` can point a webhook at a 5xx-returning URL they control — 5 failed deliveries become 1 permanent DLQ ledger row, repeated until the 20-slot head fills.

**Recommendation:** Not a one-line `withOrganizationContext` wrap. mail / stripe DLQ rows have no tenant. (a) When `payload_summary.organization_public_id` is present (webhook-delivery, notification), open a tenant-scoped transaction that sets **both** `organization_id` **and** `app.current_organization_id`; (b) for tenantless rows (mail, stripe), add a narrow append-only policy keyed on a dedicated GUC (e.g. `app.system_audit_insert='true'`) used only by a system-audit context wrapper, OR move admin / system events to a separate non-tenant `audit.system_logs` table. Add an integration test against real Postgres (the harness today connects as superuser `core` which bypasses RLS and would falsely pass naive integration coverage). Until fixed, set `DLQ_AUTO_RETRY_ENABLED=false`.

**Round 5 or backlog:** **Tracked operational action immediately** (`DLQ_AUTO_RETRY_ENABLED=false`); the fix itself is a focused Round 5 candidate because the existing tests cannot catch the regression and the bug has a real availability angle (head starvation). Not a hard ship-blocker (the kill-switch is an env var), but should be the next concrete item.

## Section 3: Partial / debatable

| id | Title | Severity | What survived | What was refuted | Reason |
| --- | --- | --- | --- | --- | --- |
| ratelimit-dos-1 | API key creation lacks per-organization cap + route-level rate-limit | medium | No per-organization cap, no `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT` preset on POST `/organizations/:id/api-keys`; no count-check parity with `WEBHOOK_MAX_PER_ORG`; no test coverage. | Global IP limiter (`RATE_LIMIT_MAX=100`/min) backstops single-IP abuse; `idx_api_keys_key_prefix` btree makes the auth-amplification claim weak at expected row counts. | Real parity gap with sec-r4-I2 and the webhook precedent; defense exists but is incomplete. |
| ratelimit-dos-2 | Custom member-role creation lacks per-organization cap + route-level rate-limit | medium → low | No per-route preset on `member-role.routes.ts:56-69`; no `MAX_ROLES_PER_ORG`; no tests pin either invariant. | Cache-amplification narrative is wrong — `invalidateOrganizationPermissions` is an O(1) `INCR` on a version key, not a SCAN-and-delete sweep; stampede lock + TTL bound recompute cost. | Parity gap is real (matches Round 4 sec-r4-I2/D4 class rated Low); inflated severity from the false amplifier. |
| ratelimit-dos-3 | Org notification-policy creation: free-form 50-char `notification_type`, no cap, no preset | low | No `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT`; no `NOTIFICATION_POLICY_MAX_PER_ORG`; list endpoint has no `.limit()` on the repo helper; no test pins any of these. | Permission gate (`NOTIFICATION_POLICY_MANAGE`) requires Admin-level role; RLS isolates tenants; global IP limiter caps throughput. | Insider/compromised-Admin DoS class, inconsistent with sibling tables (`WEBHOOK_MAX_PER_ORG`, `MEMBER_ROLE_PERMISSION_MAX_ROWS_PER_ROLE`). |
| crypto-1 | `mail_outbox.html` persists live magic-link / invitation / password-reset / email-verification tokens with no purge | informational | No DELETE on `mail_outbox` anywhere in `src/`; templates render the raw token verbatim into HTML; no scrub of `html` after `markMailOutboxSent`; contradicts `verification_tokens` hash-only design intent. | RLS deny-all to `PUBLIC` + grant only to `core_be_app`; atomic single-use consume + token TTL bound replay windows. | Defense-in-depth gap not reachable from the API surface; precondition-gated (compromised role / PITR snapshot / SQLi / future ops tool). |
| tc-2 | Cloudflare Turnstile siteverify has no contract test pinning request/response shape | low | No `src/tests/contract/turnstile.contract.test.ts`; no fixtures dir; only 2 trivial happy-path nock mocks; no header / form-body / malformed-response assertions. | Verifier uses strict `payload.success === true` so malformed responses fail closed; middleware throws `UnauthorizedError`; `turnstileCircuit` trips after 5 failures with Sentry signal. | Hygiene asymmetry vs Stripe / Resend / S3 contract tests; runtime fails closed, so security impact is mitigated. |
| tc-3 | `STRICT_AUTHED_RATE_LIMIT` and `EXPENSIVE_AUTHED_RATE_LIMIT` presets lack end-to-end 429 burst tests | low | Recursive grep of `src/tests/` for either preset name returns zero hits; auth-routes (e.g. `/auth/mfa/verify`, `/auth/password/change`, WebAuthn, mail-resend) have no policy pin or burst test; `/me/data-export` same. | Source-text policy tests cover EXPENSIVE_AUTHED on `DELETE /me`, `DELETE /organizations/:id`, `POST .../transfer-ownership`; organization-routes also pin STRICT_AUTHED textually. | Auth/MFA + data-export surface uncovered; a routes refactor that drops `...STRICT_AUTHED_RATE_LIMIT` from `/auth/mfa/verify` would ship green. |
| tc-4 | Deprecated-route `Sunset`/`Deprecation` header invariant only asserted on one route | informational | No global / registry-driven test enumerates deprecated routes and asserts both headers; `docs/routes.txt` and `RouteEntry` have no deprecation flag; OpenAPI has no machine-readable `deprecated: true` on the existing alias. | API-versioning middleware blanket-applies `Sunset` + `Deprecation` to all `/api/v1/*` when `PUBLIC_API_V1_SUNSET` is set, so the major-version cutover headline is refuted. | In-version per-route alias pattern (current Stripe webhook precedent) remains unguarded; future aliases that omit `applyDeprecatedEndpointHeaders` would ship silently. |

## Section 4: Refuted (closed by existing work)

No candidate was fully refuted in this audit pass. All 9 candidates surfaced either as confirmed (2) or partial (7) findings; none were dismissed in their entirety. The "what was refuted" column in Section 3 captures the sub-claims (e.g. cache-namespace flush in `ratelimit-dos-2`, major-version cutover in `tc-4`, security bypass in `tc-2`) where verification provided pinning evidence against specific attack-path components, but the residual gap in each case remains real enough to keep the finding open as partial.

## Section 5: Test coverage assessment

### OWASP API Top 10 (2023) coverage matrix

| API# | Risk | Status | Evidence / Gap |
| --- | --- | --- | --- |
| API1 | Broken Object Level Authorization | Implicit | RLS-pinned by `src/tests/security/rls/*.security.test.ts` + per-domain authz tests; no centralized IDOR fuzz suite. |
| API2 | Broken Authentication | Explicit | `src/tests/security/auth/*.security.test.ts` (public + step-up + MFA + session); `auth-public-rate-limit.security.test.ts`. |
| API3 | Broken Object Property Level Authorization | Implicit | DTO `.strict()` + serializer-level field allowlists; no explicit "extra property silently dropped" suite. |
| API4 | Unrestricted Resource Consumption | Partial | `rate-limit-burst.security.test.ts` covers STRICT_PUBLIC only; `STRICT_AUTHED` / `EXPENSIVE_AUTHED` and per-organization caps for api-keys / member-roles / notification-policies uncovered (findings `tc-3`, `ratelimit-dos-1/2/3`). |
| API5 | Broken Function Level Authorization | Explicit | `requireOrganizationPermission` preHandler + `member-role.service` + `permission-cache.service` covered by domain-level tests. |
| API6 | Unrestricted Access to Sensitive Business Flows | Partial | `EXPENSIVE_AUTHED_RATE_LIMIT` covers high-cost flows (data-export, ownership transfer) but lacks 429 regression coverage (finding `tc-3`). |
| API7 | Server-Side Request Forgery | Implicit | Webhook URL validation + outbound HTTP allowlist; no explicit SSRF probe suite. |
| API8 | Security Misconfiguration | Implicit | `src/tests/global/*.global.test.ts` ratchets (env-example, route catalog, tsdoc budget); no central SecHeaders regression. |
| API9 | Improper Inventory Management | Partial | OpenAPI generator + `route-completeness.global.test.ts`; deprecated-route header inventory uncovered (finding `tc-4`). |
| API10 | Unsafe Consumption of APIs | Partial | Stripe / Resend / S3 contract tests under `src/tests/contract/`; Cloudflare Turnstile uncovered (finding `tc-2`). |

Legend: ✅ explicit security test / 🟡 implicit (RLS / DTO / middleware) / ❌ no test pins this. Above table uses Explicit / Implicit / Partial / (gap).

### Chaos coverage (`src/tests/chaos/**`)

Toxiproxy-driven suite covers Postgres + Redis listener proxies (chaos config at `tooling/vitest/chaos.config.ts`; provisioning at `src/tests/chaos/provision-proxies.ts`). Documented in `docs/reference/reliability/chaos-testing.md`. The DLQ auto-retry head-starvation pattern (finding `async-queue-1`) is **not** exercised by the chaos suite; chaos focuses on connection-level faults rather than RLS-induced semantic loops.

### Load coverage (`src/tests/load/k6/**`)

k6 scenarios under `src/tests/load/k6/scenarios/` (incl. `notification-policy-crud.js`, organization CRUD, auth flows). Documented in `docs/reference/testing/load-testing.md`. Load scenarios validate p95 latency on green-field tenants; they do **not** exercise the unbounded-row-growth attack paths in `ratelimit-dos-1/2/3` (no scenario writes thousands of api-keys / member-roles / notification-policies into a single organization and re-measures list / auth latency).

### Contract coverage (`src/tests/contract/**`)

Existing suites: `resend.contract.test.ts`, `s3.contract.test.ts`, `stripe.contract.test.ts` (+ webhook variants), fixtures under `src/tests/contract/fixtures/{resend,s3,stripe}/`. Documented in `docs/reference/testing/contract-tests.md`. Missing: Cloudflare Turnstile siteverify (finding `tc-2`).

## Section 6: Honest residual risk statement

This audit was conducted by AI agents using static code reading, targeted grep, migration inspection, and existing-test verification. It explicitly did **not** cover:

- **Side-channel timing depth** — e.g. constant-time string comparisons in token / hash flows beyond what `verifyPassword` / `crypto.timingSafeEqual` already provide; no microbenchmarks against credential lookups.
- **Cryptographic protocol fuzzing** — JWT structure / RS256 verification, WebAuthn challenge-response, MFA enrollment cryptography were not subjected to property-based or differential fuzzing.
- **Distributed-systems failure-mode exhaustive coverage** — partial-failure scenarios across Postgres + Redis + BullMQ + Stripe + Resend + S3 (e.g. partitioned brain, Redis flush mid-cron, Stripe retry storm) are only minimally covered by the chaos suite.
- **Real-world penetration test by humans** — no exploratory black-box engagement, no manual API enumeration, no session-fixation / cookie-replay against a deployed environment.
- **Continuous adversarial testing (red-team)** — no ongoing automated adversary; this is a point-in-time review.
- **0-day in third-party deps** — Fastify, BullMQ, Drizzle, Postgres, Redis, Resend, Stripe SDKs are assumed correct at the versions pinned in `pnpm-lock.yaml`. `pnpm deps:audit` is the only standing guard.
- **Misuse by privileged operators with DB / Redis console access** — SUPER_ADMIN role holders, anyone with `core_be_app` credentials, and PITR snapshot consumers are within the RLS-deny model on paper but outside the threat model of code-reading review.

**This audit cannot guarantee absence of all real-world hacking flows; it can only assert what was found and verified by code-reading and existing tests.** A clean residual-risk review is a *necessary* but not *sufficient* condition for production readiness.

## Section 7: Recommended Round 5 (if any)

A focused **Round 5 is recommended**, scoped to one item:

- **`async-queue-1`** — DLQ auto-retry RLS audit-insert loop + head starvation. Medium severity, no test catches it, has a real availability angle. Fix per Section 2.2 recommendation (tenant-scoped tx where possible + `app.system_audit_insert` GUC or separate `audit.system_logs` table for tenantless rows) and add an integration test that runs under `SET LOCAL ROLE core_be_app` so the harness's superuser bypass cannot mask regressions. Set `DLQ_AUTO_RETRY_ENABLED=false` until landed.

All other items are **tracked as backlog tasks**:

- `auth-session-info-1` — doc-tightening on `DELETE /me/auth-methods/:publicId` or atomic `password_hash NULL` in the same transaction.
- `ratelimit-dos-1/2/3` — parity passes adding `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT` and per-organization caps for api-keys, member-roles, and notification-policies. Bundle with existing sec-r4-I2 follow-ups.
- `crypto-1` — defense-in-depth pass on `mail_outbox`: either render-on-send, post-send scrub, or retention sweep aligned with `auth.verification_tokens` retention.
- `tc-2/3/4` — test-coverage backfill: Turnstile contract test, STRICT_AUTHED/EXPENSIVE_AUTHED 429 burst suite (NODE_ENV=production override pattern), and a registry-driven deprecated-route inventory test.

Remaining items can ship incrementally without a major round.
