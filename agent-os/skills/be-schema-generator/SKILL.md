---
name: be-schema-generator
description: Scaffolds co-located Drizzle schema files for new domains or sub-domains (snake_case columns, pgSchema from pg-schemas.ts, standard id/public_id/timestamps/soft-delete). Use when creating a domain/sub-domain that needs database tables, adding tables to an existing domain, or when a *.schema.ts file changes.
indexNote: scaffold co-located Drizzle schema files (snake_case, id/public_id/timestamps/soft-delete)
---

# Schema generator (core-be)

## Purpose

Generate co-located Drizzle schema files for new domains or sub-domains, following core-be conventions (snake_case columns, co-located in domain folder, pgSchema from `pg-schemas.ts`).

## When to Use

- When creating a new domain or sub-domain that requires database tables
- When adding new tables to an existing domain
- Triggered automatically by `be-sql-design-guard-sync.mdc` when `*.schema.ts` changes

## Prerequisites

- `src/infrastructure/database/pg-schemas.ts` exists with the domain's `pgSchema` definition
- The domain folder exists under `src/domains/<domain>/`

## Steps

1. **Determine the Postgres schema** from `pg-schemas.ts` (auth, tenancy, billing, notify, audit, upload).
2. **Create `<sub-domain>.schema.ts`** in the domain/sub-domain folder (e.g. `src/domains/tenancy/sub-domains/organization/organization.schema.ts`).
3. **Follow column conventions**:
   - Use `snake_case` for all column property names
   - Standard columns: `id` (bigserial PK), `public_id` (`varchar(28)`, unique, not null — Paddle-style `<prefix>_<21>` id), `created_at`, `updated_at` (timestamp with timezone, defaultNow)
   - Soft-delete: `deleted_at` (nullable timestamp)
   - Audit: `created_by_user_id`, `updated_by_user_id` (bigint, nullable)
   - **Strings**: use `varchar(n)` with a sensible max for bounded values (the codebase convention — e.g. `public_id` is `varchar(28)`); reserve `text` for unbounded/free-form content. Add `CHECK` constraints for *format* invariants (ISO codes, regex). See `be-sql-design-guard` section C.
   - **Case-insensitive lookups**: default to `text` + a unique/regular index on `lower(column)`. Only use `citext` when `lower()` indexes don't fit (case-insensitive `LIKE` / joins) and document why.
   - **Encoding**: rely on the default UTF-8 database encoding — do not set per-column collation unless documented.
4. **Run be-sql-design-guard** on the new/changed schema (indexes, constraints, naming).
5. **Add SQL migration** via **be-db-migration-maintainer** — hand-written `migrations/<timestamp>_*.sql` or reviewed `drizzle-kit generate` output; then `pnpm db:migrate`.
6. **Confirm `drizzle.config.ts`** includes `src/domains/**/*.schema.ts` (default).
7. **Run `pnpm typecheck`** to verify.

## Schema Template

```typescript
import {
  bigserial,
  bigint,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { <domain>Schema } from '@/infrastructure/database/pg-schemas.js';

export const <table_name> = <domain>Schema.table(
  '<table_name>',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    public_id: varchar('public_id', { length: 28 }).notNull().unique(),
    // ... domain-specific columns (varchar(n) for bounded, text for free-form) ...
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    created_by_user_id: bigint('created_by_user_id', { mode: 'number' }),
  },
  (table) => [
    // add uniqueConstraint, indexes, pgPolicy, etc. here
  ],
);
```

**RLS required:** Every new table must include `.enableRLS()` after the table definition and one or more `pgPolicy` entries in the constraints array. Invoke `be-db-migration-maintainer` for the RLS migration step.

## Naming Convention

- File: `src/domains/<domain>/<sub-domain>/<sub-domain>.schema.ts`
- Table name: plural, snake_case (e.g., `organizations`, `webhook_events`, `auth_sessions`)
- Column names: snake_case, matching actual Postgres column names exactly

## Related skills

- **be-sql-design-guard** — design-quality review after scaffolding
- **be-db-migration-maintainer** — SQL in `migrations/`
- **be-seed-maintainer** — demo/reference data when routes need it
- **be-tsdoc-export-guard** — TSDoc summary on every exported `pgTable`, type, and inferred row type in the new schema file
- **be-tsdoc-export-guard** — TSDoc on every new exported schema/type, then `pnpm tsdoc:check`

---

**Related skills:** [be-sql-design-guard](../be-sql-design-guard/SKILL.md) · [be-db-migration-maintainer](../be-db-migration-maintainer/SKILL.md) · [be-rls-tenant-isolation-guard](../be-rls-tenant-isolation-guard/SKILL.md)
