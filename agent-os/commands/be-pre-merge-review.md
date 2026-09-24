---
description: Run the read-only pre-merge review pipeline and aggregate one report
argument-hint: (no arguments — reviews the current diff)
allowed-tools: Bash(git diff*), Bash(pnpm*)
---

Read `REVIEW.md` (repo root) first — it defines the severity ladder, the repo-specific checks in priority order, and the skip paths every reviewer in this pipeline must honor.

Run the **pre-merge review** pipeline as read-only agents over the current diff, then aggregate one report:

1. **be-sql-design-reviewer** — Drizzle schema design (if schemas changed).
2. **be-rls-tenant-isolation-guard** (review) — RLS / tenant isolation on touched tables and workers.
3. **be-idempotency-guard** (review) — the idempotency contract on touched money/state routes.
4. **be-verifier** — run `pnpm validate` + tests; confirm the change actually works.

Each finding names the procedural skill that fixes it (agent finds, skill fixes). Produce a single prioritized report — blocking gaps first, then optional improvements. This is review-only: do not edit files.
