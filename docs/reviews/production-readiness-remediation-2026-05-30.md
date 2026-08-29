# Production-readiness remediation tracker — 2026-05-30

> **Status companion** to the historical audit in [production-readiness-audit-2026-05-29.md](production-readiness-audit-2026-05-29.md). That file is frozen; this tracker records what landed on `dev` and what remains open.
>
> **Baseline branch:** `dev` at release `3.3.2-dev.0` (PRs #174–#186 merged through 2026-05-30).

## Legend

| Status | Meaning |
| --- | --- |
| **Done** | Merged to `dev` with tests/docs |
| **Partial** | Mitigation shipped; follow-up called out |
| **Open** | Not yet implemented on `dev` |
| **Verify** | Code exists; requires hosted/staging confirmation |

---

## Consolidated audit findings (1–16)

| # | Finding | Status | Landed in | Notes |
| ---: | --- | --- | --- | --- |
| 1 | DB superuser / BYPASSRLS bypasses RLS | **Done** | #164, #182 | `assert-database-rls-safety.ts` fail-closed in hosted envs |
| 2 | Redis blip → global rate limit fail-closed | **Done** | #165 | `skipOnError: true` on global limiter |
| 3 | Global rate limit trusts `X-Organization-Id` | **Done** | #160 | Global key is IP-only; organization quotas in post-auth presets |
| 4 | `TRUST_PROXY` boolean / spoofable IP | **Done** | #168 | Hop-count parsing + hosted assertion |
| 5 | Per-request RLS pins DB connection | **Done** | #174, #178, #182, *this PR* | `DATABASE_RLS_SCOPED_CONTEXTS` defaults `true`; k6 concurrency scenario; global guard forbids outbound I/O inside DB context callbacks |
| 6 | Index migrations block writes pre-deploy | **Done** | #176 | Concurrent non-transactional migration lane |
| 7 | Anonymous idempotency cross-caller replay | **Done** | #178, #184 | Skip/fingerprint on unauthenticated auth routes |
| 8 | CAPTCHA off-by-default in production | **Done** | #180, #186, #188 | Production boot requires `CAPTCHA_PROVIDER=turnstile` + `CAPTCHA_SECRET`; removed `CAPTCHA_DISABLED_ACK` fail-open path |
| 9 | Shutdown without LB drain delay | **Done** | #178 | 3s drain in staging/production before `app.close()` |
| 10 | `/health` conflates liveness/readiness | **Done** | #178 | `/livez` + `/readyz` with short readiness cache |
| 11 | Migration runner no advisory lock | **Done** | #178 | `pg_advisory_lock` in migrate runner |
| 12 | Session cache accepts expired token ≤60s | **Done** | #178 | TTL bounded to `min(60s, session remaining)` |
| 13 | Global idempotency counter hot key | **Done** | #184 | Request fingerprint in cache key; observability sampling |
| 14 | `unhandledRejection` kills process | **Done** | #184, *this PR* | Burst-tolerant handler (20/min window) + metrics; documented in [process-error-handling.md](../reference/reliability/process-error-handling.md); `uncaughtException` remains immediate exit |
| 15 | DLQ enqueue best-effort only | **Done** | #182 | `audit.dead_letter_jobs` Postgres ledger |
| 16 | Client-supplied `x-request-id` | **Done** | #178 | Strict pattern validation in `genReqId` |

---

## Extended audit bugs (31–64)

| Bug | Title | Status | Landed in | Notes |
| ---: | --- | --- | --- | --- |
| 31–34 | Session issuance / token consume / suspend paths | **Done** | #182, #184 | Active-account gate, atomic token consume, session revoke on suspend |
| 35–36 | Invitation accept + API-key auth principal | **Done** | #182 | Membership activation; API-key wiring |
| 37 | Upload quota race on presign | **Done** | #182 | Atomic pending slot reservation |
| 38 | (Permission cache — see 58) | **Done** | #182 | — |
| 39 | WebAuthn origin allowlist | **Done** | #184 | `resolveWebauthnExpectedOrigin` |
| 40 | Stripe provider errors mutating local state | **Done** | #184 | Fail-closed on provider errors |
| 41 | OAuth signup orphan user | **Done** | #184 | Transactional find-or-create + link |
| 42–43 | DLQ replay metadata | **Done** | #184 | Replay keys for webhook/stripe/notification |
| 44–56 | Idempotency / auth escalation / RLS / queue | **Done** | #184 | See PR #184 description |
| 57 | Removed organization user can delete organization uploads | **Done** | #186 | `upload:manage` gate on organization-scoped get/confirm/delete |
| 58 | Permission cache not invalidated on revoke | **Done** | pre-#186 | Already on `dev`; audit text was stale |
| 59 | WebAuthn enumeration / MFA bypass | **Done** | #186 | CAPTCHA + normalized options errors; verify uses `completeFirstFactorAuth` (#184) |
| 60 | Stripe same-second stale events | **Done** | #186 | Strict `<` on sync; cancel keeps `<=` tie-break |
| 61 | Auth email flows return success when mail fails | **Partial** → **Done*** | #186, *this PR* | Magic-link + password-reset in #186; **email verification** completed in follow-up PR |
| 62 | Multiple live magic-link tokens | **Done** | #186 | Invalidate prior `MAGIC_LINK` before create |
| 63 | mark-all-read unbounded response | **Done** | #186 | Returns `{ updated_count }` only — **breaking** for clients expecting rows |
| 64 | Webhook URL secrets in logs | **Done** | #186 | `safeWebhookUrlForLogs` (origin/path/hash) |

---

## Open / follow-up work

| Priority | Item | Suggested action |
| ---: | --- | --- |
| P2 | **Remediation doc maintenance** | Update this file when new dated audits land |
| P2 | **Stale branches** | Close `fix/extended-audit-security-hardening` and `fix/auth-session-and-tenant-correctness` after diff vs `dev` (superseded by #182/#184) |
| P2 | **Dependabot high alert** | Triage on default branch |
| P3 | **Biome unused-import warnings** | Done in #188 auth cleanup |
| Release | **PR #157 dev → main** | Promote after staging verification checklist passes |

---

## Staging verification checklist

Run before production traffic:

- [ ] `DATABASE_URL` role is non-superuser, non-`BYPASSRLS`, granted `core_be_app`
- [ ] `TRUST_PROXY=1` (or correct hop count) on Railway
- [ ] `CAPTCHA_PROVIDER=turnstile` + `CAPTCHA_SECRET` set (production boot fails otherwise)
- [ ] `RESEND_API_KEY` set; forgot-password / magic-link / resend-verification return 503 when unset (not false success)
- [ ] Removed organization member cannot GET/confirm/DELETE organization-scoped upload
- [ ] WebAuthn authenticate options returns indistinguishable 401 for unknown email / no passkeys
- [ ] `POST /notify/notifications/mark-all-read` returns `{ updated_count }` only
- [ ] `pnpm verify:base` green against staging stack
- [ ] k6 RLS concurrency SLO (#174) within bounds on staging

---

## PR index (remediation wave)

| PR | Summary |
| --- | --- |
| #174 | k6 RLS concurrency-beyond-pool + nightly SLO |
| #176 | Concurrent index migration lane (audit #6) |
| #178 | Audit #7–#16, `/livez`/`/readyz`, shutdown drain |
| #180 | Production readiness items 3–8 |
| #182 | Auth/RLS/DLQ/uploads extended hardening |
| #184 | Idempotency, auth escalation, queue reliability (bugs 44–56) |
| #186 | Upload revocation, auth/billing/notify (bugs 57–64) |
| #188 | Email verification fail-closed, remediation tracker, CAPTCHA production gate, auth lint cleanup |
| *this PR* | RLS context network-isolation guard (finding #5); process error-handling doc (finding #14) |

---

*Last updated: 2026-05-30.*
