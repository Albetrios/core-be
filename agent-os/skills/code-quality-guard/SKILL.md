---
name: code-quality-guard
description: Maintains the 3-layer code quality and security pipeline (editor Biome, Husky pre-commit hooks, CI security scanning). Use after changing Biome rules, pre-commit hooks, CI workflows, lint-staged config, or adding new security tooling.
trigger: biome.json, .husky/pre-commit, .husky/pre-push
triggerNote: Lint/format/pre-commit/pre-push + branch-name policy
indexNote: 3-layer quality/security pipeline (editor Biome, husky pre-commit, CI scanning)
---

# Code quality guard (core-be)

Maintains the layered code quality and security checking pipeline. Run this skill after any change to linting rules, pre-commit hooks, CI security steps, or related config files.

## Architecture: 3 layers

```text
Layer 1 (Editor)  -- Biome extension gives real-time lint + format while coding
Layer 2 (Pre-commit) -- Husky runs lint-staged (Biome), typecheck, Gitleaks, guards
Layer 3 (CI)      -- Full validation, Semgrep SAST, Gitleaks full-repo, tests
```

## Config files and their roles

| File                                | Layer | Purpose                                                                                                                                                                                                       |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `biome.json`                        | 1 + 2 | Biome lint + format rules and per-path overrides                                                                                                                                                              |
| `.biomeignore`                      | 1 + 2 | Paths Biome skips (e.g. migrations, lockfile)                                                                                                                                                                 |
| `.vscode/settings.json`             | 1     | Editor format on save, Biome fix on save                                                                                                                                                                      |
| `.husky/pre-commit`                 | 2     | Pre-commit hook script (static sync checks + local SonarQube quality gate)                                                                                                                                    |
| `.husky/pre-push`                   | 2     | Pre-push: typecheck, build, build:check, changed-markdown lint, generated-doc drift checks (tree/routes/organization-scope), unit tests                                                                                |
| `.husky/commit-msg`                 | 2     | Validates commit messages with commitlint (conventional commits)                                                                                                                                              |
| `commitlint.config.cjs`             | 2 + 3 | Commitlint rules (extends `@commitlint/config-conventional`); same config as CI on push to `main`                                                                                                             |
| `lint-staged.config.mjs`            | 2     | Which files get linted/formatted on commit (at repo root)                                                                                                                                                     |
| `.gitleaks.toml`                    | 2 + 3 | Gitleaks allowlist (ignored paths)                                                                                                                                                                            |
| `.semgrepignore`                    | 3     | Semgrep ignored paths in CI                                                                                                                                                                                   |
| `.github/workflows/pr-ci.yml`       | 3     | CI jobs: `lint`, `typecheck`, `static-sync`, `unit`, `security-audit`, `security-secrets`, `security-sast`, `rls-security`, `build-verify`, `contract-plus-property`, `migration-lint` |
| `.github/workflows/pr-governance.yml` | 3   | Commitlint on every push to `main`                                                                                                                                                                            |

## When to run this skill

- Adding or changing Biome rules in `biome.json`
- Modifying `.husky/pre-commit` or `.husky/pre-push` hook steps (incl. the branch-name policy)
- Adding `.husky/commit-msg` or changing commitlint config
- Changing `lint-staged` config in `lint-staged.config.mjs`
- Adding or updating CI security jobs
- Adding new code quality tooling

## Layer 1: Editor (real-time while coding)

### Biome (`@biomejs/biome` devDependency)

| Area        | Examples in `biome.json`                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| Correctness | `noUnusedVariables`, `noExplicitAny`                                                     |
| Style       | `useConst`, `useImportType`, `noParameterAssign`                                       |
| Complexity  | `noExcessiveCognitiveComplexity`, `noExcessiveLinesPerFunction`                        |
| Security    | `noGlobalEval`, `noImpliedEval` (nursery)                                                |

Architectural import restrictions previously in ESLint (`no-restricted-imports`, `no-restricted-syntax`) are enforced by global tests (e.g. `external-sdk-coverage.global.test.ts`, worker RLS security tests) and code review.

### VS Code settings (`.vscode/settings.json`)

