# Round 4 Security Audit — core-be

**Date:** 2026-06-08
**Auditor:** Claude (8-lane parallel multi-agent workflow)
**Scope:** Full codebase — auth, authz/tenancy, input validation, database, queues/workers, third-party integrations, config/secrets, code quality/reliability
**Methodology:** 8 parallel specialist agents (lanes) + adversarial synthesis pass
**Baseline:** All sec-new-A1–A4, B1–B4, D1–D4, M1–M2, N1, Q1–Q4, T1–T3, U1 (Round 3) and sec-re-01–18 (Round 2) findings confirmed fixed before this scan.

---

## Round 4 Security Audit — Executive Summary

| ID | Severity | Category | Title |
|----|----------|----------|-------|
| sec-r4-D1 | Medium | Access Control / RLS | Audit log INSERT RLS permits `global_admin` context — contradicts read-only design invariant |
| sec-r4-C1 | Medium | Config / Env Security | `ALLOWED_ORIGINS` https-only enforcement excludes staging |
| sec-r4-C2 | Medium | Config / Session Security | `COOKIE_SECURE` enforcement excludes staging |
| sec-r4-C3 | Medium | Secrets Management | `SECRETS_ENCRYPTION_KEY` low-entropy guard excludes staging — all-zero key accepted |
| sec-r4-A1 | Low | Session Management | `revokeAllSessions` clears session cookie despite current session being intentionally preserved |
| sec-r4-T1 | Low | Authorization / RLS | `organizations_user_discovery` RLS reintroduces soft-deleted organization exposure |
| sec-r4-T2 | Low | Authorization / Information Disclosure | `resolve_member_invitation_lookup_by_public_id` returns data for revoked/accepted invitations |
| sec-r4-I1 | Low | Rate Limiting | No per-route rate limit on self-service profile mutation endpoints |
| sec-r4-I2 | Low | Rate Limiting | No per-route rate limit on organization mutation endpoints |
| sec-r4-I3 | Low | Rate Limiting | No per-route rate limit on membership lifecycle state-change routes |
| sec-r4-D2 | Low | Data Integrity | `audit.repository.resolveOrganizationPublicIdsByInternalIds` missing soft-delete filter |
| sec-r4-D3 | Low | Query Safety | `PlanRepository.findAllActive` unbounded SELECT without LIMIT |
| sec-r4-D4 | Low | Query Safety | `MemberRolePermissionRepository.findByRoleId` unbounded SELECT without LIMIT |
| sec-r4-D5 | Low | Migration Safety | Migration `20260606010000` issues `DROP INDEX` without `CONCURRENTLY` |
| sec-r4-R1 | Low | Graceful Shutdown / Resource Leak | `closeUserDataExportQueue()` never wired into worker shutdown sequence |
| sec-r4-Q1 | Low | Queue / Retry Semantics | Stripe webhook processor redundantly re-validates with `parseBullMQJobData` |
| sec-r4-E1 | Low | Cryptography / Data at Rest | Presigned upload paths do not enforce SSE-S3 |
| sec-r4-C4 | Low | Config / Session Security | `AUTH_SESSION_MAX_AGE_DAYS` has no upper bound |
| sec-r4-C5 | Low | Config Drift | `docker-compose.yml` smoke profile sets stale `JWT_SECRET` and omits required RS256 keys |
| sec-r4-R2 | Low | Reliability / Scalability | Unbounded S3 delete fan-out in `deleteAllExportsForUser` offboarding |
| sec-r4-A2 | Informational | Authentication / UX | WebAuthn `userVerification: 'preferred'` during options but `requireUserVerification: true` at verify |
| sec-r4-I4 | Informational | Input Validation | Upload DTO accepts unbounded `fileSize` integer before validator enforces per-purpose cap |
| sec-r4-D6 | Informational | Data Exposure | `webhook-delivery-attempt listByWebhook` returns all columns including `response_body` and full payload |
| sec-r4-C6 | Informational | Supply Chain / Image Security | Dockerfile build stage bakes test credentials into image layer ENV metadata |
| sec-r4-C7 | Informational | CI / Dead Config | `test-env` CI action exports stale `JWT_SECRET` alongside fixture PEM keys |
| sec-r4-A3 | Informational | Authz / Public ID Consistency | `auth_mfa` numeric bigserial `method_id` returned in `mfaEnrollConfirm` despite `public_id` column existing |

**Totals:** 0 Critical · 4 Medium · 16 Low · 6 Informational

---

## Findings

### sec-r4-D1 — Medium: Audit log INSERT RLS permits `global_admin` context — contradicts read-only design invariant

**Severity:** Medium
**Category:** Access Control / RLS
**File:** `src/domains/audit/audit.schema.ts` lines 113–122

**Evidence:**

```sql
pgPolicy('audit_logs_tenant_isolation_insert', {
  as: 'permissive', for: 'insert', to: 'public',
  withCheck: sql`${table.organization_id} = (
      SELECT id FROM tenancy.organizations
      WHERE public_id = current_setting('app.current_organization_id', true)
    )
    OR current_setting('app.global_retention_cleanup', true) = 'true'
    OR current_setting('app.global_admin', true) = 'true'`,  -- line 122
})
```

