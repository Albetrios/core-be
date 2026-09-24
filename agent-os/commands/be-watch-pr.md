---
description: Watch a PR — triage CI failures and review comments until it is green
argument-hint: <pr-number>
allowed-tools: Bash(git*), Bash(pnpm*)
---

Watch PR **$ARGUMENTS** and keep it merge-ready:

1. Subscribe to PR activity (`subscribe_pr_activity`) so CI, reviews, and comments wake this session — do **not** poll with `sleep`.
2. On a CI failure: diagnose (**be-ci-investigator**), push a fix to the branch, update the status checklist.
3. On a review comment: if the fix is unambiguous, apply + push; if not, ask via `AskUserQuestion`.
4. On a merge conflict or new push: rebase or resolve, then re-verify.

Keep going until the PR is MERGED or CLOSED, or the user says stop (then `unsubscribe_pr_activity`). Reply only when something needs the user; otherwise let the PR diff be the record.
