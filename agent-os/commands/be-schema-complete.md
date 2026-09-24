---
description: Complete a Drizzle schema / table change end-to-end (the schema-change chain)
argument-hint: (no arguments — operates on your current schema changes)
allowed-tools: Bash(pnpm db:*), Bash(pnpm validate*)
---

Run the **schema-change** chain (`agent-os/skills/chains.json`) for the schema/table you added or changed, in order:

1. **be-schema-generator** — co-located Drizzle schema (snake_case columns, `pgSchema` from `pg-schemas.ts`, standard `id`/`public_id`/timestamps/soft-delete).
2. **be-sql-design-guard** — indexes, partitioning, constraint names, column types, and SQL formatting.
3. **be-db-migration-maintainer** — a matching SQL migration in `migrations/`; run `pnpm db:migrate:lint`.
4. **be-rls-tenant-isolation-guard** — tenant-owned tables `ENABLE` + `FORCE` RLS with an organization-scoped policy carrying both `USING` and `WITH CHECK`; the `app.current_organization_public_id` GUC set on every query path.

Finish green: `pnpm validate` + `pnpm db:migrate:lint`. Report the tables and migrations touched.