The code comment at lines 97–98 explicitly states: *"admin is intentionally NOT on DELETE — it is a read escape hatch, never a delete one."* The DELETE policy (line 128) correctly restricts to `global_retention_cleanup` only. However the INSERT policy includes `OR current_setting('app.global_admin', true) = 'true'`, allowing any `global_admin` DB session context to insert audit rows scoped to any organization without going through `withOrganizationDatabaseContext`. No application code currently uses `global_admin` context for audit inserts — all writes flow through `withOrganizationDatabaseContext` — but the policy creates a structural surface inconsistent with the documented invariant.

**Impact:** A future developer adding a `withGlobalAdminDatabaseContext` call inside any service could bypass normal organization-scoping for new audit rows, injecting fabricated entries attributed to any organization. This undermines the forensic integrity of the audit trail. The `global_retention_cleanup` arm is also unnecessary for INSERT since retention workers only delete rows, never insert them.

**Recommendation:** Remove both `OR current_setting('app.global_retention_cleanup', true) = 'true'` and `OR current_setting('app.global_admin', true) = 'true'` from the `audit_logs_tenant_isolation_insert` policy `withCheck` clause. The organization-scoped arm is sufficient for all legitimate audit inserts. Apply via a `DROP POLICY / CREATE POLICY` pair in a new migration.

---

### sec-r4-C1 — Medium: `ALLOWED_ORIGINS` https-only enforcement excludes staging

**Severity:** Medium
**Category:** Configuration / Environment Security
**File:** `src/shared/config/env-schema.ts` line 675

**Evidence:**

```typescript
if (data.NODE_ENV !== 'production') { return true; }  // line 675
```

The `CAPTCHA_PROVIDER` refine (line 603) and the OTEL endpoint refine (line 802) both explicitly guard staging: `if (data.NODE_ENV !== 'production' && data.NODE_ENV !== 'staging') { return true; }`. The `ALLOWED_ORIGINS` https-only refine does not include staging, so a staging deployment accepts `http://` origins in the CORS allowlist.

**Impact:** A staging environment with `http://` ALLOWED_ORIGINS weakens the cookie-origin defense layer: session cookies sent over HTTPS can be requested cross-site from an `http://` origin because the Origin header check passes. Inconsistency with the CAPTCHA/OTEL enforcement pattern strongly indicates an unintentional omission.

**Recommendation:** Change line 675 from `if (data.NODE_ENV !== 'production')` to `if (data.NODE_ENV !== 'production' && data.NODE_ENV !== 'staging')`, matching the pattern used at lines 603 and 802. Update the error message to name both environments.

---

### sec-r4-C2 — Medium: `COOKIE_SECURE` enforcement excludes staging

**Severity:** Medium
**Category:** Configuration / Session Security
**File:** `src/shared/config/env-schema.ts` line 748

**Evidence:**

```typescript
if (data.NODE_ENV !== 'production') { return true; }  // line 748
```

The refine that requires `COOKIE_SECURE=true` passes unconditionally for any non-production environment including staging. A staging deployment can boot with `COOKIE_SECURE=false`, meaning the `Secure` attribute is absent from session and CSRF cookies.

**Impact:** Session and CSRF cookies without the `Secure` attribute are transmitted over plain HTTP connections. An attacker on a network path can intercept or inject the session cookie. For staging environments that share auth infrastructure or contain real user data, this degrades security to a plaintext-channel equivalent even when the staging domain serves HTTPS.

**Recommendation:** Change line 748 guard to `if (data.NODE_ENV !== 'production' && data.NODE_ENV !== 'staging') { return true; }`. If staging bootstraps genuinely require `COOKIE_SECURE=false`, handle via a time-limited runbook exception rather than a blanket schema bypass.

---

### sec-r4-C3 — Medium: `SECRETS_ENCRYPTION_KEY` low-entropy guard excludes staging — all-zero key accepted

**Severity:** Medium
**Category:** Secrets Management / Encryption at Rest
**File:** `src/shared/config/env-schema.ts` lines 615–628

**Evidence:**

```typescript
if (data.NODE_ENV !== 'production') { return true; }  // line 616
// entropy check: new Set(data.SECRETS_ENCRYPTION_KEY.toLowerCase()).size >= 8
```

In staging, the all-zero placeholder `0000000000000000000000000000000000000000000000000000000000000000` passes without error. MFA TOTP seeds and webhook signing secrets are encrypted with this key via AES-256.

**Impact:** Deploying staging with an all-zero `SECRETS_ENCRYPTION_KEY` renders AES-256 encryption of TOTP seeds (`auth.mfa_methods.encrypted_secret`) and webhook signing keys (`notify.webhooks`) trivially breakable — any attacker with staging DB read access can decrypt those values. If staging tables are periodically refreshed from production snapshots, real user TOTP secrets would be encrypted under a known key.

**Recommendation:** Change the guard to `if (data.NODE_ENV !== 'production' && data.NODE_ENV !== 'staging') { return true; }`. Require a genuine `openssl rand -hex 32` key in staging. Rotate any staging keys previously deployed as all-zero.

---

### sec-r4-A1 — Low: `revokeAllSessions` clears session cookie despite current session being intentionally preserved

**Severity:** Low
**Category:** Session Management
**File:** `src/domains/auth/handlers/auth-session.handlers.ts` lines 98–108

**Evidence:**

```typescript
// sec-new-A3: preserve the caller's own session so the client is not silently logged out
await authSessionService.revokeAllSessionsExceptCurrent({
  userPublicId: auth.userId,
  currentAccessToken,
});
// ...
clearSessionCookie(reply);  // line 108 — unconditionally clears the cookie
```

