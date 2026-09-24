---
name: be-env-schema-add
description: Walk through adding, renaming, or removing an env var safely. Decides Secret vs Variable, picks the correct .env.example sub-section, keeps the schema, template, validators, and GitHub Environments in sync. Use when src/shared/config/env-schema.ts or .env.example changes.
trigger: src/shared/config/env-schema.ts, .env.example
triggerNote: Env var add/rename/remove
indexNote: add/rename/remove an env var; keep schema + .env.example + GitHub envs in sync
---

# Env schema add (core-be)

Use this skill whenever you **add, rename, or remove** an environment variable.
Adding a key is **two aligned decisions**: its **classification** (GitHub Secret vs
Variable) and — wherever a workflow consumes it — its **access context**
(`secrets.NAME` vs `vars.NAME`). `pnpm github:sync` classifies each key by **name**
via `classifyKey()` (`tooling/setup/github/sync-github-environments.ts`); the
`.env.example` half is the human-readable mirror of that decision, so keep the half
you place a key under in agreement with what `classifyKey` will do. Get the
classification right **and** read it from the matching context in every workflow,
and the rest of the toolchain (github:sync, deploy, Actions) just works.

## Environment model — local + dev + prod; NO NODE_ENV branching

`NODE_ENV` is an enum of exactly **`local | development | production`** (no `test` / `staging`).
`local` is a developer's machine (primary file `.env.local`, self-contained); `development` /
`production` are the two DEPLOY targets (the deploy-target enums in `tooling/setup/` stay
`development | production` — you never deploy to `local`). The default is `local`: an unset `NODE_ENV`
is a developer's machine (a stock `pnpm dev`, a local `pnpm db:*`). Every DEPLOY and CI context sets
`NODE_ENV` explicitly (workflows, both Docker stages, the Vitest harness pin it), so the default never
reaches a deployed or CI runtime. The Vitest suite runs as `development`; test-only behaviour is driven
by explicit flags the harness sets. An out-of-enum value fails loudly at boot (`env.config.ts`
eager-parses `envSchema` and throws) — never a silent default.

**Runtime code NEVER compares or branches on `NODE_ENV`.** It is *compared* in exactly one file —
`env-schema.ts` (the enum field and `.refine()` constraints on the parsed `data`, e.g.
`data.NODE_ENV !== 'production' || FLAG === true`). The pre-schema `load-env-files.ts` loader *reads*
`process.env.NODE_ENV` only to name the `.env.<NODE_ENV>` file — no comparison. Every
environment-varying behaviour is an explicit env flag with a **STATIC default** (never
`NODE_ENV`-derived). Enforced by `src/tests/global/no-nodeenv-branching.global.test.ts` and the
`guard-edits.sh` R4 pre-edit hook.

## Env-flag principles (non-negotiable)

1. **Conditions live in the env layer; code reads one specific flag.** Every environment-varying
   condition (prod-forbidden, allowed-only-when, must-be-true-in-prod) is a `.refine()` in
   `env-schema.ts`. Runtime code reads the specific `env.FLAG` boolean and runs on it — it never
   re-derives the condition, compares `NODE_ENV`, or combines flags to reconstruct a rule. Layered:
   env validates/gates, code consumes one flag.
2. **One thing → exactly one env variable.** A single behaviour is gated by ONE flag, never two. Using
   `env.A && env.B` (or `||`) to make a single decision is banned — collapse it to one flag. Example:
   the destructive wipe helpers gate on `env.TEST_MODE` **alone**, not `TEST_MODE && TEST_DATA_WIPE_ALLOWED`.
   This holds for new work too — never add a second flag for a thing that already has one.
3. **Casing: env vars are `UPPER_SNAKE_CASE`; body fields are `snake_case`.** Environment variables are
   always `UPPER_SNAKE_CASE` (`TEST_MODE`, `DEMO_EMAIL`). A `snake_case` identifier like
   `debug_verification_code` is a request/response **body field** (API-contract snake_case), NOT an env
   var — do not confuse the two or "capitalise" a body field.

**To add an environment-varying behaviour** (e.g. "strict in prod, relaxed in dev"):

1. Add a boolean flag via `booleanString('<static default>')` in `env-schema.ts` — the default is the
   **production-safe** value (a deployed `.env` keeps it by omission).
