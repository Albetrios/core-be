---
description: Merge a PR once CI is green and approvals are in
argument-hint: <pr-number>
allowed-tools: Bash(git*)
---

Merge PR **$ARGUMENTS** safely:

1. Confirm CI is green (all required checks pass) and the required approvals are present.
2. Confirm there are no merge conflicts and the branch is up to date with `main`.
3. Merge via the GitHub MCP (`merge_pull_request`) using the repo's merge strategy (squash unless told otherwise); keep the conventional title.
4. Report the merge result.

Do not merge if any required check is failing or approvals are missing — report what is blocking instead.