Must include:

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.codeActionsOnSave": { "source.fixAll.biome": "explicit" }
}
```

Extension: `biomejs.biome` (see `.vscode/extensions.json`).

## Layer 2: Pre-commit (`.husky/pre-commit` → `pnpm guard:pre-commit`)

The hook runs **`pnpm guard:pre-commit`** — labeled sequential checks. If any fail, the commit is rejected. See **before-commit-guard** when the user reports a failed commit. List steps: **`pnpm guard:pre-commit:list`**.

Pre-commit mirrors a **subset** of the static checks in [`.github/workflows/pr-ci.yml`](../../../.github/workflows/pr-ci.yml). CI additionally runs `deps:audit`, full-repo `pnpm validate`, `validate:domain:coverage`, always-on `db:migrate:lint`, `test:contract`, Semgrep, and full-repo Gitleaks.

| Step | Command | What it catches |
| ---- | ------- | --------------- |
| 1 | `pnpm lint-staged` | Biome + markdownlint on staged files |
| 2 | `pnpm typecheck` | TypeScript type errors |
| 3 | `pnpm validate:domain:strict` | Domain structure (warnings fail) |
| 3b | `pnpm test:global` | Architecture policy tests (conditional: only when `src/domains/**/*.ts` staged) |
| 4 | `pnpm validate:scripts-layout` | Scripts layout + MCP optional dep |
| 5–6 | `pnpm routes:catalog` + `:check` | Route catalog drift |
| 6b–6c | `tool:project-structure-tree` (+ `:check` when wired) | Src layout tree drift when `src/**` or `tooling/**` staged |
| 7 | `pnpm docs:check` (conditional) | OpenAPI / Postman drift |
| 8 | `pnpm tsdoc:check` | TSDoc coverage budget |
| 9 | `pnpm validate:test-naming` (when wired) | Test filename suffixes |
| 10–10b | `db:migrate:lint` + DBML regen (conditional) | Migration safety |
| 11 | `pnpm tool:generate-project-identity:check` | Manifest / workflow drift |
| 12 | `pnpm tool:sync-env-example` | `.env.example` drift |
| 13 | `gitleaks protect --staged` | Secrets in staged files (**required** locally) |
| 14–15 | Conflict markers + large files | Accidental merges / >1MB staged files |
| 16 | `pnpm sonar:scan` (conditional) | SonarQube quality gate — blocks the commit on any unresolved issue/hotspot; runs when deployed-surface `src/**/*.ts` is staged. **Mandatory — no bypass.** |

### Pre-push (`.husky/pre-push`)

| Step | Command            | What it catches                    |
| ---- | ------------------ | ---------------------------------- |
| 0    | branch-name policy | Branch names outside the allowed prefixes (`main`/`claude/*` + `<type>/…`) — runs first, fail-fast; bypass: `SKIP_BRANCH_CHECK=1 git push` (see `agent-os/rules/git-branch-naming.mdc`) |
| 1    | `pnpm typecheck`   | Type errors before push            |
| 2    | `pnpm build`       | Compile failures                   |
| 3    | `pnpm build:check` | Unresolved `@/` aliases in `dist/` |
| 4    | `pnpm docs:lint:changed` | Markdown lint (changed files only) — conditional on pushed markdown file changes |
| 5    | `pnpm tool:project-structure-tree:check` + `pnpm routes:catalog:check` + `pnpm validate:route-organization-scope` | Generated-doc drift (`src-structure-tree.txt`, `docs/routes.txt`, organization-scope catalog) left behind by `--no-verify` commits that skipped pre-commit steps 5/6b/6c — conditional on pushed `src/`/`tooling/` changes; check-only, never mutates the tree |
| 6    | `pnpm test:unit`   | Failing shared unit tests — conditional on pushed unit-relevant changes |

> The SonarQube quality gate runs at **pre-commit** (`pnpm guard:pre-commit`, the final guard step), not pre-push. It is mandatory and has no bypass.

### Commit message hook (`.husky/commit-msg`)

| Step | Command                            | What it catches                                                                                              |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | `pnpm exec commitlint --edit "$1"` | Non–conventional-commit messages (same rules as push workflow `.github/workflows/pr-governance.yml` on `main`) |

### lint-staged config (`lint-staged.config.mjs`)

```javascript
// lint-staged.config.mjs (at repo root)
export default {
  '*.{ts,tsx}': ['biome check --write --no-errors-on-unmatched'],
  '*.{json,md}': ['biome format --write --no-errors-on-unmatched'],
  '*.md': ['markdownlint-cli2 --fix'],
  // project-identity.constants.ts excluded from Biome (codegen output)
  // CHANGELOG.md and PR templates excluded from markdownlint
};
```

## Layer 3: CI (`.github/workflows/pr-ci.yml`)

### `lint` / `typecheck` / `static-sync` / `security-*` jobs — validate + static security

- **Dependency audit**: `pnpm audit` runs after install; the pipeline **fails on any vulnerability** (no audit-level filter). Keep dependencies and `pnpm.overrides` so that `pnpm audit` passes. See **dependency-security** skill when changing `package.json` or `pnpm-lock.yaml`.
- **Migration safety lint**: `pnpm db:migrate:lint` scans `migrations/*.sql` for zero-downtime-unsafe patterns (same command as pre-commit when SQL migrations are staged).
- **Gitleaks + Semgrep** run in the same job after validate steps (one checkout; no duplicate `security-tests` Vitest job — security tests are in `test:coverage`).

| Step | Tool                          | What it catches                                         |
| ---- | ----------------------------- | ------------------------------------------------------- |
| 1    | `gitleaks` CLI (binary, v8)   | Full-repo secret scan (AWS keys, tokens, passwords)     |
| 2    | `semgrep scan --config auto`  | SAST: SQL injection, XSS, insecure crypto, OWASP Top 10 |

### `unit` job (runs after static checks pass)

- Postgres + Redis service containers → `pnpm db:migrate` → `pnpm test:coverage` (includes security, performance, e2e, integration, unit).

### `contract-plus-property` job

- Postgres + Redis service containers → `pnpm db:migrate` → `pnpm db:seed:full` → background `pnpm tsx src/server.ts` → wait for `/readyz` → `pnpm test:api-smoke`. Catches route/DI wiring regressions against real HTTP.

### Supporting ignore files

- `.gitleaks.toml` -- paths Gitleaks skips (node_modules, .env.example, lock files, generated docs)
- `.semgrepignore` -- paths Semgrep skips (node_modules, dist, migrations, lock files)

## Convenience scripts (`package.json`)

| Script                  | What it does                                             |
| ----------------------- | -------------------------------------------------------- |
| `pnpm security:secrets` | Manual full-repo Gitleaks scan (requires `gitleaks` CLI) |
| `pnpm security:sast`    | Manual Semgrep scan (requires `semgrep` CLI)             |
| `pnpm validate`         | biome check + typecheck (same as CI)                     |
| `pnpm lint`             | `biome check src tooling`                                |
| `pnpm format`           | `biome format --write src tooling`                       |

## Checklist (run after changes)

1. **Biome config valid?** -- run `pnpm lint` and confirm no config errors
2. **Pre-commit hook executable?** -- `.husky/pre-commit` must have execute permission
3. **lint-staged patterns correct?** -- ensure patterns match actual file locations
4. **CI workflow valid YAML?** -- check `.github/workflows/pr-ci.yml` syntax
5. **Ignore files up to date?** -- `.gitleaks.toml` and `.semgrepignore` include new generated/vendor paths
6. **VS Code settings preserved?** -- Biome default formatter + `source.fixAll.biome` on save
7. **Dependencies installed?** -- `@biomejs/biome` in devDependencies; no `eslint` / `prettier` packages

## Adding new Biome rules

1. Edit `biome.json` (use `overrides` for tests, scripts, tooling paths)
2. Run `pnpm lint` to verify no false positives on existing code
3. Update this skill's Layer 1 tables above

When adding a new pre-commit check:

1. Add the check to `.husky/pre-commit` (sequential, fail-fast)
2. Update this skill's Layer 2 table above
3. Test with a manual commit
