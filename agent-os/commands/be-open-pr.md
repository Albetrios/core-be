---
description: Push the current branch and open a pull request to main
argument-hint: [optional PR title]
allowed-tools: Bash(git push*), Bash(git status), Bash(git diff*), Bash(git log*)
---

Open a PR for the current branch — this command is the explicit opt-in that satisfies the "never open a PR unless asked" rule and the `no-unrequested-pr` guard:

1. Confirm the branch and changeset: `git status`, `git log --oneline origin/main..HEAD`.
2. Push: `git push -u origin <branch>` (retry with backoff on transient network errors).
3. Open the PR to **main** via the GitHub MCP (`create_pull_request`): a conventional title (or **$ARGUMENTS** if given) and a body summarizing what changed, why, and how it was verified. End the body with the Claude Code footer.
4. Report the PR URL.

Do not force-push, and do not target any base branch other than `main` without explicit confirmation.