The service call correctly excludes the current session from revocation (the sec-new-A3 fix), but the subsequent `clearSessionCookie(reply)` call deletes the httpOnly `__session` cookie containing `sessionPublicId.refreshSecret`. The DB row is alive but the browser's refresh secret is gone.

**Impact:** When the caller's short-lived JWT expires, the browser cannot issue `POST /refresh` because the session cookie no longer exists. The user is silently logged out from the browser despite the DB session row being preserved — directly contradicting the stated intent of the sec-new-A3 comment. An attacker holding a stolen bearer token who calls `DELETE /me/sessions` achieves silent session-cookie invalidation of the legitimate user's active browser session.

**Recommendation:** Remove the `clearSessionCookie(reply)` call at line 108 from the `revokeAllSessions` handler. Clearing the cookie is correct for `logout` (which revokes the current session row), but incorrect here where the current session is intentionally kept alive. The cookie should only be cleared when the current session itself is revoked.

---

### sec-r4-T1 — Low: `organizations_user_discovery` RLS reintroduces soft-deleted organization exposure

**Severity:** Low
**Category:** Authorization / RLS
**File:** `migrations/20260520000004_organization_discovery_and_invitation_lookup_rls.sql` lines 52–80

**Evidence:**
The `organizations_user_discovery` permissive policy (lines 53–70) and its supporting `SECURITY DEFINER` function `tenancy.user_has_active_membership_for_organization` (lines 31–50) contain no `organizations.deleted_at IS NULL` guard. The function correctly filters `member_row.deleted_at IS NULL` and `user_row.deleted_at IS NULL` but does not filter the organization row's `deleted_at`. Because permissive policies are OR'd, a request under `withUserDatabaseContext` where `app.current_user_id` belongs to a user with an active membership (`memberships.deleted_at IS NULL`) in a soft-deleted organization can satisfy `organizations_user_discovery` and read that org's row from `tenancy.organizations`.

**Impact:** Currently mitigated end-to-end: every service path calling `findByPublicId` adds `isNull(organizations.deleted_at)` in the Drizzle WHERE clause. This is a defense-in-depth gap rather than a directly exploitable cross-tenant read — no authenticated HTTP request can currently surface soft-deleted organization data via the API. Rating is Low; the gap is real at the DB layer and leaves a single service-layer guard as the only barrier.

**Recommendation:** Add `AND tenancy.organizations.deleted_at IS NULL` to the USING clause of `organizations_user_discovery`. Also add `AND organization_row.deleted_at IS NULL` to the JOIN inside `tenancy.user_has_active_membership_for_organization` so that active memberships in deleted organizations do not grant discovery access.

---

### sec-r4-T2 — Low: `resolve_member_invitation_lookup_by_public_id` returns data for revoked/accepted invitations

**Severity:** Low
**Category:** Authorization / Information Disclosure
**File:** `migrations/20260520000004_organization_discovery_and_invitation_lookup_rls.sql` lines 97–119

**Evidence:**

```sql
WHERE invitation_row.public_id = invitation_public_id_param
-- No filter on: accepted_at IS NULL, revoked_at IS NULL,
--               membership_row.deleted_at IS NULL, organization_row.deleted_at IS NULL
LIMIT 1;
```

Contrast with `list_pending_member_invitations_for_email` (lines 150–155) which correctly filters all four conditions. The `SECURITY DEFINER` function is called in `member-invitation.repository.ts:183–209` at the start of `accept()` and `decline()` flows before any organization context is established.

**Impact:** A caller who knows the `public_id` of a previously accepted, revoked, or expired invitation can call the accept/decline endpoint with that ID. The lookup resolves and discloses the owning organization's `public_id`. The service then correctly rejects the attempt (`assertInvitationAcceptable` throws for non-pending state). Risk is limited to organization-ID enumeration via invitation history — no membership mutation occurs.

**Recommendation:** Add `AND invitation_row.accepted_at IS NULL AND invitation_row.revoked_at IS NULL AND membership_row.deleted_at IS NULL AND organization_row.deleted_at IS NULL` to `resolve_member_invitation_lookup_by_public_id`, mirroring the guards already present in the companion `list_pending_member_invitations_for_email` function.

---

### sec-r4-I1 — Low: No per-route rate limit on self-service profile mutation endpoints

**Severity:** Low
**Category:** Rate Limiting
**File:** `src/domains/user/user.routes.ts` lines 121–222

**Evidence:**
`PATCH /me` (line 121), `DELETE /me` (line 135), `PATCH /me/settings` (line 161), `PUT /me/notification-preferences` (line 187), `PUT /me/avatar` (line 201), `DELETE /me/avatar` (line 214) — each block has only `onRequest: [app.authenticate]` with no rate-limit preset spread. `POST /me/data-export` (line ~232) explicitly applies `EXPENSIVE_AUTHED_RATE_LIMIT`, confirming the pattern is used elsewhere in the same file.

**Impact:** A stolen JWT from a rotating IP pool bypasses the global IP-keyed limiter. `PUT /me/notification-preferences` is the highest-cost target: `PutNotificationPreferencesDto` accepts up to 200 items, and `replaceAll` in the repository issues a DELETE + bulk INSERT per call with no per-actor cap. `DELETE /me` (account deletion, irreversible) has no per-user throttle.

**Recommendation:** Apply `MODERATE_AUTHED_RATE_LIMIT` to `PATCH /me`, `PATCH /me/settings`, `PUT /me/avatar`, `DELETE /me/avatar`. Apply `EXPENSIVE_AUTHED_RATE_LIMIT` to `PUT /me/notification-preferences` and `DELETE /me`. Pattern: spread the preset object in the route options alongside `onRequest`.

