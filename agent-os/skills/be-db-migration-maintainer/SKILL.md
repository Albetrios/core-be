---
name: be-db-migration-maintainer
description: Keeps SQL migrations in migrations/ aligned with Drizzle schema changes. Use when adding or changing *.schema.ts or creating/editing migrations/*.sql. Not for Supabase Edge Function porting (see be-supabase-porting).
trigger: migrations/*.sql
triggerNote: Migration files (schema changes go via the schema-change chain)
indexNote: keep migrations/*.sql aligned with Drizzle schema changes
---

# DB migration maintainer (core-be)

## Purpose

Postgres schema changes require **both** a co-located Drizzle `*.schema.ts` and a **versioned SQL file** under `migrations/`. This skill owns the SQL migration workflow. For Supabase → Node porting, use **be-supabase-porting** instead.

## When to use

- Created or modified `src/domains/**/*.schema.ts`
- Added or edited `migrations/*.sql`
- User asks to add a table/column/index in production

## Prerequisites

- Drizzle schema uses `pgSchema` from `src/infrastructure/database/pg-schemas.ts`
- `drizzle.config.ts` glob: `src/domains/**/*.schema.ts`
- Migrations applied via `pnpm db:migrate` (`src/infrastructure/database/migration/migrate.ts`)
- **Postgres 17+ is required project-wide.** Local Docker (`postgres:17.10-alpine`), every CI service container, testcontainers, and managed providers (Neon `pgVersion: 17`) are all pinned to PG17. `pnpm db:migrate` runs a `SELECT current_setting('server_version_num')` preflight and refuses to apply migrations against anything older. Do not point `DATABASE_MIGRATION_URL` at a 15/16 cluster.

## Hard rules

These are enforced by `pnpm db:migrate:lint` and cannot be overridden by the `-- migration-safety: allow ...` header:

- **No `SET` / `RESET` of the `row_security` GUC** (`disable_row_security_guc`). RLS bypass for trusted lookups must go through `SECURITY DEFINER` + `GRANT EXECUTE`; toggling the session GUC is unnecessary (ownership already bypasses RLS for `SECURITY DEFINER` functions) and inconsistent with the existing `billing.resolve_organization_public_id_for_stripe_subscription` / `tenancy.resolve_member_invitation_lookup_by_public_id` pattern.

## Workflow

1. **Update Drizzle schema** in the domain/sub-domain folder (`<resource>.schema.ts`).
2. **Run be-sql-design-guard** on the schema (indexes, constraints, naming).
3. **Author SQL migration** in `migrations/`:
   - **Generate with `pnpm db:migrate:new <snake_case_slug>`** — this creates `migrations/YYYYMMDDHHMMSS_<slug>.sql` with the proper header. The 14-digit prefix is real UTC wall-clock time (e.g. `20260528054321`) so concurrent developers on different branches naturally land on distinct prefixes and avoid the trivial merge conflict that happens with `_000001 / _000002` counter-based suffixes.
   - For just the prefix (no file): `pnpm db:migrate:next-prefix [description]`.
   - Both helpers always use the real UTC wall clock — there is no counter/increment fallback. Monotonic ordering is enforced separately by `pnpm db:migrate:lint`.
   - Filename pattern: `YYYYMMDDHHMMSS_short_description.sql` — **14-digit lexicographic ordering key** + snake_case suffix.
   - Prefix must be **strictly greater** than every existing up-migration prefix (`pnpm db:migrate:lint` enforces monotonic order). Do not use `date -u +%Y%m%d000001` — that re-introduces the counter pattern. Use the helper.
   - **Do not rename** applied migration files — `public.schema_migrations` keys on `filename`; renaming a file makes the runner think it's a brand-new migration and re-apply it in environments that already had it.
   - Historical mixes of `202502*` / `202605*` and `_000001` / `_000002` suffixes are intentional; ordering is by prefix, not calendar "when written." Leave them alone.
   - One logical change per file when possible (add table, add column, add index).
   - Use schema-qualified names: `tenancy.organizations`, `auth.users`, etc.
   - Include `IF NOT EXISTS` / safe patterns where re-run risk exists; migrations are tracked in `public.schema_migrations` and run once.
   - **Index DDL on high-write tables**: use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` so writes are not blocked during the build. This cannot run inside a transaction, so mark the file with `-- migration-transaction: none reason="..."` in the first 20 lines (the runner then executes statements outside a transaction and post-checks for `INVALID` indexes) and separate **every** statement with `--> statement-breakpoint` so each runs as its own command. `pnpm db:migrate:lint` fails (non-overridable) if `CONCURRENTLY` appears without the header (`concurrent_index_requires_non_transactional`) or if a non-transactional breakpoint segment holds more than one statement (`non_transactional_statements_need_breakpoints`). Keep non-transactional files idempotent and index-only — there is no rollback if a statement fails mid-file. See **[migrations.md → Non-transactional migrations](../../../docs/reference/data/migrations.md)**.
   - **Append-heavy tables** (`audit.logs`, `notify.notifications`): plain (non-partitioned) tables whose growth is bounded by row-level retention workers (`audit-retention`, `notification-retention`) batch-deleting old rows. Index them like any other high-write table — prefer `CREATE INDEX CONCURRENTLY` in a `migration-transaction: none` file.
