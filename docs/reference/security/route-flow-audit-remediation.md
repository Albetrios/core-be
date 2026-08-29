# Route-flow audit — remediation & regression testing

This document records the fixes made in response to the route-by-route deep
security / production-flow review, and the **regression tests** that lock each
fix in. It also records the findings that were already mitigated on the branch
(so the audit row is a false alarm) and the items deliberately deferred, with the
rationale and a concrete plan for each.

> Run order for the full regression set is at the [end of this doc](#running-the-regression-suite).

## Conventions

- **Fix** — code change that closes the finding.
- **Tests** — the unit/e2e/security tests that fail without the fix and pass with it.
- File paths are repo-relative.

---

## Fixed findings

### R1 / TEN-32 / TEN-34 — invitation token no longer returned in HTTP responses

- **Fix:** `member-invitation.controller.ts` returns invitation metadata only;
  the raw token leaves the service exclusively through the invitation email.
- **Tests:** `member-invitation.service.unit.test.ts` — `create` / `resend` assert
  the result has no `token` field; `member-invitation.controller.unit.test.ts`
  service mocks return token-less invitations.

### R2 — invitation token issuance + email are atomic

- **Fix:** `member-invitation.service.ts` `create`/`resend` run the invitation
  INSERT and the mail-outbox INSERT inside the one organization transaction opened by
  `withOrganizationDatabaseContext`, and emit via `eventBus.emitStrict` (not the
  swallowing `emit`) so a failed outbox write rolls the transaction back. The
  request id is threaded for crash-safe post-commit dispatch.
- **Tests:** service unit test asserts `emitStrict` is called and `emit` is not.

### R5 / TEN-35 — pending-invitation cursor pagination

- **Fix:** migration `20260614120000_pending_invitation_keyset_pagination.sql`
  recreates `tenancy.list_pending_member_invitations_for_email` with
  `(created_at, id)` keyset params + the invitation id + soft-delete guards;
  repository/service/controller page with `limit` + opaque `after` and expose
  `has_more` / `next_cursor`; the route declares the cursor querystring and
  rejects legacy `page`.
- **Tests:** service unit test — paginated page shape, cursor + limit forwarded to
  the repo; controller forwards `request.query` and emits pagination meta.

### AUTH-04 — email verification-code verify is atomic (token consume + session/MFA)

- **Fix:** `email-login.service.ts` wraps consume + `completeFirstFactorAuth` in
  `withTransaction` + `runWithPinnedDatabaseHandle`; session creation reuses the
  pinned handle, so any downstream failure (session insert / Redis MFA handoff)
  rolls the consume back, leaving the link usable.
- **Tests:** `email-login.service.unit.test.ts` — AUTH-04 rollback regression
  (downstream failure propagates; consume was attempted inside the tx).

### AUTH-10 — email verify is atomic (token consume + verified flag)

- **Fix:** `auth-method.service.ts` `verifyEmail` consumes the token and flips
  `is_email_verified` in one pinned transaction.
- **Tests:** `auth-method.service.unit.test.ts` — AUTH-10 rollback regression.

### AUTH-14 / AUTH-15 / AUTH-16 — selected organization persists across refresh

- **Fix:** the previously-unused `auth.sessions.organization_id` FK is now written
  on `switch-to-organization` / `switch-to-personal` (during the access-token
  rebind) and read on `/auth/refresh`, which **re-validates** the persisted organization
  still maps to an ACTIVE membership (a removed member never retains access),
  reuses it, and re-persists it; refresh falls back to the default organization only when
  there is no persisted organization or it is no longer valid. New `*Ref` resolver variants
  return `{ id, public_id }`; the existing public-id helpers delegate to them.
- **Tests:** `auth.service.unit.test.ts` — AUTH-14 preserve, AUTH-14 fallback,
  AUTH-15 switch-persists regressions.
- **Known limitation (documented, not changed):** concurrent legitimate refreshes
  with the same refresh secret can still trip strict refresh-token-rotation reuse
  detection (RFC 9700 trade-off). A small replay-grace window is the standard
  mitigation but weakens reuse detection; it is intentionally out of scope here.

### AUTH-17 — change-password is atomic (hash commit + session revocation)

- **Fix:** `auth-method.service.ts` `changePassword` commits the new hash and
  revokes the other sessions in one pinned transaction (mirrors `resetPassword`).
- **Tests:** `auth-method.service.unit.test.ts` — AUTH-17 rollback regression.

### BILL-03 — Stripe delete-before-create no longer resurrects entitlement

- **Fix:** new system table `billing.stripe_subscription_tombstones` (migration
  `20260614130000_*`, FORCE RLS + deny-all + `core_be_app` policies like
  `stripe_webhook_events`). A `customer.subscription.deleted` that finds no local
  row records a deletion watermark; the create/update handler refuses the fallback
  INSERT / retry when a tombstone at or after the event timestamp exists.
- **Tests:** `stripe-webhook.service.unit.test.ts` — tombstone recorded on
  delete-before-create; stale created superseded; strictly-newer event not blocked.
  `system-tables-rls.security.test.ts` — deny-all + app-access policies on the new
  table (requires a DB; runs in the security lane).

### NOTIFY-11 — webhook secret rotation overlap gate is atomic

- **Fix:** `webhook.service.ts` reads the rotation gate row via
  `findByPublicIdForUpdate` (`SELECT … FOR UPDATE`) inside the organization transaction, so
  concurrent rotations serialize and the second is rejected instead of clobbering
  the single `encrypted_secret_previous` slot.
- **Tests:** `webhook.service.unit.test.ts` — re-rotation rejected within the
  overlap window and allowed after, both driving the FOR UPDATE path.

### UPLOAD-03 — transient S3 errors no longer become permanent FAILED

- **Fix:** `s3-adapter.ts` `headObject` / `getObjectFirstBytes` return `null` only
  for a genuine 404 (`NotFound` / `NoSuchKey`, walking the `cause` chain) and
  rethrow every transient failure; `upload.service.ts` `confirmUpload` rethrows a
  transient `ExternalServiceError` (503) and leaves the row PENDING for retry —
  only genuine verification failures mark it FAILED.
- **Tests:** `s3-adapter.unit.test.ts` — not-found→null vs transient→rethrow for
  head + range reads; `upload.service.unit.test.ts` — confirm rethrows transient
  without marking FAILED.

### TEN-02 / TEN-13 / TEN-19 / TEN-39 — resource caps are transactionally strict

- **Fix:** owned-organization, API-key, notification-policy, and custom-role
  creates take a transaction-scoped `pg_advisory_xact_lock` for their scope
  (`infrastructure/database/resource-quota-lock.util.ts`) before the count, mirroring
  the per-user upload-quota lock — two parallel creates can no longer both pass at N-1.
  (audit R12: a redundant second lock module, `resource-cap-lock.ts`, was removed —
  organization-create now uses the single canonical quota lock like every other capped resource.)
- **Tests:** cap service unit tests exercise the quota lock; `organization.service`
  asserts the owned-organization quota lock is taken before counting (TEN-02 / R12).

### R4 — route-local mutation rate limits on the remaining mutations

- **Fix:** notification PATCH read / POST mark-all-read / DELETE →
  `MODERATE_AUTHED_RATE_LIMIT`; membership POST/PATCH/DELETE, api-key PATCH/DELETE,
  notification-policy PATCH/DELETE, role PATCH/DELETE and PUT permissions →
  `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT`.
- **Tests:** covered by the existing domain e2e route suites (which exercise these
  routes); the presets reuse the same shape as already-tested sibling routes.

---

## Already mitigated on this branch (audit rows are false alarms)

These were verified during remediation and need no code change; regression
coverage already exists (and was extended where noted).

| Audit row | Why it is already safe |
| --------- | ---------------------- |
| NOTIFY-09 / NOTIFY-14 (response buffering) | Outbound webhook delivery + test stream-cap the response at `WEBHOOK_RESPONSE_BODY_MAX_BYTES` (64 KB) and `request.destroy()` on exceed (`webhook-outbound-fetch.util.ts`), then truncate again on persist/return. |
| UPLOAD-01 (pending quota race) | Create takes a per-user `pg_advisory_xact_lock` then counts + inserts in one transaction (`upload.repository.acquirePendingUploadQuotaLock`). |
| R3 / BILL-04 / MCP-01 / MCP-02 (catalog↔runtime drift) | `docs/routes.txt` is generated from source + a hard-coded supplemental list that **includes** `/livez`, `/readyz`, `/metrics`, `/internal/ops/*`, and `/api/v1/mcp`; CI fails on drift via `routes:catalog:check`. `POST /api/v1/billing/webhook` **is** registered (the canonical path). |
| AUTH-09 (password reset atomic) | Already wrapped in `withTransaction` + `runWithPinnedDatabaseHandle`. |

---

## Deferred items (with rationale, recommendation, and test plan)

### TEN-07 / USER-10 / TEN-08 / USER-11 — private bucket + signed-on-read media

- **Fix:** logos now store the object **key** (not a permanent unsigned public URL);
  both the user and organization serializing services resolve `avatar_url` /
  `logo_url` to a short-lived **presigned GET URL** on every read via
  `resolveStoredMediaReadUrl` (`shared/utils/infrastructure/media-url.util.ts`) and
  the per-service `toUserOutput` / `toOrganizationOutput` resolvers (used by single
  reads and list maps alike). External absolute URLs (OAuth-provider avatars, legacy
  public logos) are returned as-is, never re-signed. The presign is a network-free
  local signature, so it stays clear of the RLS-context network-isolation guard.
- **Tests:** `user.service.unit.test.ts` — avatar stored as key, returned as signed
  URL; `organization.service.unit.test.ts` — TEN-07 logo stored as key (not via
  `getObjectUrl`), returned signed.

### TEN-06 / USER-04 / USER-09 — durable offboarding reconciler

**Status:** built (see the offboarding reconciler worker).
**Current mitigations already in place:** both organization-delete and user-delete are
idempotent (`deletion_started_at` watermark) and correctly ordered (Stripe cancel
/ session revoke are checkpoints before the soft-delete; S3 cleanup runs last), so
**re-invoking the delete endpoint safely resumes** a partial offboarding. The
reconciler adds the missing *automatic* retry of a stuck offboarding.

### AUTH-03 / AUTH-08 (public send-email atomicity) — intentionally swallowing

`email/send-code` and `password/forgot` deliberately use the swallowing `eventBus.emit`
for the email side effect: these are anti-enumeration endpoints that must return a
constant response regardless of whether the account exists. Switching to
`emitStrict` would surface an outbox failure as a 503 for a *known* email while an
*unknown* email still returns 200 — a status oracle during outbox outages. The
outbox row is still written inside the request context; only the rare INSERT-failure
case is swallowed (the user simply retries). **Left as-is by design**; documented
here so it is not "fixed" into an enumeration regression. AUTH-19
(resend-verification) is authenticated and could be tightened if desired.

### Retention upper bounds

No configurable data-/session-retention settings are exposed via any API
(`user-settings` / `organization-settings` schemas have none), so there is nothing
to bound. N/A.

---

## Running the regression suite

```bash
# Unit (no infra needed) — covers every *.unit.test.ts above
pnpm test:unit

# Full suite incl. e2e/route + security/RLS (needs Postgres + Redis)
pnpm compose:up && pnpm db:migrate && pnpm test

# Targeted security/RLS lane (system-table tombstone policies, etc.)
pnpm test:security

# Static gates the fixes must keep green
pnpm validate            # lint + format + typecheck
pnpm routes:catalog:check
pnpm db:migrate:lint
pnpm tsdoc:check
```