---

### sec-r4-I2 — Low: No per-route rate limit on organization mutation endpoints

**Severity:** Low
**Category:** Rate Limiting
**File:** `src/domains/tenancy/sub-domains/organization/organization.routes.ts` lines 131–241

**Evidence:**
`PATCH /organizations/:id` (line 131), `DELETE /organizations/:id` (line 147), `PUT /organizations/:id/logo` (line 164), `DELETE /organizations/:id/logo` (line 180), `PATCH /organizations/:id/settings` (line 228) — none spread a rate-limit preset. `POST /organizations/:id/api-keys/rotate` (line 321) explicitly applies `STRICT_AUTHED_RATE_LIMIT`, confirming the pattern is intentionally applied on sensitive organization actions but was omitted for the mutation endpoints.

**Impact:** A stolen JWT with `ORGANIZATION_UPDATE` or `ORGANIZATION_DELETE` permission can repeatedly invoke destructive organization mutations without any per-organization or per-actor cap. The permission gate is not a substitute for rate limiting — the threat model is a compromised admin credential.

**Recommendation:** Apply `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT` (already defined in `rate-limit-presets.constants.ts`) to `PATCH /organizations/:id`, `PUT /organizations/:id/logo`, `DELETE /organizations/:id/logo`, and `PATCH /organizations/:id/settings`. Apply `STRICT_AUTHED_RATE_LIMIT` to `DELETE /organizations/:id` (irreversible).

---

### sec-r4-I3 — Low: No per-route rate limit on membership lifecycle state-change routes

**Severity:** Low
**Category:** Rate Limiting
**File:** `src/domains/tenancy/sub-domains/membership/membership.routes.ts` lines 123–254

**Evidence:**
`POST /organizations/:id/leave` (line 123) — `onRequest: authenticate` only, no preset. `POST /organizations/:id/transfer-ownership` (line 136) — `config: { idempotencyRequired: true }` only, no rate-limit. `POST /invitations/:invitationId/decline` (line 243) — authenticate only. `DELETE /organizations/:id/invitations/:invitationId` (line 202) — permission check only. By contrast, `POST .../invitations/:invitationId/resend` (line 215) explicitly applies `STRICT_AUTHED_RATE_LIMIT`.

**Impact:** A stolen JWT can drive repeated leave-organization, transfer-ownership, or invitation-cancel operations without any per-actor cap. `transfer-ownership` is the highest-severity action: it irrevocably reassigns organization ownership. The idempotency key prevents duplicate execution of a single key but does not prevent an attacker issuing many calls with distinct idempotency keys.

**Recommendation:** Apply `STRICT_AUTHED_RATE_LIMIT` to `POST /organizations/:id/leave` and `POST /invitations/:invitationId/decline`. Apply `EXPENSIVE_AUTHED_RATE_LIMIT` to `POST /organizations/:id/transfer-ownership` given its irreversible ownership-change semantics. Apply `MODERATE_AUTHED_RATE_LIMIT` to `DELETE /organizations/:id/invitations/:invitationId` and `GET /invitations/pending`.

---

### sec-r4-D2 — Low: `audit.repository.resolveOrganizationPublicIdsByInternalIds` missing soft-delete filter

**Severity:** Low
**Category:** Data Integrity
**File:** `src/domains/audit/audit.repository.ts` lines 199–208

**Evidence:**

```typescript
getRequestDatabase()
  .select({ id: organizations.id, public_id: organizations.public_id })
  .from(organizations)
  .where(inArray(organizations.id, [...organizationInternalIds]))
  // missing: isNull(organizations.deleted_at)
```

**Impact:** Audit log entries referencing a soft-deleted organization resolve to the (now-deleted) org's `public_id` and appear in exported audit data attributed to organizations the tenant believes have been deleted. Display-integrity issue only — no privilege escalation or cross-tenant access.

**Recommendation:** Change the WHERE clause to `and(inArray(organizations.id, [...organizationInternalIds]), isNull(organizations.deleted_at))`. Treat a missing map entry as `[deleted organization]` in the display layer.

---

### sec-r4-D3 — Low: `PlanRepository.findAllActive` unbounded SELECT without LIMIT

**Severity:** Low
**Category:** Query Safety
**File:** `src/domains/billing/sub-domains/plan/plan.repository.ts` line 11

**Evidence:**

```typescript
async findAllActive() {
  return getRequestDatabase().select().from(plans).where(eq(plans.is_active, true));
  // no .limit()
}
```

**Impact:** Memory pressure and response latency if the `billing.plans` catalog grows (legacy/promotional plan rows accumulating). Low-risk at current volume but violates the defensive unbounded-SELECT convention applied consistently elsewhere. Plan lists are served to the billing UI on every page load.

**Recommendation:** Apply a practical upper-bound limit (e.g. `.limit(100)`) and throw or log if the result set hits that bound, or enforce a `MAX_PLANS` constant from shared constants.

---

### sec-r4-D4 — Low: `MemberRolePermissionRepository.findByRoleId` unbounded SELECT without LIMIT

**Severity:** Low
**Category:** Query Safety
**File:** `src/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.repository.ts` lines 12–16

**Evidence:**

```typescript
async findByRoleId(role_id: number) {
  return getRequestDatabase()
    .select()
    .from(role_permissions)
    .where(eq(role_permissions.role_id, role_id));
  // no .limit()
}
```