2. **Production-strict is mandatory for every security/behaviour flag.** Any new — OR newly
   security-relevant existing — flag whose weakened value would loosen a guard MUST have a
   Category-B `.refine((data) => data.NODE_ENV !== 'production' || data.FLAG === <safe>, {...})` in the
   `env-schema.ts` "Category-B environment constraints" block, so a deploy that sets the unsafe value
   fails schema validation loudly instead of silently weakening prod. Mark the field `// Category-B
(security)` and note the prod requirement in `.env.example`. (Doc/URL/tuning-only vars — pool sizes,
   log levels, base URLs — are exempt; the test is "does the wrong value weaken a security guard.")
   Cover it with a unit test: `rejects FLAG=<unsafe> in production` + `allows <unsafe> outside
production` (see `env-schema.unit.test.ts`).
3. Read `env.FLAG` in code — **never** `NODE_ENV`.
4. Ship the **development** value ACTIVE (uncommented) in the `.env.example` Policy-flags section so
   `pnpm dev` behaves like a dev box.
5. If tests need a value, set it in `src/tests/setup.ts` (+ `bootstrap-env.ts` for chaos) with `??=`.

Never reintroduce a removed `NODE_ENV` value (`test`/`staging`), `isProduction()` /
`isDevelopment()`-style helpers, or a module-load `process.env.NODE_ENV` read to pick a default — the
guard test fails the build. (`local` is a valid value; the loader may name `.env.local` from it but
must never *compare* against it.)

## The two-half rule

`.env.example` has exactly two top-level halves, marked by `# ###...###` banners:

```text
# ############################################################
# GitHub Secrets (pushed via `gh secret set`)
# ############################################################

# --- Database (Postgres) ---
DATABASE_URL=...

# ############################################################
# GitHub Variables (pushed via `gh api .../variables`)
# ############################################################

# --- Server & process ---
PORT=3000
```

Every key sits under exactly one half. Sub-sections (`# --- Title ---`) group
related keys for readability. Hosted environments are listed in
`tooling/setup/setup.config.json` (canonical); `pnpm tool:generate-project-identity`
regenerates project identity constants and the CI composite action. `pnpm github:sync`
reads `setup.config.json` directly and creates missing `.env.<environment>` files.
The half you choose must agree with `classifyKey()` (name-based): `pnpm github:sync`
parses `.env.<environment>` flat and classifies each key by name, so the section is
the **human-readable mirror** of that rule — not an independent override.

## Decision tree — Secret or Variable

Apply in order; the first rule that matches wins.

1. **Is the value a credential or signing material?** → **Secret**.
   Examples: database connection string with embedded password (`DATABASE_URL`),
   `JWT_PRIVATE_KEY`, `JWT_SECRET`, `*_API_KEY`, `*_TOKEN`, `*_DSN`, `*_WEBHOOK_SECRET`,
   `*_ACCESS_KEY_ID`, `*_SECRET_ACCESS_KEY`, AES encryption keys (`SECRETS_ENCRYPTION_KEY`),
   OAuth `*_CLIENT_SECRET`.
2. **Would leaking the value cost money, breach identity, or grant unauthorized
   access to another system?** → **Secret**.
3. **Is the value a public identifier or operational knob?** → **Variable**.
   Examples: `PORT`, `LOG_LEVEL`, `WORKER_CONCURRENCY`, feature flags
   (`ENABLE_*`), URLs (`FRONTEND_URL`, `ALLOWED_ORIGINS`), public OAuth client
   IDs (`OAUTH_*_CLIENT_ID`), public WebAuthn RP info (`WEBAUTHN_RP_ID`),
   public CAPTCHA site key (`CAPTCHA_SITE_KEY`), public JWT verify key
   (`JWT_PUBLIC_KEY`).
4. **Edge case — `*_KEY` suffix.** The name alone is not enough:
   - `_PRIVATE_KEY`, `_SECRET_KEY`, `_API_KEY`, `_ACCESS_KEY_ID`,
     `_SECRET_ACCESS_KEY` → **Secret**.
   - `_PUBLIC_KEY`, `_SITE_KEY`, `_KID` → **Variable**.
   - AES-256 raw hex (`SECRETS_ENCRYPTION_KEY`, `RESPONSE_ENCRYPTION_KEY`) →
     **Secret** (encryption material).
5. **Still unsure?** Default to **Secret** — wrong-direction Secret-vs-Variable is
   the bigger risk (Variables are plaintext and world-readable inside the repo's
   GitHub Actions context, so a credential leaked there is a real breach).

