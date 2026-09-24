---
description: Re-sync route docs and catalog after route changes
argument-hint: (no arguments)
allowed-tools: Bash(pnpm routes*), Bash(pnpm docs*)
---

After adding, removing, or changing any route:

1. Ensure every route registration carries a `schema` block with `summary`,
   `description`, and `tags` (**be-route-schema-doc-guard**).
2. Regenerate the catalog: `pnpm routes:catalog`, then verify with
   `pnpm routes:catalog:check`.
3. If tags or operation copy changed, run **be-openapi-multilingual**
   (`pnpm docs:generate:multilang`).
4. Run **be-seed-maintainer** so seed data stays aligned with the routes.

Report which routes changed and which artifacts were regenerated.
