`src/`

# System policy constants

Every value here is a deliberate business, UX, or security trade-off. Each entry records what the value is, why it was picked, what changes if you move it, and when it was last reviewed. **Changing one requires updating this file in the same commit and re-running PR review.**

The canonical exports live under [src/shared/constants/](src/shared/constants/) (`ttl.constants.ts`, `limits.constants.ts`, `security.constants.ts`, `pagination.constants.ts`, `billing.constants.ts`, `roles.constants.ts`, `query-limits.constants.ts`, `notification.constants.ts`, `project-identity.constants.ts`). When a new policy constant is added there, the `tsdoc-export-guard` skill cross-pings `system-narrative-maintainer` to add a row here.

## VERIFICATION_CODE_TTL_MINUTES

- **Value**: 15 minutes
- **Source**: [src/domains/auth/sub-domains/auth-method/verification-code.ts](src/domains/auth/sub-domains/auth-method/verification-code.ts) (domain-local constant, not under `shared/constants/`)
- **Rationale**: Balances security (limited replay window) and UX (a user must have time to switch from the login form → email client → read and type the code).
- **Consequences of change**:
  - Decreasing → tighter replay window; users on slow devices or pulling email through corporate spam filtering may miss the window and have to retry.
  - Increasing → larger token replay window; review with security if pushing past 30 minutes.
- **Last reviewed**: 2026-05-28

## PASSWORD_RESET_EXPIRES_IN_MINUTES

- **Value**: 60 minutes
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Password resets are deliberately less time-pressured than email verification-code sign-ins — users may be locked out of their inbox temporarily, may need to switch devices, and the recovery flow is a 1× operation rather than a sign-in primitive.
- **Consequences of change**:
  - Decreasing → support tickets from users who couldn't reach a working device in time.
  - Increasing → larger reset-token replay window; pair with stricter throttle if pushing past 24 hours.
- **Last reviewed**: 2026-05-28

## ACCESS_TOKEN_EXPIRY_SECONDS