## Accessing the var — runtime vs GitHub Actions

A key is read differently depending on where it is consumed. **Decide the
classification first, then read it from the matching context.**

- **App / worker runtime** (Node): `getEnv().NAME` — Zod-validated from
  `process.env` by `src/shared/config/env-schema.ts`.
- **GitHub Actions** (`.github/workflows/**`): the access context **must match the
  classification** —
  - **Secret** → `${{ secrets.NAME }}`
  - **Variable** → `${{ vars.NAME }}`

A mismatch fails **silently**: reading a Variable through `secrets.NAME` (or a Secret
through `vars.NAME`) returns an **empty string**, not an error. The step runs with
`NAME=""` and whatever consumes it (an upload, an API call) quietly misbehaves. This
is exactly what hid `SCALAR_NAMESPACE` — a Variable that the workflow read via
`secrets.SCALAR_NAMESPACE` — and silently skipped the Scalar Registry publish.

Rule of thumb: if `classifyKey()` calls it a Secret, read `secrets.NAME`; otherwise
read `vars.NAME`. Whenever you add a key or change its classification, **grep
`.github/workflows/` for the name** and confirm every reference uses the matching
context.

Related Actions gotcha: a step's own `env:` block is **not** available to that same
step's `if:` condition. Never gate a step on `env.NAME` defined in that step's `env:`
— gate on `inputs.*` / `vars.*` / job-level env, or let the consuming script
self-skip when the value is absent.

## Workflow when adding a new env var