The `replace()` method (lines 19–35) also calls DELETE then bulk INSERT without a per-call size cap.

**Impact:** A privileged user (organization admin) who can call the replace-role-permissions route could insert an unbounded number of permissions for a single role in one transaction. Current permission code set (~20–50 codes) makes this low-risk, but no schema-level or application-level constraint bounds the number of permissions per role.

**Recommendation:** Add a maximum permissions-per-role guard in the service layer (e.g. `if (permission_codes.length > MAX_PERMISSIONS_PER_ROLE) throw ValidationError(...)`) before calling `replace()`, and add `.limit(MAX_PERMISSIONS_PER_ROLE + 1)` to `findByRoleId` to make over-limit rows detectable.

---

### sec-r4-D5 — Low: Migration `20260606010000` issues `DROP INDEX` without `CONCURRENTLY`

**Severity:** Low
**Category:** Migration Safety / Operational Risk
**File:** `migrations/20260606010000_user_notif_prefs_drop_org_branch.sql` line 32

**Evidence:**

```sql
DROP INDEX IF EXISTS auth.idx_user_notif_prefs_org;
```

Runs without `CONCURRENTLY`. Standard `DROP INDEX` acquires an `ACCESS EXCLUSIVE` lock on `auth.user_notification_preferences` for the entire transaction duration. The migration also contains `ALTER TABLE` and `CREATE POLICY` DDL adding further lock acquisitions in the same transaction block.

**Impact:** During deployment, in-flight reads or writes against `auth.user_notification_preferences` are blocked for the full duration of this transaction. On busy instances this causes a latency spike or queue buildup on notification preference fetches and updates.

**Recommendation:** Extract `DROP INDEX IF EXISTS auth.idx_user_notif_prefs_org` into its own migration annotated with `-- migration-transaction: none` and replace with `DROP INDEX CONCURRENTLY IF EXISTS auth.idx_user_notif_prefs_org`. The remaining DDL in the original migration requires transactional semantics and can stay.

---

### sec-r4-R1 — Low: `closeUserDataExportQueue()` never wired into worker shutdown sequence

**Severity:** Low
**Category:** Graceful Shutdown / Resource Leak
**File:** `src/worker.ts` lines 107–113

**Evidence:**

```typescript
await Promise.allSettled([
  closeDeadLetterQueues(),
  closeStripeWebhookQueue(),
  closeMailQueue(),
  closeNotificationQueue(),
  closeWebhookDeliveryQueue(),
  // closeUserDataExportQueue() is missing
]);
```

`closeUserDataExportQueue` is exported at `src/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.ts:46` with zero call sites anywhere in `src/`.

**Impact:** The user-data-export BullMQ producer Queue holds its own Redis client connection. On SIGTERM/SIGINT the connection is never explicitly drained before `closeRedis()` tears down shared infrastructure. This can produce `'Stream isn't writeable'` log noise on the next startup and delays clean process exit if the Redis client socket close is pending.

**Recommendation:** Import `closeUserDataExportQueue` from `@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js` and add it to the `Promise.allSettled([...])` block at `src/worker.ts:107–113`.

---

### sec-r4-Q1 — Low: Stripe webhook processor redundantly re-validates with `parseBullMQJobData` after worker boundary already validated

**Severity:** Low
**Category:** Queue / Retry Semantics
**File:** `src/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook.processor.ts` line 34

**Evidence:**
`stripe-webhook.worker.ts:58` calls `parseJobDataOrDeadLetter({ schema: stripeWebhookJobDataSchema, job, queueName })` which routes schema failure to `UnrecoverableError` → DLQ. Then `stripe-webhook.processor.ts:34` calls `parseBullMQJobData(stripeWebhookJobDataSchema, jobData, STRIPE_WEBHOOK_QUEUE_NAME)` on the same payload. `parseBullMQJobData` throws a plain `ValidationError` on failure, which BullMQ treats as retriable (burns retry budget with exponential backoff) rather than routing to DLQ.

**Impact:** The second validation cannot fail in normal operation. However, if `stripeWebhookJobDataSchema` ever diverges between call sites (conditional schema branch added only to the worker boundary, or a deployment-window mismatch), a poison job that passes the first check but fails the second will burn all retry attempts instead of being dead-lettered immediately, wasting the retry budget and delaying DLQ arrival.

**Recommendation:** Remove the redundant `parseBullMQJobData` call at `stripe-webhook.processor.ts:34`. The processor receives already-validated `jobData` (typed as `StripeWebhookJobData`) from the worker boundary. Destructure directly: `const { stripeEventId, requestId } = jobData;`

---

### sec-r4-E1 — Low: Presigned upload paths do not enforce SSE-S3

**Severity:** Low
**Category:** Cryptography / Data at Rest
**File:** `src/infrastructure/storage/s3-adapter.ts` lines 57–109

**Evidence:**
`createPresignedUploadUrl` (lines 57–75): `PutObjectCommand` has no `ServerSideEncryption` field; `signableHeaders` covers only `content-length`, `content-type`, `host`. `createPresignedUploadPost` (lines 77–109): the `Conditions` array contains only `content-length-range` and `Content-Type` with no `['eq', '$x-amz-server-side-encryption', 'AES256']` condition. By contrast, `putObject` (line 276) and `copyObject` (line 312) both explicitly set `ServerSideEncryption: 'AES256'` with the comment `sec-U11: explicit SSE-S3 request`.