- **Value**: 900 seconds (15 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Short JWT access-token lifetime is the primary mitigation for stolen tokens. Refresh happens via the session cookie (Origin-checked, see [`docs/reference/security/csrf-and-session-cookies.md`](docs/reference/security/csrf-and-session-cookies.md)). 15 minutes is the industry-standard balance of revocation latency vs network chatter.
- **Consequences of change**:
  - Decreasing → more refresh requests under load; each one hits Postgres + Redis.
  - Increasing → longer window where a leaked token remains usable; requires reviewing the session-revocation propagation strategy.
- **Last reviewed**: 2026-05-28

## SESSION_TOKEN_CACHE_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Positive cache for valid session-token lookups in Redis. 60 s is the upper bound on how long a revoked session may keep working — the auth middleware always re-validates against Postgres after the cache expires.
- **Consequences of change**:
  - Decreasing → higher Postgres load on every authenticated request.
  - Increasing → longer window where a revoked session keeps working; review with security.
- **Last reviewed**: 2026-05-28

## IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS

- **Value**: 86 400 seconds (24 hours)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Stripe and most enterprise webhook senders allow up to 24 h replays of the same `Idempotency-Key`. We mirror that window so retries from any client get the original response back, not a new one.
- **Consequences of change**:
  - Decreasing → callers may get a fresh execution on long retries; review compatibility with Stripe.
  - Increasing → larger Redis footprint; bounded by `IDEMPOTENCY_CACHED_BODY_BYTES`.
- **Last reviewed**: 2026-05-28

## IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS

- **Value**: 60 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: TTL of the in-flight SETNX placeholder claimed by the first concurrent caller. 60 s is enough to cover the slowest legitimate request (Stripe API call + Postgres write) while bounding the wait for a second caller if the first crashes mid-flight.
- **Consequences of change**:
  - Decreasing → second concurrent caller may run a duplicate execution earlier on a crash.
  - Increasing → second caller waits longer on a crash.
- **Last reviewed**: 2026-05-28

## IDEMPOTENCY_CACHED_BODY_BYTES

- **Value**: 102 400 bytes (100 KiB)
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Cap on the response body cached against an `X-Idempotency-Key`. Above this, the cached response is replaced with a `409` so we never blow up Redis with multi-MB payloads.
- **Consequences of change**:
  - Decreasing → more endpoints fall over the cap and lose idempotency replay.
  - Increasing → larger Redis footprint per stored entry.
- **Last reviewed**: 2026-05-28

## MFA_SESSION_TTL_SECONDS

- **Value**: 300 seconds (5 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: MFA challenge ticket lifetime in Redis between successful primary-credential verification and the second-factor submission. 5 minutes is enough to switch to an authenticator app or hardware key without forcing a fresh login.
- **Consequences of change**:
  - Decreasing → users with slow context-switching fail MFA more often.
  - Increasing → larger replay window for a half-completed login; review with security.
- **Last reviewed**: 2026-05-28

## WEBAUTHN_CHALLENGE_TTL_SECONDS

- **Value**: 300 seconds (5 minutes; alias of `MFA_SESSION_TTL_SECONDS`)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: WebAuthn ceremony challenge lifetime in Redis. Same trade-offs as MFA challenges — kept identical so authenticator and platform flows feel uniform.
- **Consequences of change**: See `MFA_SESSION_TTL_SECONDS`.
- **Last reviewed**: 2026-05-28

## OAUTH_STATE_TTL_SECONDS

- **Value**: 600 seconds (10 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Lifetime of the OAuth `state` parameter in Redis between redirect to the provider and the callback. 10 minutes covers slow OAuth provider response while bounding the CSRF replay window.
- **Consequences of change**:
  - Decreasing → users may fail the callback if the provider stalls.
  - Increasing → wider CSRF replay window; review with security.
- **Last reviewed**: 2026-05-28

## PERMISSION_CACHE_DEFAULT_TTL_SECONDS

- **Value**: 300 seconds (5 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Authoritative TTL on the per-`(user, organization)` permission set in Redis. Permission writes invalidate the cache, but we keep a short TTL as a safety net for cross-process invalidation gaps.
- **Consequences of change**:
  - Decreasing → higher Postgres load on permission resolution.
  - Increasing → revoked permissions may keep working longer if invalidation is missed.
- **Last reviewed**: 2026-05-28

## PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS

- **Value**: 15 seconds
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: SETNX lock TTL while a single process recomputes the permission set, preventing thundering-herd recomputes on cache-miss across many processes.
- **Consequences of change**:
  - Decreasing → herd risk returns if recomputation outgrows the window.
  - Increasing → latency on legitimate retries when the leader process crashes mid-recompute.
- **Last reviewed**: 2026-05-28

## MAX_FAILED_LOGIN_ATTEMPTS

- **Value**: 10 attempts
- **Source**: [src/shared/constants/security.constants.ts](src/shared/constants/security.constants.ts)
- **Rationale**: Threshold before an account enters lockout. High enough to avoid locking real users out from typo'd passwords, low enough to bound credential-stuffing attempts.
- **Consequences of change**:
  - Decreasing → more support tickets from typo lockouts.
  - Increasing → wider window for online password guessing.
- **Last reviewed**: 2026-05-28

## ACCOUNT_LOCKOUT_MINUTES

- **Value**: 30 minutes
- **Source**: [src/shared/constants/security.constants.ts](src/shared/constants/security.constants.ts)
- **Rationale**: Lockout duration after `MAX_FAILED_LOGIN_ATTEMPTS` exceeded. Long enough to deter password-guess attacks, short enough that legitimate users can retry within a single support call. The lock is evaluated *after* password verification, so a correct credential always bypasses it and clears the counter — the lock only rejects further wrong attempts, so it cannot be weaponized to deny the legitimate owner (no victim-account DoS). Online brute force is independently bounded by the per-IP + per-email rate limits and CAPTCHA on `/login`.
- **Consequences of change**:
  - Decreasing → less deterrent against credential-stuffing.
  - Increasing → more support pressure on legitimate-user lockouts.
- **Last reviewed**: 2026-05-28

## STUCK_SENDING_LEASE_MINUTES

- **Value**: 15 minutes
- **Source**: [src/shared/constants/billing.constants.ts](src/shared/constants/billing.constants.ts)
- **Rationale**: Mail outbox + Stripe webhook event reclaim lease. Rows stuck in `sending` / `processing` for longer than this are presumed orphaned (worker crashed or pod evicted) and may be reclaimed for retry. 15 minutes is the upper bound on a legitimate Stripe API call + Resend send.
- **Consequences of change**:
  - Decreasing → reclaim races with slow legitimate sends; may produce duplicate emails or duplicate Stripe processing.
  - Increasing → orphaned rows take longer to recover after a worker crash.
- **Last reviewed**: 2026-05-28

## STRIPE_WEBHOOK_STUCK_PROCESSING_LEASE_MINUTES

- **Value**: 15 minutes (alias of `STUCK_SENDING_LEASE_MINUTES`)
- **Source**: [src/shared/constants/billing.constants.ts](src/shared/constants/billing.constants.ts)
- **Rationale**: Same trade-offs as `STUCK_SENDING_LEASE_MINUTES`; kept aliased so the two lease windows always move together.
- **Consequences of change**: See `STUCK_SENDING_LEASE_MINUTES`.
- **Last reviewed**: 2026-05-28

## PAGINATION

- **Value**: `{ DEFAULT_LIMIT: 25, MAX_LIMIT: 100 }`
- **Source**: [src/shared/constants/pagination.constants.ts](src/shared/constants/pagination.constants.ts)
- **Rationale**: Cursor-only pagination defaults applied to every list endpoint. 25 is large enough for typical UI tables and small enough for sub-100 ms p95; 100 caps DOS exposure on bulk listing.
- **Consequences of change**:
  - Decreasing → more pagination round trips for batch consumers.
  - Increasing past 100 → review query plans for every list endpoint; some indexes assume LIMIT ≤ 100.
- **Last reviewed**: 2026-05-28

## DEFAULT_REPOSITORY_LIST_LIMIT

- **Value**: 500 rows
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Hard cap for unscoped repository list helpers (used in workers, scripts, internal tooling). Prevents accidental OOM from `findAll()` patterns.
- **Consequences of change**:
  - Decreasing → some workers may need explicit pagination they currently skip.
  - Increasing → wider blast radius for accidental fetch-all queries.
- **Last reviewed**: 2026-05-28

## GDPR_EXPORT_MAX_ROWS_PER_TABLE

- **Value**: 1 000 rows per table
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Per-table row cap inside a GDPR data export bundle. Keeps export bundles bounded and ensures the download URL TTL window covers the largest legitimate export.
- **Consequences of change**:
  - Decreasing → users with large histories may receive truncated exports; review with legal.
  - Increasing → larger S3 objects, longer worker time-to-complete, larger Redis cardinality.
- **Last reviewed**: 2026-05-28

## ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH

- **Value**: 32 bytes (256 bits)
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Raw secret length for organization API keys. 256-bit randomness, the standard for API tokens; only the prefix is stored in plaintext.
- **Consequences of change**:
  - Decreasing → reduced collision-resistance margin; never go below 16.
  - Increasing → cosmetic only; client SDKs may need to widen any fixed-length parsers.
- **Last reviewed**: 2026-05-28

## ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH

- **Value**: 8 characters
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Prefix length stored in plaintext for human disambiguation in dashboards/logs. Long enough to identify a key visually, short enough that it leaks no usable secret entropy.
- **Consequences of change**:
  - Decreasing → harder to disambiguate keys in audit logs.
  - Increasing → leaks more bits of the raw secret to anyone with read access to the prefix.
- **Last reviewed**: 2026-05-28

## USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS

- **Value**: 900 seconds (15 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: GDPR export download URL lifetime. sec-U6 shortened this from 24 h to 15 min: an exfiltrated session token used to be able to mint a URL that stayed valid for a full day and replay it. 15 min still gives the legitimate browser pull ample headroom (a single gzip download) while collapsing the stolen-token replay window. Every mint is recorded to `audit.logs` so forensics survive even after the URL expires.
- **Consequences of change**:
  - Decreasing → a slow download or interrupted pull may need a re-export; worker load increases.
  - Increasing → widens the stolen-token replay window; review with security before moving past 15 min (hard S3 SigV4 cap is 7 days, but the privacy posture is the binding limit).
- **Last reviewed**: 2026-07-09 (sec-U6)

## PRESIGNED_URL_EXPIRY_SECONDS

- **Value**: 900 seconds (15 minutes; alias of `ACCESS_TOKEN_EXPIRY_SECONDS`)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Default lifetime for S3 presigned upload/download URLs. Aligned with access-token TTL so a single auth burst (sign in → upload) succeeds end-to-end without refreshing.
- **Consequences of change**:
  - Decreasing → users on slow uploads may retry repeatedly.
  - Increasing → larger window where a leaked URL keeps working; review with security.
- **Last reviewed**: 2026-05-28

## CATALOG_CACHE_MAX_AGE_SECONDS / CATALOG_CACHE_STALE_WHILE_REVALIDATE_SECONDS

- **Value**: 300 s `max-age`, 60 s `stale-while-revalidate`
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Public-catalog (plan list, etc.) HTTP cache headers. Max-age aligned with `PERMISSION_CACHE_DEFAULT_TTL_SECONDS` so policy changes propagate at the same rate; SWR aligned with `SESSION_TOKEN_CACHE_TTL_SECONDS` for snappy follow-up requests.
- **Consequences of change**: Affects CDN behavior; coordinate with whoever owns the edge config.
- **Last reviewed**: 2026-05-28

## HEALTH_READINESS_PROBE_TIMEOUT_MS

- **Value**: 1 500 ms per dependency
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Per-dependency budget inside `GET /readyz`. The `/readyz` endpoint must return within Railway's readiness-probe window; with three probes (Postgres, Redis, BullMQ) running in parallel the worst-case is 1.5 s.
- **Consequences of change**:
  - Decreasing → flapping readiness on slow days; instances cycle.
  - Increasing → readiness probe may exceed Railway's deadline and the platform yanks traffic.
- **Last reviewed**: 2026-05-28

## CORS_PREFLIGHT_MAX_AGE_SECONDS

- **Value**: 86 400 seconds (24 hours)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Browser CORS preflight cache. 24 h reduces preflight chatter for SPAs without making CORS-policy changes propagate dangerously slowly (we don't tighten origins frequently).
- **Consequences of change**: When tightening `ALLOWED_ORIGINS`, expect up to 24 h of legacy clients still sending requests under the old policy.
- **Last reviewed**: 2026-05-28

## BULLMQ_DEFAULT_LOCK_DURATION_MS / BULLMQ_STALLED_INTERVAL_MS

- **Value**: 30 000 ms (30 s) each
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Worker lock duration and stalled-job check interval. 30 s is BullMQ's recommended floor that avoids spurious re-runs on legitimately slow jobs while still recovering quickly from a worker crash.
- **Consequences of change**:
  - Decreasing → spurious re-runs on slow jobs (duplicate emails, duplicate Stripe processing).
  - Increasing → slower recovery from a crashed worker; jobs sit unclaimed longer.
- **Last reviewed**: 2026-05-28

## BULLMQ_WEBHOOK_LOCK_DURATION_MS

- **Value**: 60 000 ms (60 s)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Webhook delivery worker lock. Doubled vs default because the slowest legitimate downstream webhook receiver is allowed up to 60 s before we treat the attempt as failed.
- **Consequences of change**: See `BULLMQ_DEFAULT_LOCK_DURATION_MS`.
- **Last reviewed**: 2026-05-28

## BULLMQ_RETENTION_LOCK_DURATION_MS

- **Value**: 120 000 ms (2 minutes)
- **Source**: [src/shared/constants/ttl.constants.ts](src/shared/constants/ttl.constants.ts)
- **Rationale**: Retention worker lock. Retention sweeps may scan large tables; 2 minutes covers the longest legitimate sweep without triggering spurious re-runs.
- **Consequences of change**: See `BULLMQ_DEFAULT_LOCK_DURATION_MS`.
- **Last reviewed**: 2026-05-28

## DEFAULT_BATCH_DELETE_ROW_COUNT

- **Value**: 5 000 rows per batch
- **Source**: [src/shared/constants/limits.constants.ts](src/shared/constants/limits.constants.ts)
- **Rationale**: Batch size for retention and tombstone-purge helpers. Large enough to amortize per-statement overhead, small enough that one batch fits in `BULLMQ_RETENTION_LOCK_DURATION_MS`.
- **Consequences of change**: Tune in lockstep with `BULLMQ_RETENTION_LOCK_DURATION_MS`.
- **Last reviewed**: 2026-05-28

## GLOBAL_ROLES

- **Value**: `{ SUPER_ADMIN: 'super_admin', USER: 'user' }`
- **Source**: [src/shared/constants/roles.constants.ts](src/shared/constants/roles.constants.ts)
- **Rationale**: Two-tier platform role, independent of organization-scoped permissions and granting nothing inside an organization. `super_admin` comes from the `GLOBAL_ADMIN_EMAILS` allowlist and is re-derived against live account state on every request; `user` is every other active account, and no guard tests for it. A third code, `admin`, was removed as never-issued: no mint path produced it, the auth middleware downgraded it on sight, and nine route guards accepted a value that could not occur.
- **Consequences of change**:
  - Adding a role → add the code that ISSUES it in the same change, then audit every JWT issuance path and `requireRole` call site. A role nobody mints is an authorization surface that reads as real and is not.
  - Removing a role → audit every Postgres row + JWT in flight. `admin` was safe to remove immediately because nothing minted it, and the auth middleware re-derives any claim that is not `user`, so a token carrying the retired value fails closed rather than being trusted.
- **Last reviewed**: 2026-09-20

## ORGANIZATION_TYPE_CAPABILITY_MATRIX

- **Value**: A `PERSONAL` organization cannot exercise the six team-only actions — invite members, manage members, manage roles, transfer ownership, delete, manage billing; a `TEAM` organization can. The organization `type` is the **sole** determinant (no per-organization or plan-based variation today).
- **Source**: [src/domains/tenancy/sub-domains/organization/organization-capability.ts](src/domains/tenancy/sub-domains/organization/organization-capability.ts) (`assertTeamOrganization(organization, capability)` enforces the rule; capability buckets `MEMBERS | ROLES | MUTATION | BILLING`).
- **Rationale**: There is **one** route surface for both organization types — no personal-only / team-only paths. The team-only actions are structurally unavailable to a single-owner personal workspace. Rather than fork the URL space, the team-only routes are backstopped by a single centralized guard; clients derive availability from the organization `type` (`PERSONAL` vs `TEAM`) and gate the action on the caller's permissions. The API response carries **no** `capabilities` object — it was a redundant projection of `type`; reintroduce a purpose-built `features`/`entitlements` object only if availability ever stops being purely type-derived. The team-only routes: `DELETE /api/v1/tenancy/organization`, `POST /api/v1/tenancy/organization/invitations`, `POST /api/v1/tenancy/organization/memberships`, `POST /api/v1/tenancy/organization/transfer-ownership`, `POST /api/v1/tenancy/organization/roles`, and the four subscription mutations (`POST /api/v1/billing/subscriptions` + `/{subscription_id}/change-plan`, `/cancel`, `/resume`).
- **422-on-personal-organization policy**: `assertTeamOrganization` rejects a personal organization with **HTTP 422** (`unprocessable_entity`), not 409. The organization `type` is **immutable**, so an identical retry can never succeed — 409 (transient state conflict) would mislead clients into retrying. See [docs/reference/api/response-codes.md](docs/reference/api/response-codes.md) (`409 vs 422`) and [docs/reference/api/route-consistency-and-organization-model.md](docs/reference/api/route-consistency-and-organization-model.md).
- **Consequences of change**:
  - Adding a team-only action → call `assertTeamOrganization(organization, <bucket>)` in its service before the mutation, and add the route to the list above.
  - Allowing a personal organization to gain a team capability → would require making the organization `type` mutable; that changes the 422 rationale (a retry could then succeed) and must be reviewed against the response-code policy.
  - Re-introducing client-facing availability hints → build a purpose-named `features`/`entitlements` object (not a `type` mirror) when a real per-organization/plan need exists.
- **Last reviewed**: 2026-06-24

## SLUG_REGEX / UUID_REGEX

- **Value**: `^[a-z0-9]+(?:-[a-z0-9]+)*$` / standard 36-char UUID
- **Source**: [src/shared/constants/index.ts](src/shared/constants/index.ts)
- **Rationale**: Bounded patterns used for input validation. The slug regex disallows leading/trailing hyphens and consecutive hyphens — required by URL-segment hygiene and by Postgres index assumptions on slugged columns.
- **Consequences of change**: Loosening either invalidates URL constraints baked into routes and migrations.
- **Last reviewed**: 2026-05-28
