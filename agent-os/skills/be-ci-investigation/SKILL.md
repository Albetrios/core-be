---
name: be-ci-investigation
description: Investigate a single failing PR CI check in core-be and return a short root-cause summary with a fix plan. Use when the user asks why CI failed or to diagnose a specific GitHub Actions job.
indexNote: diagnose one failing PR CI check → root cause + fix plan
---

# CI investigator (core-be)

Produce a **short root-cause summary** for **one** failing check (not full PR babysit — see **be-pr-babysit** for the full loop).

## Steps

1. Identify the failing job:

   ```bash
   gh pr checks
   gh run view <run-id> --log-failed
   ```

2. Map the job to local commands:

   | CI job name | Workflow | Local reproduction |
   | --- | --- | --- |
   | PR CI (lint, security, …) | `pr-ci.yml` | `pnpm ci:quality` (local aggregate; CI splits jobs) |
   | Tests | `reusable-vitest-postgres-redis.yml` | `pnpm compose:up` → `pnpm db:migrate` → `pnpm test` |
   | API smoke (local only) | CD post-deploy or local verify | `pnpm verify:base` or `pnpm test:api-smoke` |
   | Chaos (Toxiproxy) | `reusable-chaos-toxiproxy.yml` | `pnpm chaos:up` → `pnpm chaos:provision` → `pnpm test:chaos` |
   | Docker | `reusable-docker-build-trivy.yml` | `node tooling/ci/check-dockerfile-sync.mjs` + docker build |
   | API Docs (post-merge publish) | `reusable-openapi-postman-publish.yml` | `pnpm docs:all` / `pnpm docs:check` |
   | API Docs (PR-time check) | `pr-docs-lane.yml` | `pnpm docs:check` |

3. Reproduce the **first** failing step locally when possible.
4. Classify the failure:
   - **Code** — fix in `src/`, tests, or migrations
   - **Drift** — run generator once (`pnpm routes:catalog`, `pnpm tool:sync-env-example --fix`)
   - **Flake** — note evidence; suggest re-run
   - **Out of scope** — needs base-branch merge or infra change; do not hack CI

## Output format

```markdown
## CI failure: <job name>

**Root cause:** …

**Evidence:** (log line or local command output)

**Fix:** …

**Commands:** `pnpm …`
```

## Related skills

- **be-pr-babysit** — fix and push until green
- **be-before-commit-guard** — local pre-commit mirror of quality checks
- **be-contract-test-maintainer** / **be-chaos-test-maintainer** — specialized test slices