**Impact:** Objects uploaded directly by clients via presigned PUT or POST land without the SSE-S3 header. Since January 2023 AWS applies SSE-S3 automatically to all new objects when no SSE header is present, so real-world exposure is near-zero on a properly configured bucket. If the bucket default encryption policy is ever absent or overridden, client-uploaded files (user avatars, logos, export files) would be stored without at-rest encryption — inconsistent with the explicit sec-U11 posture on server-side write paths.

**Recommendation:** For `createPresignedUploadPost`: add `['eq', '$x-amz-server-side-encryption', 'AES256']` to the `Conditions` array and `'x-amz-server-side-encryption': 'AES256'` to the `Fields` object. For `createPresignedUploadUrl`: add `ServerSideEncryption: 'AES256'` to the `PutObjectCommand` and include `'x-amz-server-side-encryption'` in the `signableHeaders` Set. This forces S3 to reject any upload omitting the SSE header, aligning presigned paths with the sec-U11 posture.

---

### sec-r4-C4 — Low: `AUTH_SESSION_MAX_AGE_DAYS` has no upper bound

**Severity:** Low
**Category:** Configuration / Session Security
**File:** `src/shared/config/env-schema.ts` line 116

**Evidence:**

```typescript
AUTH_SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(7),
AUTH_SESSION_RETENTION_DAYS: z.coerce.number().int().min(1),  // line 373
```

Only a minimum of 1 is enforced. `AUDIT_RETENTION_DAYS` is defined with `.min(1).max(730)` and `GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS` with `.min(60).max(3600)` in the same file.

**Impact:** An operator misconfiguration (e.g. `AUTH_SESSION_MAX_AGE_DAYS=36500`) creates effectively permanent session tokens that never expire. Perpetual sessions eliminate periodic forced re-authentication as a defense-in-depth control and increase the window of exposure for stolen session tokens.

**Recommendation:** Add `.max(365)` (or a policy-appropriate bound) to `AUTH_SESSION_MAX_AGE_DAYS` at line 116. Apply the same upper bound to `AUTH_SESSION_RETENTION_DAYS` at line 373. Follow the precedent of `AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(730)`.

---

### sec-r4-C5 — Low: `docker-compose.yml` smoke profile sets stale `JWT_SECRET` and omits required RS256 keys

**Severity:** Low
**Category:** Configuration Drift / Dead Config
**File:** `docker-compose.yml` line 55

**Evidence:**

```yaml
JWT_SECRET: test-jwt-secret-min-32-chars-xxxxxxxx  # line 55
```

`JWT_SECRET` is not defined in `env-schema.ts` (confirmed zero occurrences). The schema requires `JWT_PRIVATE_KEY: z.string().min(1)` and `JWT_PUBLIC_KEY: z.string().min(1)` (both required, no default). Neither is present in the `api-smoke` container's environment block.

**Impact:** The smoke-test container fails `assertJwtKeyMaterial()` at boot because `JWT_PRIVATE_KEY` is absent — it throws `'JWT_PRIVATE_KEY is required: RS256 signing is mandatory'`. This means `pnpm verify:base` / `pnpm test:api-smoke` against the smoke profile crashes before any route is exercised, providing zero validation of JWT issuance or auth flows. The stale `JWT_SECRET` key also misleads future maintainers about the auth mechanism in use.

**Recommendation:** Remove `JWT_SECRET` from the `api-smoke` environment block. Add `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` entries matching the fixture PEM values in `.github/actions/test-env/action.yml` lines 59–103. Retest `pnpm test:api-smoke` to confirm the smoke container boots successfully.

---

### sec-r4-R2 — Low: Unbounded S3 delete fan-out in `deleteAllExportsForUser` offboarding

**Severity:** Low
**Category:** Reliability / Scalability
**File:** `src/domains/user/sub-domains/user-data-export/user-data-export.service.ts` lines 411–430

**Evidence:**

```typescript
const rows = await withUserDatabaseContext(userPublicId, () =>
  this.exportRepository.listByUserId(userInternalId)  // no LIMIT in repository (line 80-82)
);
await Promise.all(
  rows.filter(...).map(async (row) => this.objectStorage.deleteObject(row.s3_key))
  // unbounded fan-out
);
```

`UploadService.tombstoneAllByUserId` (`upload.service.ts:632–658`) solves the identical problem with keyset pages (`UPLOAD_OFFBOARDING_DELETE_BATCH_SIZE`) and bounded concurrency (`UPLOAD_OFFBOARDING_DELETE_CONCURRENCY`).

**Impact:** For a high-export-count user, offboarding triggers hundreds of concurrent S3 API calls and loads the entire export result set into memory. Sustained S3 connection exhaustion or AWS throttling causes the offboarding coroutine to hang, delaying account deletion and blocking the offboarding queue entry.

**Recommendation:** Mirror the `UploadService` offboarding pattern: (1) add a LIMIT to `listByUserId` or replace it with a keyset-paginated batch fetch; (2) wrap the S3 deletes in the existing `deleteObjectsWithBoundedConcurrency` helper or an equivalent chunk-based `Promise.all` instead of fanning out all rows at once.

---

### sec-r4-A2 — Informational: WebAuthn `userVerification: 'preferred'` during options but `requireUserVerification: true` at verify

**Severity:** Informational
**Category:** Authentication / UX
**File:** `src/domains/auth/sub-domains/auth-webauthn/webauthn.service.ts` lines 129–324

**Evidence:**
Registration options line 131: `userVerification: 'preferred'`. Registration verify line 171: `requireUserVerification: true`. Authentication options lines 235, 275: `userVerification: 'preferred'`. Authentication verify line 324: `requireUserVerification: true`.

