---
name: be-split-to-prs
description: Split current work into small reviewable PRs aligned with core-be domains and CI paths. Use when the user asks to split a branch, chat, or large PR.
indexNote: split a branch/PR into small reviewable, CI-path-aligned PRs
---

# Split to PRs (core-be)

Turn one large change into a few **reviewer-friendly** PRs.

## Hard rules

- Do **not** create branches, commit, push, or open PRs until the user approves the split plan.
- Never discard work. No destructive git (`reset --hard`, `clean -fdx`, force-push) without explicit approval.
- Save a recoverable snapshot before moving work (especially from dirty `main`).
- Stage only named files or hunks — no `git add .` / `git add -A`.

## 1. Inventory changes

Compare to default branch (`main`). Use `CODEOWNERS` / path ownership when present.

### Natural slices in core-be

| Slice                        | Typical paths                                                               | Notes                                         |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| **Schema + migration**       | `src/domains/**/*.schema.ts`, `migrations/*.sql`                            | Land first; run `pnpm db:migrate:lint`        |
| **Domain feature**           | `src/domains/<domain>/**`                                                   | One domain per PR when possible               |
| **Routes + OpenAPI + seeds** | `*.routes.ts` (incl. `schema: { summary, description, tags }`), `locales/*/openapi.json`, `*.seed.ts` | Keep route catalog + OpenAPI + seeds together |
| **Workers / queues**         | `**/events/**`, `**/queues/**`, `**/workers/**`, `infrastructure/queue/**`  | After schema if jobs touch new tables         |
| **Tests only**               | `__tests__/**`, `src/tests/**`                                              | Stack on feature PR or follow-up              |
| **CI / tooling**             | `.github/workflows/**`, `biome.json`, `.husky/**`                           | Isolate from product code                     |
| **Docs**                     | `docs/**/*.md`                                                              | **be-docs-maintainer** after moves               |

## 2. Propose the split

- Default: **independent PRs** off `main`.
- **Stack** only when there is a real dependency (migration → domain code → seeds).
- Show a Mermaid diagram when there are 3+ slices.
- Ask for approval before executing.

## 3. Execute

```bash
SHA=$(git stash create "pre-split")
if [ -n "$SHA" ]; then
  git update-ref "refs/backup/pre-split-$(date +%s)" "$SHA"
fi
```

For each approved slice: branch from the right base → stage planned files → commit → push → `gh pr create`.

> **Note:** this repo **disables merge commits** — `gh pr merge` must use `--squash` (e.g. `gh pr merge --squash --auto`). A 405 "Merge commits are not allowed on this repository" means a merge commit was requested; switch to squash. Merges into `main` also require all branch-protection status checks to pass first, so prefer `--auto` (or enable auto-merge) rather than waiting interactively.

After each product PR, note which **be-skill-index** skills apply (be-route-catalog, be-db-migration-maintainer, etc.).

## 4. Report back

PR titles and URLs, anything left on the original branch, and the backup ref (do not delete unless asked).
