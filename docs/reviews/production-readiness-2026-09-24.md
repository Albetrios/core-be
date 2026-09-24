# Production readiness review — 2026-09-24

> Point-in-time snapshot of what is still pending after a production-readiness pass over `main` at
> `971978a7`. The frontend half is core-fe's `docs/reviews/2026-09-24-production-readiness.md`. Add a
> new dated file for the next review rather than rewriting this one.
>
> **Security and privacy findings are not listed here.** This repository is public, so 18 of them are
> tracked privately and will be recorded here once they are fixed.

## How to read this

- **Blocker:** fix before real users.
- **Needs an operator:** a change outside the repository (hosting, dashboards, local env files) or a decision.
- **Should fix:** can follow soon after launch.
- *Unverified* marks findings from code review that still need a check against the live setup.

## Done during the review

- [x] Deleted the production GitHub Environment variable `API_DOCS_BASE_URL`. It pointed at a production
      API host that has since been removed.

## Blockers

- [ ] **Rollback redeploys the live image.**
  - **Problem:** after every production deploy, `.github/workflows/reusable-railway-deploy.yml` (step
    "Retag production images as previous") tags the image it has *just deployed* as `:previous`, and
    `.github/workflows/rollback-deploy.yml` deploys `:previous`. A rollback therefore redeploys the
    current version. It also checks out `main`'s tip, so it runs `main`'s unreleased migrations and seed.
  - **Fix:** roll back by dispatching `release-deploy.yml` with the previous release tag. That path pins
    the image, checkout, migrations and seed to the tag. Retire or rewrite `rollback-deploy.yml` and
    `docs/deployment/runbooks/rollback-deploy.md`.
- [ ] **Nothing alerts when a process dies.**
  - **Problem:** there is no uptime monitor and no scheduled check-in, and
    `docs/process/sentry-alerts.md` only *recommends* alert rules. The DLQ, pool and Redis alerts are
    raised from inside the worker, so a dead worker or API sends nothing. *(Sentry setup unverified.)*
  - **Fix:** a Sentry Uptime monitor on `/readyz`, a Sentry Crons check-in from a frequent scheduled
    job, and the alert rules from `docs/process/sentry-alerts.md` created in the Sentry project.
- [ ] **Sessions on the hosted development site don't survive a reload** (shared with core-fe).
  - **Problem:** the hosted development frontend and API are served from different sites, and
    `COOKIE_SAMESITE` is left at its default, `strict`. The refresh cookie is then neither stored nor
    sent, so a reload, or the 15-minute access-token expiry, signs the user out. Safari and iOS would
    block the cookie even with `SameSite=None`. *(From config and code; not tested with a sign-in.)*
  - **Fix (backend half):** once the frontend is served from the same site as the API (core-fe's review
    covers that half), point `FRONTEND_URL` and `ALLOWED_ORIGINS` at it. Settle the domain before anyone
    registers a passkey: the WebAuthn RP ID comes from the first allowed origin, so moving later orphans
    every passkey.

## Needs an operator

- [ ] **Two stuck release deploys.** The `release-deploy.yml` run for v6.0.1 has waited for approval
      since 2026-09-19, with v7.0.2 queued behind it. Approving v6.0.1 would deploy an old version.
      Cancel both.
- [ ] **Local env files.** `pnpm github:sync` pushes these files, so edit them rather than GitHub or
      Railway:
  - [ ] Remove `API_DOCS_BASE_URL` from `.env.production`, or the next sync restores it.
  - [ ] Before production goes live, set `FRONTEND_URL`. Without it, email links fall back to
        `http://localhost:5173`.
- [ ] **External services.** Check the Stripe webhook endpoints and the Google/GitHub OAuth redirect
      URIs for anything still pointing at the removed production API host.