**Impact:** An authenticator without user verification (no biometric/PIN) may complete the WebAuthn options round-trip, generate a credential or assertion, but will always fail the verify step. Users with UV-incapable authenticators are silently enrolled then permanently unable to authenticate. No security regression — verify fails closed.

**Recommendation:** Change `userVerification` to `'required'` in both `generateRegistrationOptions` (line 131) and `generateAuthenticationOptions` (lines 235, 275). This surfaces UV capability as a hard requirement at enrollment time, matching what verify already enforces.

---

### sec-r4-I4 — Informational: Upload DTO accepts unbounded `fileSize` integer before validator enforces per-purpose cap

**Severity:** Informational
**Category:** Input Validation / Defense-in-Depth
**File:** `src/domains/upload/upload.dto.ts` line 28

**Evidence:**

```typescript
fileSize: z.number().int().positive(),  // no .max() constraint
```

Per-purpose limits are enforced only inside `validateCreateUpload` in `upload.validator.ts`. The global 1 MB body limit does not cap `fileSize` since it is a numeric claim about an S3 object, not the request body.

**Impact:** No direct exploitable impact — the validator layer correctly rejects oversized values before any S3 presigned URL is generated. Defense-in-depth gap: if the validator is bypassed or refactored, arbitrarily large `fileSize` claims reach the presigned URL generation path. Also misleads OpenAPI clients that read the schema without a maximum.

**Recommendation:** Add `.max(MAX_UPLOAD_SIZE_BYTES)` to `fileSize` in `createUploadDto`, where `MAX_UPLOAD_SIZE_BYTES` is the highest per-purpose ceiling already defined in `upload.validator.ts`.

---

### sec-r4-D6 — Informational: `webhook-delivery-attempt listByWebhook` returns all columns including `response_body` and full payload

**Severity:** Informational
**Category:** Data Exposure / Column Projection
**File:** `src/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.ts` line 62

**Evidence:**

```typescript
this.db().select().from(webhook_delivery_attempts).where(where)...
// no column projection — returns response_body (text) and payload (jsonb)
```

**Impact:** Webhook delivery history responses expose the full outbound event payload and the full inbound HTTP response body from the webhook endpoint to any organization member with permission to view webhook delivery history. If event payloads contain PII or sensitive business data, this broadens the disclosure surface unnecessarily. No cross-tenant leak — RLS correctly scopes to the current organization.

**Recommendation:** Add an explicit column projection to `listByWebhook` omitting or truncating `response_body` and `payload`, returning only fields needed for the delivery history UI (`public_id`, `status`, `http_status_code`, `created_at`, `next_retry_at`, `attempt_number`). Full payload and response body should be available only on a dedicated single-attempt detail endpoint.

---

### sec-r4-C6 — Informational: Dockerfile build stage bakes test credentials into image layer ENV metadata

**Severity:** Informational
**Category:** Supply Chain / Image Security
**File:** `Dockerfile` lines 15–24 (identical pattern in `Dockerfile.worker` lines 14–23)

**Evidence:**

```dockerfile
ENV NODE_ENV=test \
    JWT_PRIVATE_KEY=test-private-key \
    ...
    SECRETS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
```

The runtime stage (`FROM node:22-alpine AS api`, line 38) only sets `ENV NODE_ENV=production` (line 42), so these values are not inherited into the final production image.

**Impact:** Values are well-known test placeholders — not real secrets. If the build-stage intermediate image (`--target build`) is ever pulled from a registry or inspected via `docker inspect`, these appear in image metadata. Establishes a habit of putting credentials in Dockerfile ENV that causes real harm if real values are ever substituted.

**Recommendation:** Move the build-time env setup to a `.env.test` file that is `.dockerignore`d from the production image, or pass these values as `--build-arg`. At minimum, add a comment to the build-stage ENV block explicitly stating these are test-only compile-time values that must never be replaced with real credentials.

---

### sec-r4-C7 — Informational: `test-env` CI action exports stale `JWT_SECRET` alongside fixture PEM keys

**Severity:** Informational
**Category:** CI / Dead Config
**File:** `.github/actions/test-env/action.yml` line 43

**Evidence:**

```yaml
echo "JWT_SECRET=${JWT_SECRET_INPUT}" >> "$GITHUB_ENV"  # line 43
```

`JWT_SECRET` is not consumed by the application (zero occurrences in `env-schema.ts`). The action also correctly exports `JWT_PRIVATE_KEY` (lines 59–88) and `JWT_PUBLIC_KEY` (lines 92–103). The input parameter `jwt-secret` (line 12) and `JWT_SECRET_INPUT` env var (line 35) remain in the action definition.

**Impact:** Dead export suggests HMAC-based JWT auth is still active, confusing operators and future maintainers. Fixture PEM keys are test-only material — their presence in `GITHUB_ENV` runner logs is a documentation-level concern, not a live secret leak.

**Recommendation:** Remove the `jwt-secret` input parameter, `JWT_SECRET_INPUT` env var, and `echo "JWT_SECRET=..."` line from `action.yml`. Verify no other workflow files pass `jwt-secret` as an input before removing (grep `.github/workflows/` for `jwt-secret:`).

---

### sec-r4-A3 — Informational: `auth_mfa` numeric bigserial `method_id` returned in `mfaEnrollConfirm` despite `public_id` column existing

