# Trunk-based workflow

**Single-trunk model.** `main` is the only long-lived branch. Every change lands on `main` through a
squash-merged pull request. Incomplete work hides behind feature flags, not long-lived branches.

> For CI/CD and deployment see
> [cicd-and-deployment.md](../deployment/ci-cd/cicd-and-deployment.md).

```mermaid
flowchart TB
  subgraph work [Working branches]
    feature[feat/...]
    fix[fix/...]
  end
  subgraph trunk [Trunk]
    main[main]
  end
  releasepr["Release PR (chore: release X.Y.Z)"]
  feature -->|squash-merge| main
  fix -->|squash-merge| main
  main -->|release-please refreshes| releasepr
  releasepr -->|merge = ship ★| main
```

## Branches

| Branch          | Purpose                                                                                                     | Lifetime                      |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `main`          | The trunk. Always releasable. Protected (squash-only, required checks).                                     | permanent                     |
| `<type>/<slug>` | Working branch for one change (`feat`/`fix`/`chore`/`refactor`/`docs`/`test`/`ci`/`build`/`perf`/`hotfix`). | short-lived, deleted on merge |
| `claude/*`      | Fallback for AI web sessions — the platform-assigned name. Rename to `<type>/<slug>` before the first push. | short-lived                   |

Enforced by [`.husky/pre-push`](../../.husky/pre-push) and the [`be-git-branch-naming`](../../agent-os/rules/be-git-branch-naming.mdc) rule.

Name the branch after the change: `<type>` is its conventional-commit type, `<slug>` is 2–5 kebab-case words (≤ 40 chars) matching the commit subject and PR title — `docs/american-spelling-organization`, `feat/billing-invoice-route`, `fix/webhook-event-rls-scope`. AI web sessions boot on a platform-generated `claude/<slug>` that carries no meaning; rename it with `git branch -m <type>/<slug>` **before** the first push, because the cloud git proxy allows branch creates but refuses deletes.

## The loop

1. Branch off `main`: `git switch -c feat/my-change`.
2. Commit; open a PR to **`main`** (`/be-open-pr` or `/be-ship`).
3. **PR CI is the authoritative gate**: lint, typecheck, unit, the full DB-backed matrix
   (e2e/integration/rls/performance), security, and contract lanes all roll up into the single
   **`Quality gate`** required check (with **`Checks`** from pr-governance). It must be green — and the
   branch up to date with `main` (strict checks) — before merge.
4. **Squash-merge** into `main` (0 approvals required; the squash commit = the PR title + body). The
   branch auto-deletes.
5. Post-merge CI on `main` runs the **adaptive lane**: a single-PR push takes the FAST lane (build →
   release-please → deploy development, no re-test — the PR already proved the tree); a batched push
   (≥2 commits, e.g. a merge queue) takes the FULL lane and re-runs the matrix.

## Releasing

`release-please` keeps exactly one **`chore: release X.Y.Z` Release PR** open on `main`, updated on
every merge. **Merging that Release PR is the ship button** — it tags `vX.Y.Z` + a GitHub Release, which
fires [`release-deploy.yml`](../../.github/workflows/release-deploy.yml) to deploy production (behind the
environment reviewer approval). See [release-versioning.md](release-versioning.md).

## Hotfixes

A hotfix is just a `fix:` PR merged and released immediately by merging the Release PR — **fix-forward
on `main`**. There is no protected `release/*` branch; keep `main` releasable (flag unshippable work)
so a hotfix is always safe to cut from trunk. See
[hotfix-release.md](../deployment/runbooks/hotfix-release.md).