- [ ] **Railway.** Set the SIGTERM→SIGKILL window (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` of at least 25)
      on the API and worker services. The app needs about 25 s to drain. *(Current value unverified.)*
- [ ] **Sentry.** Add the uptime monitor, Crons check-in and alert rules from the blocker above.

## Should fix

- [ ] **The migration runner sets no `lock_timeout`.** `src/infrastructure/database/migration/migrate.ts`
      sets only `connect_timeout`, so a DDL statement queued behind a long transaction blocks every later
      query on that table. Set a `lock_timeout` with a bounded retry.
- [ ] **Required production config.** `FRONTEND_URL`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` and
      `SENTRY_DSN` are optional in production. Add production refines, including an https, non-localhost
      `FRONTEND_URL`.
- [ ] **An unreleased migration will break the expired-token purge later.**
      `migrations/20260923120000_verification_tokens_rls_deny_all.sql` grants access to `core_be_app`
      only, but the purge runs in the maintenance context. Once `DATABASE_MAINTENANCE_URL` is set it will
      delete 0 rows. Grant `core_be_maintenance` too, with a test.
- [ ] **A green deploy doesn't prove the new image is live.** `/readyz` carries no build revision, so the
      old deployment also answers the post-deploy check. Expose the build sha and assert it after deploy.
- [ ] **Neon's pooler may drop the request-path database timeouts,** which are sent as startup
      parameters. Add a boot `SHOW` check that fails closed in production. *(Unverified.)*
- [ ] **The Stripe webhook is limited to 60 requests/min per IP.** Renewal bursts get 429s, and
      subscription state lags until Stripe retries. Raise the limit, or exempt requests once the
      signature is verified.
- [ ] **Restore drills can't run unattended.** They use the `production` environment, which needs
      reviewer approval. Give them an environment of their own.
- [ ] **A hotfix would ship unreleased breaking changes.** Release PR #1186 (8.0.0) carries
      `feat(auth)!` #1188 and `fix(api)!` #1223. Release 8.0.0 together with core-fe before launch, or
      document a tag-branch hotfix path.
- [ ] **`prom-client` is deprecated.** It has been replaced by `@prometheus-io/client`, which is still
      pre-1.0. It is used in 2 files under `src/infrastructure/observability/metrics/`.
- [ ] **Runbooks that are wrong:**
  - Release: production deploys go by manual dispatch from `main`; publishing a release doesn't trigger
    them.
  - Rollback: see the blocker above.
  - Worker healthcheck: `Dockerfile.worker` probes `/livez`, not `/readyz`.
  - Disaster recovery: edit `.env.production` and run `pnpm github:sync`. Changes made directly in
    Railway are overwritten by the next deploy.
  - `pnpm test:api-smoke` is described as a deploy gate, but no workflow runs it.
- [ ] **Nice to have:**
  - The connection budget counts one pool per process, but the maintenance pool and rolling deploys
    double it.
  - Redis `maxmemory-policy` is never checked.
  - The pre-deploy validator only checks that keys exist. Running the env schema there would catch a
    refine violation before the service crash-loops.

## Carried over from earlier

- [ ] **Nightly k6 on `main`** with #1218, #1219 and #1220 together. No run has covered this yet.
- [ ] **k6 front-end surface drift.** core-fe #352 added two invitation calls (resend and cancel) that
      `fe-full-surface` doesn't exercise.
- [ ] **Env-var registry.** 13 of 223 variables use `envVar()`; the agreed conversion isn't built.
- [ ] **Decisions:**
  - Whether Sentry should sample overload and deadline 503s.
  - The overload guard's behaviour under bursts.
  - BullMQ sharing the cache Redis.
  - Replaying every migration on a fresh hosted database as the owner role.
- [ ] **Owner decisions deferred earlier:** centralising the 32 per-worker `stalled` listeners;
      time-partitioning `audit.logs` and `webhook_delivery_attempts`; `READYZ_503_ON_OPEN_CIRCUIT`.
- [ ] **Release** #1186 (8.0.0): merge when you mean to release.
- [ ] **Production-only checks:** capacity on Railway + Neon; index usage about two weeks after #1201
      deploys; Neon cold starts; Redis failover; database role grants.

SonarQube in PR CI is deferred by decision, so it isn't listed as pending.

## Verified OK

- **CI and dependencies:** CI is green on `main`. There are no open Dependabot, code-scanning or
  secret-scanning alerts, and `pnpm audit` is clean.
- **Production switches:** the API reference, the MCP server and queue-dashboard mutations are off;
  cookies are Secure; database SSL is on.
- **Code:** production env refines, JWT (RS256, session-bound tokens), CSRF on refresh, the CORS
  allow-list, rate limiting with a Redis fallback, idempotency, database and Redis timeouts, outbound
  timeouts and circuit breakers, SSRF protection on webhooks, log redaction, ordered worker shutdown and
  container hardening.
- **Blocking CI scans:** `pnpm audit`, gitleaks, Trivy, dependency review and actionlint.