4. **RLS**: if the table is tenant-scoped, add or update RLS policies in the same or follow-up migration (see existing `migrations/*_enable_rls.sql` patterns).
5. **`pnpm db:migrate:lint`** (required in CI): filename/timestamp ordering (`migration_filename_format`, `migration_timestamp_not_monotonic`) plus unsafe SQL patterns (`NOT NULL` without default when adding columns, `RENAME`, `DROP TABLE`/column destructive moves, locking `CREATE INDEX` without `CONCURRENTLY`, FK/CHECK additions without `NOT VALID`, missing `IF NOT EXISTS` on `CREATE TABLE` / `CREATE INDEX` / `CREATE SCHEMA`). Run after editing SQL migrations.
   - **Overrides** — only in the first 20 lines of a file:
     `-- migration-safety: allow <rule_id> reason="short justification"`
     Known `rule_id` values live in `migrationSafetyRuleIds` in [`src/scripts/validators/migration/lint-migrations.ts`](../../../src/scripts/validators/migration/lint-migrations.ts).
6. **Verify locally** — always against the **local Docker** stack (Postgres 17), never a remote Neon dev branch. The compose Postgres is the only local environment with the `core_be_app` role wired up so RLS security tests can `SET ROLE core_be_app` and exercise policies exactly the way CI does:

   ```bash
   pnpm compose:up && pnpm compose:wait
   pnpm db:migrate:lint
   pnpm db:migrate
   pnpm typecheck
   ```

   When the migration adds, removes, or rewrites an **RLS policy** or a **`SECURITY DEFINER` function**, also run the security RLS shard:

   ```bash
   pnpm vitest run --project security src/tests/security/rls/
   ```

   Remote Neon dev fails these with `42501 permission denied to set role "core_be_app"` and silently masks RLS bugs — always run against Docker.

7. **Seeds**: if new tables need reference/demo data, invoke **be-seed-maintainer**.
8. **DBML diagram** (`docs/database/core-be.dbml`): regenerated automatically by the local `.husky/pre-commit` hook whenever `migrations/*.sql` is staged (`pnpm tool:generate-dbdiagram` → `git add`). The diagram captures columns, primary keys, foreign keys (with `ON DELETE` actions), unique constraints, and RLS rules. It is **local only** — no CI check enforces it. Run `pnpm tool:generate-dbdiagram` manually if you want to preview the output before committing.

## Drizzle Kit (optional, drafting only — NOT the source of truth)

- The migration **source of truth** is the hand-written, timestamp-named `migrations/*.sql` set applied by `pnpm db:migrate` and tracked in `public.schema_migrations`. Drizzle Kit's snapshot/journal are **not** involved.
- `drizzle.config.ts` writes to `./drizzle/` (gitignored scratch), **not** `migrations/`. So `pnpm db:generate` drafts a full SQL diff + `meta/` snapshot there; copy the useful statements into a `pnpm db:migrate:new <slug>` file, **review every statement**, then delete or ignore the scratch output. Never apply from `./drizzle/`.
- Do **not** commit a `migrations/meta/` folder or any `*_snapshot.json` / `_journal.json` — they are Drizzle's sequential bookkeeping (`0000`, `0001`, …), which collides across parallel branches; our timestamp prefixes exist precisely to avoid that.
- `pnpm db:push` / `pnpm db:studio` are local-only convenience (push bypasses the migration ledger — never use against shared/hosted databases).
- Hand-written migrations are preferred when RLS, data backfills, or partial deploys need explicit control.

## Naming and layout

| Artifact         | Location                                                   |
| ---------------- | ---------------------------------------------------------- |
| Drizzle schema   | `src/domains/<domain>/<sub-domain>/<sub-domain>.schema.ts` |
| SQL migration    | `migrations/<timestamp>_<snake_case>.sql`                  |
| Migration runner | `src/infrastructure/database/migration/migrate.ts`         |

## Checklist

- [ ] Schema and SQL migration both updated
- [ ] Migration filename sorts after existing files
- [ ] Foreign keys reference correct schema.table
- [ ] Indexes named consistently (`idx_<table>_<columns>`)
- [ ] No `SET` / `RESET row_security` anywhere in the migration (use `SECURITY DEFINER` + `GRANT EXECUTE`)
- [ ] If the migration touches RLS policies or `SECURITY DEFINER`, security RLS shard run against local Docker Postgres 17
- [ ] `pnpm db:migrate` succeeds on a clean local Docker DB after prior migrations
- [ ] `pnpm db:migrate:lint` passes
- [ ] **be-seed-maintainer** if routes/seeds need new data

## Anti-patterns

- Changing only `*.schema.ts` without a migration (production drift)
- Creating an index only in a migration without declaring it in `*.schema.ts` (schema drift — the index-hygiene gate's parity check fails on it)
- Putting Drizzle schemas under `src/infrastructure/database/schemas/` (use domain co-location)
- Confusing this skill with **be-supabase-porting** (Edge Functions → Fastify)
- `SET row_security = off` / `RESET row_security` inside any migration (use `SECURITY DEFINER` + `GRANT EXECUTE` instead)
- Verifying RLS-touching migrations against remote Neon dev (must use local Docker Postgres 17, which is the only env that grants `core_be_app` and matches CI)

---

**Related skills:** [be-schema-generator](../be-schema-generator/SKILL.md) · [be-sql-design-guard](../be-sql-design-guard/SKILL.md) · [be-rls-tenant-isolation-guard](../be-rls-tenant-isolation-guard/SKILL.md)
