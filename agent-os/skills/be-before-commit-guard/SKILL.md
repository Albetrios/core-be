---
name: be-before-commit-guard
description: Ensures code is commit-ready. Invoked when the user runs git commit (enforced by Husky pre-commit) or when the user asks to fix a failed commit. Run the guard checks and fix any failures before committing.
indexNote: make code commit-ready; run when a pre-commit guard step fails
---

# Before-commit guard (core-be)

## Purpose

Ensure every **git commit** on this repo passes a fixed set of checks. The guard is **enforced** by the Husky pre-commit hook (`.husky/pre-commit`). When the hook fails or the user asks to fix commit/pre-commit errors, use this skill to resolve the failures.

## When to Use

- **Automatic:** The pre-commit hook runs on every `git commit`. If it fails, the commit is rejected.
- **Invoke this skill when:**
  - The user says their commit failed or pre-commit failed
  - The user asks to "fix before commit", "resolve commit errors", or "make code commit-ready"
  - The user edits `.husky/pre-commit` or `package.json` lint-staged config (sync the guard steps with this skill)

## What Runs on Commit (Pre-Commit Hook)

The hook in `.husky/pre-commit` delegates to **`pnpm guard:pre-commit`** (labeled steps). If any step fails, the commit is aborted — read the **`✗ FAILED at step N/M:`** line for the failing check. List all steps: **`pnpm guard:pre-commit:list`**.

