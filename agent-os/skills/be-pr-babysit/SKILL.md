---
name: be-pr-babysit
description: Keep a core-be PR merge-ready — triage review comments, resolve merge conflicts, and fix CI in a loop. Use when the user asks to babysit a PR, fix CI on a PR, or get a branch merge-ready.
indexNote: keep a PR merge-ready — triage reviews, resolve conflicts, fix CI in a loop
---

# PR babysit (core-be)

Get the current PR to **mergeable + green CI + review comments addressed**, then **merge it when green** (on the user's go-ahead).

## Preconditions

- Use `gh` for PR status, checks, and comments.
- Default branch: `main` (see `.github/workflows/pr-ci.yml`).
- Review rubric: **`docs/process/pr-review.md`** (human + agent checklist, severity legend).

## Workflow

### 1. Assess PR state

```bash
gh pr view --json title,state,mergeable,statusCheckRollup,reviews,comments
gh pr checks
```

- If the branch is behind the base branch and CI failures look unrelated, merge or rebase the latest base branch first.
- Read only unresolved review threads; skip resolved threads.

### 2. Merge conflicts

- Resolve conflicts preserving intent on both sides.
- If business intent conflicts, stop and ask the user.

### 3. CI failures (fix in scope only)

| Job / area                    | Typical fix                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Quality** | `pnpm ci:quality` locally — validate, domain, contract tests, routes catalog, migrate lint, Gitleaks/Semgrep |
| **Tests**   | `pnpm db:migrate` then `pnpm test` or failing domain test                                                    |
| **API smoke**                 | `pnpm verify:base` or `pnpm test:api-smoke` with compose up                                                  |
| **Chaos (Toxiproxy)**         | `pnpm test:chaos` — see **be-chaos-test-maintainer**                                                            |
| **Docker**                    | `node tooling/ci/check-dockerfile-sync.mjs`; image build errors                                              |
| **API Docs** (push)           | `pnpm docs:all`, `pnpm docs:check`                                                                           |

**Never** weaken CI workflows or skip checks to make red go green. If a failure needs infra or workflow changes outside the PR scope, report back.

After fixes:

```bash
pnpm validate          # lint + format:check + typecheck
pnpm validate:domain   # when domain layout touched
git push
```

Re-watch `gh pr checks` until green.

### 4. Review comments

- Apply **`docs/process/pr-review.md`** — classify feedback as Blocker / Major / Nit; fix Blockers and Majors in scope.
- Validate Bugbot and human feedback; fix real issues in touched files.
- Invoke **be-code-smells-and-best-practices** for `src/` edits.
- Run skills from **be-skill-index** when the comment implies routes, migrations, seeds, or docs drift.

### 5. Pre-merge local gate (optional)

```bash
pnpm ci:local
```

### 6. Merge when green

"Merge-ready" is not the finish line — take it to merged once the user has asked you to merge (or to "merge when green"):

- Merge only when **every required check is green** and the PR is mergeable (`mergeable_state: clean`).
- Prefer **squash** so the base branch gets one conventional commit (release-please bumps from it).
- If the branch is **behind** the base, update it first (re-runs CI), then re-check.
- For a **transient** CI failure (e.g. an image-pull timeout), re-run the failed job / re-trigger CI rather than editing code.
- CI **success is not delivered by webhooks** — re-check on a timer or self check-in. The watch is not finished until the PR is **merged or closed**.

## Related skills

- **be-ci-investigation** — single failing check root-cause summary
- **be-before-commit-guard** — pre-commit hook failures before push
- **be-split-to-prs** — if scope is too large to merge safely