**Severity:** Informational
**Category:** Authz / Public ID Consistency
**File:** `src/domains/auth/auth.serializer.ts` lines 67–71

**Evidence:**

```typescript
mfaEnrollConfirm(data: { recovery_codes: string[]; method_public_id: string; method_id: number }) {
  return { recovery_codes: data.recovery_codes, method_id: data.method_id };
}
```

`auth-mfa.service.ts:372` returns `method_id: record.id` (numeric bigserial PK). The `auth.mfa_methods` schema (`auth-mfa-method.schema.ts` line 23) already has `public_id: varchar('public_id', { length: 21 }).notNull().unique()`.

**Impact:** The numeric bigserial leaks the global `auth.mfa_methods` sequence counter, allowing a user to infer total MFA enrollment volume across the platform — consistent with the platform-growth leakage category addressed by prior sec-new-B rounds on all other tables. IDOR risk is negligible: RLS (`auth_methods_self_or_admin_access`) scopes reads to the owning user.

**Recommendation:** Update `auth-mfa.service.ts:enrollConfirm` to return `method_public_id: record.public_id` (string) instead of `method_id: record.id`. Update the serializer to output `method_public_id: data.method_public_id`. This closes the last table-without-public_id inconsistency introduced by the sec-new-B remediation.

---

### ⚠️ sec-r4-A3 STATUS UPDATE — 2026-06-08: deferred to follow-up task (audit premise was mis-filed)

While working the Round 4 remediation campaign, this finding's premise turned out to be incorrect on a source read. Captured here so future readers don't repeat the analysis:

**What the audit cited (above):** `auth.mfa_methods` schema (`auth-mfa-method.schema.ts:23`) which has a `public_id varchar(21) unique` column. Suggested change was a one-line return.

**What's actually true (verified against dev on 2026-06-08):**

- `enrollConfirm` (`auth-mfa.service.ts:298`) → `createAuthMethodRecord` (`auth-method.service.ts:209`) → `repository.insert(auth_methods)` (`auth-method.repository.ts:99`). The TOTP factor row is written to **`auth.auth_methods`**, NOT `auth.mfa_methods`.
- `auth.auth_methods` (`auth-method.schema.ts:28`) has only a `bigserial('id')` primary key — there is **no `public_id` column** on this table.
- `auth.mfa_methods` (the table the audit cited) is a parallel schema that `enrollConfirm` does not write to.
- The DELETE route `/api/v1/auth/me/mfa/methods/:methodId` (`auth-mfa.service.ts:393`) keys on the numeric bigserial too, so the leaked sequence counter is exposed on the DELETE param as well — not only the enroll response. Closing only the enroll response would not close the leak.

**Actual scope to close A3:**

1. Migration adding `public_id VARCHAR(21) NOT NULL UNIQUE` to `auth.auth_methods` + backfill existing rows. Unique index requires `CREATE UNIQUE INDEX CONCURRENTLY` in a `-- migration-transaction: none` file (per sec-r4-D5 pattern), then `ADD CONSTRAINT ... UNIQUE USING INDEX`.
2. Drizzle schema add of `public_id` column.
3. Repository `createAuthMethodRecord` to generate public_id on insert.
4. `auth-mfa.service.enrollConfirm` to return `method_public_id`.
5. Serializer output rename.
6. DELETE route `:methodId` → `:methodPublicId` (validated as a 21-char public id), with corresponding service change to lookup by public_id.
7. Audit emit (`handlers/auth-mfa.handlers.ts:52, 67`) to log `public_id` not bigserial.
8. Tests across the MFA + auth-method suites.

**Why this is a BREAKING API change:** Any external client that already calls `DELETE /api/v1/auth/me/mfa/methods/:methodId` with the numeric id will break. Requires coordination with frontend / API consumers before merging.

**Disposition (2026-06-08):** Deferred to a dedicated follow-up task rather than landing a high-risk breaking change at the tail of an Informational sweep. The audit explicitly notes the IDOR risk is negligible (RLS-scoped), leaving only the low-value platform-growth signal — which is consistent with this being Informational severity. The follow-up task carries the full corrected analysis and the scope summary above.

---

### ✅ sec-r4-A3 RESOLVED — 2026-06-08 (later same day): closed by Round 3 sec-new-B4 back-merge

A subsequent back-merge of `main` into `dev` revealed that the entire scope above had already been implemented on `main` under finding **sec-new-B4** — and the only reason `dev` saw `auth.auth_methods` without `public_id` was that `main`'s PR #495 had not yet propagated back to `dev`. The B4 fix includes:

- Migrations `20260608040000_auth_methods_add_public_id.sql` and `20260608050000_auth_methods_public_id_index.sql` adding `public_id varchar(21) UNIQUE NOT NULL` (the CONCURRENTLY-built unique index is in the second migration, isolated in its own `migration-transaction: none` file — same pattern sec-r4-D5 codified independently in `dev`).
- Drizzle schema + repository + service updates so `record.public_id` flows through `enrollConfirm` (and every other auth-method path).
- Serializer rename to `method_public_id`.
- DELETE route `:methodId` → `:publicId` plus corresponding service lookup by public id (the breaking-changes ignore file `.github/oasdiff/breaking-changes-ignore.txt` entry #10 acknowledges the intentional API change).
- Test updates across the MFA + auth-method suites.

The corrected analysis above stands as a record of what was checked and why the audit's table mapping was confusing on the `dev` branch — but the follow-up task (`task_4e485aea`) is now obsolete and should be dismissed. **sec-r4-A3 is closed.**