| Step | Command / check | What to do if it fails |
| ---- | --------------- | ---------------------- |
| 1 | `pnpm lint-staged` | Biome on staged `src/**/*.ts` and `tooling/**/*.{ts,mjs,js}`; Biome format on `*.{json,yaml,yml}`; `markdownlint-cli2 --fix` on `*.md`. Run `pnpm lint` / `pnpm format`; for markdown run `pnpm docs:lint:fix`. Fix per **be-code-smells-and-best-practices**. |
| 1b | When `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` staged: `pnpm validate:lockfile` | Lockfile out of sync with the manifest — run `pnpm install` and stage `pnpm-lock.yaml`. |
| 2 | `pnpm typecheck` | TypeScript errors in `src/`. Fix types (no `any`, correct imports). |
| 3 | `pnpm validate:domain:strict` | Domain structure; warnings fail. Fix per **be-domain-generator** and CLAUDE.md. |
| 3b | Architecture policy tests (conditional) | `pnpm test:global` — runs when `src/domains/**/*.ts` files are staged; skipped otherwise |
| 4 | `pnpm validate:scripts-layout` | Scripts under `src/scripts/` layout + MCP optional dependency. Fix per **be-structure-maintainer** / scripts-layout docs. |
| 5 | `pnpm routes:catalog` + stage `docs/routes.txt` | Regenerates route catalog on every commit; re-stages generated file. |
| 6 | `pnpm routes:catalog:check` | Fails if `docs/routes.txt` drift after regeneration. |
| 6b | When `src/**` or `tooling/**` staged: `pnpm tool:project-structure-tree` + stage `docs/reference/architecture/src-structure-tree.txt` | Regenerate committed src layout tree when layout changes. |
| 6c | When 6b ran: `pnpm tool:project-structure-tree:check` | Fails if structure tree drift. |
| 7 | When OpenAPI inputs staged: `pnpm docs:check` | Staged: `*.routes.ts`, locale `openapi.json`, `tooling/openapi/**`, codegen scripts. Run `pnpm docs:all` if drift. |
| 8 | `pnpm tsdoc:check` | TSDoc coverage gate. Fix per **be-tsdoc-export-guard**; refresh budget when counts decrease. |
| 9 | `pnpm validate:test-naming` (when script exists) | Test filename suffix policy. Fix per **be-test-generator** / be-testing-conventions. |
| 10 | When `migrations/*.sql` staged: `pnpm db:migrate:lint` | Unsafe SQL. Fix per **be-db-migration-maintainer**. |
| 10b | When migrations staged: `pnpm tool:generate-dbdiagram` + stage DBML | Local DBML regen (not enforced in CI). |
| 11 | `pnpm tool:generate-project-identity:check` | Manifest ↔ constants ↔ workflows. Fix per **be-project-identity.mdc**. |
| 12 | `pnpm tool:sync-env-example` | `.env.example` vs env schema. Run `pnpm tool:sync-env-example --fix` if needed. |
| 13 | `gitleaks protect --staged` | Secrets in staged files (**required** — install gitleaks, e.g. `brew install gitleaks`; `pnpm setup:local` auto-installs it on macOS). |
| 14 | No secret/state files staged | Hard-rejects a force-added `.env.<environment>` / `.setup-credentials` / `.setup-state.*` / `setup.secrets.json` (only `.env.example` is allowed). Unstage it — `git restore --staged <file>`. |
| 15 | Conflict markers | Resolve `<<<<<<<` / `>>>>>>>` in staged files. |
| 16 | Large files (>1MB) | Unstage or use LFS. |
| 17 | When deployed-surface `src/**/*.ts` staged: `pnpm sonar:scan` | SonarQube quality gate — blocks the commit on any unresolved issue/hotspot. **Mandatory — no bypass.** Run `pnpm sonar:up && pnpm sonar:scan` locally and fix every finding (or mark a genuine false positive resolved in the SonarQube UI at <http://localhost:9000>). |

## Pre-push hook (`.husky/pre-push`)

Runs before `git push` (fast compile gate; full suite is CI):

| Step | Command            | What to do if it fails                          |
| ---- | ------------------ | ----------------------------------------------- |
| 1    | `pnpm typecheck`   | Fix TypeScript errors in `src/`.                |
| 2    | `pnpm build`       | Fix compile errors (`tsc` + `tsc-alias`).       |
| 3    | `pnpm build:check` | Fix unresolved `@/` path aliases in `dist/`.    |
| 4    | `pnpm test:unit`   | Fix failing unit tests under `src/tests/unit/`. |
| 5    | Markdown lint: `pnpm docs:lint:changed` (conditional) | runs when pushed commits include `*.md` changes |

> The SonarQube quality gate runs at **pre-commit** (the final guard step, `SonarQube quality gate`), not pre-push. It is mandatory and has no bypass.

Full PR gate: `pnpm ci:local` or wait for CI (`quality` + `test` + `api-smoke` + …).

## Commit message hook (after pre-commit)

`.husky/commit-msg` runs **`pnpm exec commitlint --edit "$1"`** against [commitlint.config.cjs](../../../commitlint.config.cjs). If your commit is rejected, rewrite the subject line to [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat: …`, `fix: …`, `chore: …`).

## Commands to Run Locally (Same as the Guard)

Before committing, the user (or AI) can run:

```bash
pnpm guard:pre-commit          # same labeled steps as the hook
pnpm guard:pre-commit:list     # print step table without running
pnpm validate                  # biome check + typecheck
pnpm validate:domain:strict    # domain structure (warnings fail; hook step 3)
pnpm routes:catalog:check      # docs/routes.txt in sync
pnpm docs:check                # OpenAPI specs in sync (when routes or openapi inputs change)
pnpm docs:lint                 # markdownlint (same config + cli2 version as the Docs lane)
pnpm docs:lint:fix             # auto-fix the markdown nits markdownlint can repair
pnpm db:migrate:lint           # when editing migrations/*.sql (CI always runs full migrations/)
pnpm tool:generate-project-identity:check  # manifest ↔ constants ↔ workflows
pnpm tool:sync-env-example     # .env.example vs env schema
pnpm sonar:up && pnpm sonar:scan  # SonarQube gate (final pre-commit guard step; when deployed-surface src/**/*.ts staged) — mandatory, no bypass
pnpm deps:audit                # optional; CI runs this (may have known moderate in dev deps)
```

If all pass, the pre-commit hook should pass. If `deps:audit` fails, see **be-dependency-security** (overrides, upgrades).

## What Was Done Previously (Reference)

These one-time or ongoing practices are part of keeping the repo commit-clean:

1. **Format + lint** — Biome on `src/` and `tooling/`; `pnpm format` / `pnpm lint` to fix; `pnpm validate` runs `biome check` + typecheck.
2. **Lint warnings** — Resolve per **be-code-smells-and-best-practices** / **be-lint-warnings-handler**.
3. **Typecheck** — `tsc --noEmit`; fix all type errors.
4. **Domain structure** — `pnpm validate:domain`; domains and sub-domains must match CLAUDE.md layout.
5. **Dependency audit** — `pnpm audit`; use `pnpm.overrides` for transitive vulns when safe; see **be-dependency-security**.
6. **Runtime/test warnings (resolved in code):**
   - **i18next** — `showSupportNotice: false` in `src/shared/middlewares/core/i18n.middleware.ts` so the Locize notice is not logged.
   - **BullMQ Redis eviction** — In `src/tests/setup.ts`, `console.warn` is filtered for the "Eviction policy is volatile-lru" message so test output is clean; production Redis should use `noeviction` where possible.

## How to Fix When the Hook Fails

1. **Read the hook output** — It will show which step failed (lint-staged, typecheck, validate:domain:strict, be-route-catalog, docs:check, **migration SQL lint**, env-example sync, gitleaks, conflict markers, or large files).
2. **Run the failing command** — e.g. `pnpm validate` or `pnpm validate:domain` or `gitleaks protect --staged`.
3. **Apply the right skill** — Use **be-code-smells-and-best-practices**, **be-route-catalog**, **be-env-schema-add**, **be-dependency-security**, or **be-domain-generator** as needed.
4. **Re-stage and commit** — After fixes, `git add` and `git commit` again.

## Dependencies

- **be-code-quality-guard** — Defines the 3-layer pipeline; pre-commit is Layer 2. When changing `.husky/pre-commit` or lint-staged, keep both skills in sync.
- **be-code-smells-and-best-practices** — Fix lint/type issues when the hook fails.
- **be-dependency-security** — For `pnpm audit` failures and overrides.

## Maintaining This Skill

- If new pre-commit steps are added to `.husky/pre-commit`, update the "What Runs on Commit" table and the fix instructions.
- If the project adds new guard checks (e.g. env-example sync), add them to the hook and document them here.