1. **Add the Zod field** in `src/shared/config/env-schema.ts`.
   - Use `z.string().min(1)` / `z.coerce.number().int()` etc.
   - Mark `.optional()` if the runtime can work without it.
   - Add a `.default(...)` if you want a built-in fallback. Defaults free the var
     from `envSchemaRequiredKeys`, so it does **not** have to be set in every
     environment — useful for sensible operational defaults.
   - Add a refinement (`.refine`) for cross-field rules (e.g. "required when
     `FOO=true`") instead of duplicating logic at the call site.

2. **Add the key to `.env.example`** under the correct top-level half AND
   sub-section. Pick the sub-section that already exists when possible (e.g.
   add a new pool tuning knob under `# --- Database (Postgres) — pool & tuning ---`).
   Create a new sub-section only if no existing one fits.

   Keep a short description as a comment line above the `KEY=value` so the
   template stays self-documenting.

3. **Verify the schema ↔ template invariant:**

   ```bash
   pnpm tool:sync-env-example
   ```

   This script asserts:
   - Every schema key is documented in `.env.example`.
   - No uncommented `KEY=` in `.env.example` is absent from the schema.
   - The two top-level halves (`# GitHub Secrets` / `# GitHub Variables`) are
     both present (if either is missing, every key under the missing half would
     silently flip classification).

   If it reports missing keys, run `pnpm tool:sync-env-example --fix` to append
   commented placeholders, then move them into the right half/sub-section by
   hand and add descriptions.

4. **Ensure hosted environments are listed in `tooling/setup/setup.config.json`**, then run `pnpm tool:generate-project-identity`.

   `pnpm github:sync` scaffolds missing `.env.<environment>` files from that
   config. Existing local env files are not overwritten; update them manually
   when adding a new key so real values are preserved.

5. **Push to the live GitHub Environments:**

   ```bash
   pnpm github:sync development --dry-run  # preview the new key under the right header
   pnpm github:sync development            # push
   pnpm github:sync production --dry-run
   pnpm github:sync production
   ```

   `github:sync` reads the structure of `.env.<environment>` and pushes anything
   under the Secrets half via `gh secret set` and anything under the Variables
   half via `gh api .../variables`. Empty values are skipped.

6. **Update the PR description** with the snippet printed by
   `pnpm tool:sync-env-example` (under "--- Copy below into PR description ---").
   Reviewers and the deploy workflow read this to know which secrets / variables
   to provision in GitHub Environments before merge.

## Renaming a key

A rename is a delete + add, atomic in the same PR:

1. Add the new key to the schema and to `.env.example` under the right
   half/sub-section.
2. Update every code site that read the old key to read the new one.
3. Remove the old key from the schema, `.env.example`, and any consumers.
4. Run `pnpm tool:sync-env-example` — it must report 0 missing / 0 extra.
5. Update local `.env.<environment>` files manually so they contain the new key
   and no longer contain the old key.
6. After merge, run `pnpm github:sync <env>` for each environment. The old key
   stays in GitHub until you delete it manually (`gh secret delete` /
   `gh api --method DELETE .../variables/<name>`); call that out in the PR
   description so deploys do not carry stale config.

## Removing a key

1. Remove from `src/shared/config/env-schema.ts`.
2. Remove from `.env.example`.
3. Remove from any consumer code.
4. Run `pnpm tool:sync-env-example` — it should report 0 missing / 0 extra.
5. Update local `.env.<environment>` files manually to remove the key.
6. After merge, clean up GitHub manually:
   - Secret: `gh secret delete <NAME> --env <environment>`
   - Variable: `gh api --method DELETE repos/:owner/:repo/environments/<environment>/variables/<NAME>`

## Checklist

- [ ] Added Zod field with the smallest valid type (`.optional()` and `.default()` where applicable).
- [ ] **Production-strict:** any security/behaviour flag has a Category-B production `.refine()` pinning
      its production-safe value (deploy with the unsafe value → schema fails), a `// Category-B (security)`
      field comment, the prod requirement noted in `.env.example`, and a `rejects <unsafe> in production`
      unit test. (Doc/URL/tuning-only vars are exempt.)
- [ ] Added `KEY=placeholder` to `.env.example` under the correct **half**
      (`GitHub Secrets` vs `GitHub Variables`) and the correct **sub-section**.
- [ ] Description comment above the key explains what it controls and what
      a sensible value looks like.
- [ ] Every workflow that consumes the key reads it from the matching context
      (`secrets.NAME` for a Secret, `vars.NAME` for a Variable) — `grep` the name
      under `.github/workflows/`.
- [ ] `pnpm tool:sync-env-example` exits 0 (and reports both halves present).
- [ ] `tooling/setup/setup.config.json` lists every hosted environment; `pnpm tool:generate-project-identity:check` passes (new hosted env: update `NODE_ENV`, manifest, regenerate, then `pnpm github:sync`).
- [ ] Local `.env.<environment>` files were updated manually without discarding real values.
- [ ] `pnpm github:sync <env> --dry-run` shows the new key listed under the right
      `[secret]` or `[variable]` column for every hosted environment.
- [ ] PR description includes the "Environment variable changes" snippet from
      `pnpm tool:sync-env-example`.

## Reference

- **Canonical workflow runbook:** [`docs/deployment/runbooks/environment-variables.md`](../../../docs/deployment/runbooks/environment-variables.md) — read this first for the full lifecycle, validation matrix, and troubleshooting.
- **Hosted-environment plumbing:** [`docs/deployment/runbooks/add-new-environment.md`](../../../docs/deployment/runbooks/add-new-environment.md) — branch ↔ GitHub Environment ↔ `NODE_ENV` invariant.
- **Per-provider credential acquisition:** [`docs/integrations/credentials-and-env.md`](../../../docs/integrations/credentials-and-env.md).
- **Schema:** `src/shared/config/env-schema.ts`
- **Template:** `.env.example` (committed; two-half + sub-section structure)
- **Setup manifest:** `tooling/setup/setup.config.json` (single source of truth for project identity)
- **GitHub sync (incl. pushing env values):** `tooling/setup/github/sync.ts` — `pnpm github:sync [<environment>]`
- **Schema ↔ template validator:** `src/scripts/validators/env/sync-env-example.ts` (`pnpm tool:sync-env-example`)
- **Scaffolder:** `tooling/setup/envs/env-add.ts` (`pnpm env:add KEY --type <t> --section <secret|variable>`) — writes the key into BOTH the schema and `.env.example`; bare `pnpm env:add` is interactive
- **Pre-deploy runtime gate:** `tooling/setup/github/validate-environment-runtime.ts` (`pnpm validate:github-env-runtime`) — asserts every `envSchemaRequiredKeys` key is present in the exported GitHub Environment; runs in `reusable-railway-deploy.yml` before any container deploys
- **Cross-dimension consistency (in github:sync):** `tooling/setup/github/sync-config.ts` — run `pnpm github:sync --check` before pushing
- **Add hosted environment:** edit `tooling/setup/setup.config.json`, run `pnpm tool:generate-project-identity`, then `pnpm github:sync` (no script automates this — `env:add` adds a *variable*, not an environment)
