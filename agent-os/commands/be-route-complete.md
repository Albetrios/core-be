---
description: Complete an API route change end-to-end (the route-change chain)
argument-hint: (no arguments — operates on your current route changes)
allowed-tools: Bash(pnpm routes*), Bash(pnpm docs*), Bash(pnpm validate*), Bash(pnpm test*)
---

Run the **route-change** chain (`agent-os/skills/chains.json`) for the route(s) you added or changed, in order:

1. **be-api-contract-guard** — snake_case + semantic route params (registered in `PARAM_NAME_TO_ENTITY`), prefixed public ids, the method→status policy, and the header matrix.
2. **be-route-schema-doc-guard** — every route registration carries a `schema` block with `summary`, `description`, and `tags`.
3. **be-route-catalog** — `pnpm routes:catalog`, then verify with `pnpm routes:catalog:check`.
4. **be-seed-maintainer** — keep seed data aligned with the routes.
5. If tags or operation copy changed: **be-openapi-multilingual** (`pnpm docs:generate:multilang`).
6. **be-test-generator** — add or adjust e2e coverage for the route.

Finish green: `pnpm validate` + `pnpm routes:catalog:check`. Report which routes changed and which artifacts regenerated.
