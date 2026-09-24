---
name: be-sql-design-guard
description: Enforces the PostgreSQL senior-level design style guide whenever Drizzle schema files are created or modified — auto-suggesting indexes, partitioning strategies, constraint names, and formatting all SQL objects according to production-ready conventions.
indexNote: Postgres design review — indexes, partitioning, constraint names, formatting
---

# SQL design guard (core-be)

Enforces production-ready PostgreSQL design conventions on every Drizzle schema change. Run the checklist top-to-bottom whenever a `*.schema.ts` file is created or modified under `src/domains/`.

## When to run

Run this skill **every time** you:

- Create a new Drizzle schema file (`*.schema.ts`)
- Add or modify columns in an existing schema
- Add or modify indexes, constraints, or relations in a schema
- Create a migration that introduces new tables or alters existing ones

## Checklist

### A. Table naming

1. **Plural, snake_case**: `organizations`, `webhook_events`, `audit_logs`
2. **Schema-prefixed**: always use the domain `pgSchema` (`authSchema`, `tenancySchema`, `billingSchema`, `notifySchema`, `auditSchema`) from `@/infrastructure/database/pg-schemas.js`
3. **No reserved keywords**: if a name collides with a PostgreSQL reserved word, add a descriptive suffix (e.g. `user_accounts` instead of `users` if `users` conflicts in your context)
4. **Consistency**: once a naming pattern is chosen for a domain, all tables in that domain follow it

### B. Column naming

1. **snake_case** — every column name must be lowercase with underscores, matching the actual Postgres column name exactly
2. **Primary key**: `id` (bigserial, mode: 'number')
3. **Public identifier**: `public_id` (`varchar(28)`, unique, not null) — Paddle-style `<prefix>_<21-char nanoid>` external id; 28 chars fits the longest prefix
4. **Foreign keys**: `<referenced_table_singular>_id` — e.g. `organization_id`, `subscription_id`, `user_id`
5. **Booleans**: always prefix with `is_` or `has_` — e.g. `is_active`, `has_paid`, `is_verified`
6. **Timestamps** (required on every table):
   - `created_at` — `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`
   - `updated_at` — `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()`
7. **Soft delete**: `deleted_at` — `timestamp('deleted_at', { withTimezone: true })` (nullable)
8. **Audit columns** (where applicable): `created_by_user_id`, `updated_by_user_id` (bigint, nullable)
9. **No vague names**: reject `data`, `info`, `value`, `type`, `status` without a qualifying prefix — prefer `payment_status`, `notification_type`, `metadata`
10. **Standalone `status` is acceptable** only when the table represents a single concept (e.g. `subscriptions.status`), but add a CHECK constraint (see section C)

### C. Data type rules

| Concept                  | Correct type                                             | Avoid                                                |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------- |
| Internal IDs             | `bigserial` / `bigint`                                   | `integer`, `uuid` (unless externally required)       |
| Public IDs               | `varchar(28)` (Paddle-style `<prefix>_<21>` id)  | `uuid` as the primary external identifier            |
| Money / amounts          | `decimal(10, 2)` or `decimal(12, 2)`                     | `float`, `real`, `double precision`                  |
| Timestamps               | `timestamp with time zone` (always `withTimezone: true`) | `timestamp` without timezone                         |
| Short strings            | `varchar(n)` with a sensible max (codebase convention)   | over-tight limits you'll grow into often             |
| Long / free-form text    | `text`                                                   | `varchar(n)` for genuinely unbounded text            |
| Case-insensitive lookups | `text` + `lower()` expression index                      | `citext` (use only when lowercase index doesn't fit) |
| Flexible / evolving data | `jsonb`                                                  | `json` (not indexable)                               |
| Booleans                 | `boolean` with explicit default                          | nullable booleans (ambiguous three-state)            |
| Controlled values        | `text` + CHECK constraint                                | `CREATE TYPE ... AS ENUM` (locks tables on ALTER)    |

**Bounded `varchar(n)` is the convention here**: in PostgreSQL `text` and `varchar` store identically (TOAST-aware varlena) and perform the same, so `varchar(n)` is purely a built-in length guard — not a performance choice. This codebase uses `varchar(n)` for bounded columns (ids, codes, names — e.g. `public_id` is `varchar(28)`) and reserves `text` for genuinely unbounded / free-form content. Pick a generous max so you rarely need to grow it; widening one later is a quick `ALTER TABLE ... ALTER COLUMN ... TYPE varchar(n)`. Use a `CHECK` only for *format* invariants (regex, ISO codes), not for length already enforced by `varchar(n)`.

```sql
public_id  VARCHAR(28) NOT NULL,
slug       VARCHAR(100) NOT NULL,
currency   VARCHAR(3)  NOT NULL,
CONSTRAINT chk_billing_plans_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
```

In Drizzle, use `varchar(name, { length: n })` for bounded columns:

```typescript
public_id: varchar('public_id', { length: 28 }).notNull(),
slug: varchar('slug', { length: 100 }).notNull(),
```

**No ENUMs**: never use `CREATE TYPE ... AS ENUM`. Instead:

- **Option 1 — CHECK constraint**: `text` with a CHECK constraint listing allowed values. Adding a value requires only `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ...` — no table lock.

  ```sql
  ALTER TABLE billing.subscriptions ADD CONSTRAINT chk_subscriptions_status
    CHECK (status IN ('ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'TRIALING'));
  ```

- **Option 2 — Lookup table**: for values that change often or have metadata (label, description, sort order), create a reference table.

  ```sql
  CREATE TABLE billing.subscription_statuses (
    id BIGSERIAL PRIMARY KEY,
    status_name TEXT UNIQUE NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_subscription_statuses_status_name_length CHECK (char_length(status_name) BETWEEN 1 AND 50)
  );
  ```

**Case-insensitive lookups — prefer `lower()` index over `citext`:**

For emails, slugs, usernames, etc., default to plain `text` with a functional unique/regular index on `lower(column)`. This keeps the column type predictable, plays nicely with collation, and avoids the `citext` extension dependency.

```sql
-- Default: text + lower() index
CREATE UNIQUE INDEX idx_users_email_lower
  ON auth.users (lower(email))
  WHERE deleted_at IS NULL;

-- Application queries must call lower(email) to hit the index:
--   SELECT ... WHERE lower(email) = lower($1)
```

Only reach for `citext` when:

1. You need transparent case-insensitivity across **many** queries and call sites where forcing `lower()` everywhere is impractical.
2. You need case-insensitive **`LIKE` / pattern matching** (the `lower()` index does not cover `LIKE` patterns).
3. You need case-insensitive joins or foreign-key comparisons.

If `citext` is justified, document the reason in the schema comment and enable it in a migration:

```sql
CREATE EXTENSION IF NOT EXISTS citext;
-- email CITEXT NOT NULL  -- justification: cross-system case-insensitive joins with external provider
```

### C.1 Character encoding and collation

1. **UTF-8 by default** — all databases are created with `ENCODING 'UTF8'`. Postgres 17 (`postgres:17-alpine` in `docker-compose.yml` and managed providers) defaults to UTF8, so no extra DDL is required. Do **not** create databases or schemas with non-UTF8 encodings.
2. **Do not override `LC_COLLATE` / `LC_CTYPE` per column** unless you have a documented sort/comparison requirement; rely on the database default (`en_US.UTF-8` or `C.UTF-8`).
3. **Don't churn column types for storage** — `text` and `varchar(n)` use the same storage, so never migrate one to the other just to "save bytes"; choose the right type up front (`varchar(n)` for bounded values, `text` for free-form).
4. **Existing columns keep their type** — do not propose churn-only migrations that flip `varchar(n)` ↔ `text`. Only retype when the table is otherwise being modified and the current type is genuinely wrong (e.g. growing a `varchar` limit via `ALTER COLUMN ... TYPE varchar(n)`).

### D. Auto-index suggestions

When reviewing a schema, apply these rules and **output the suggested indexes as SQL comments** at the bottom of the schema file or in the migration:

#### D.1 Foreign key indexes (mandatory)

Every FK column **must** have an index its ON DELETE / ON UPDATE action can use. Name: `idx_<table>_<column>`. The action runs `... WHERE <fk column> = $1` on the child once per deleted parent row, so without a usable index every tombstone purge scans the whole child table per purged row.

- The FK column(s) must **lead** the index — a composite `(organization_id, created_at, id)` covers `organization_id`.
- A **partial** index counts only when its predicate is `<column> IS NOT NULL` (the right shape for nullable FKs such as `*_by_user_id`). Any other predicate — e.g. `WHERE revoked_at IS NULL` — cannot serve the action, which must reach every row.
- **Declare it in the `*.schema.ts` too**, with the same name, uniqueness, key columns and `.where(...)` predicate — even when the migration builds it `CONCURRENTLY`. An index that exists only in a migration is invisible to anyone reading the schema, and a drizzle-kit diff drafted from that schema would propose dropping it.
- Gated against the migrated catalog by `src/tests/integration/database/index-hygiene.integration.test.ts` (FK coverage, no redundant prefixes, and schema ↔ catalog parity).

```sql
CREATE INDEX idx_webhook_delivery_attempts_webhook_id ON notify.webhook_delivery_attempts(webhook_id);
CREATE INDEX idx_memberships_organization_id ON tenancy.memberships(organization_id);
```

#### D.2 Unique indexes

Columns with `.unique()` in Drizzle get a unique index. Name: `idx_<table>_<column>`.

```sql
CREATE UNIQUE INDEX idx_subscriptions_provider_subscription_id ON billing.subscriptions(provider_subscription_id);
```

For soft-delete tables, unique constraints should be **partial** to allow re-use of values after soft-delete. Case-insensitive columns (e.g. email) should also be `lower()`-indexed:

```sql
CREATE UNIQUE INDEX idx_users_email_lower
  ON auth.users (lower(email))
  WHERE deleted_at IS NULL;
```

#### D.3 Composite indexes

Suggest composite indexes for common multi-column query patterns:

- `(organization_id, created_at)` — tenant-scoped time-range queries
- `(subscription_id, status)` — filtered lookups within a parent
- `(user_id, organization_id)` — membership lookups

Name: `idx_<table>_<col1>_<col2>`.

```sql
CREATE INDEX idx_subscriptions_organization_status ON billing.subscriptions(organization_id, status);
```

When a new composite index extends an existing one — e.g. adding `id` as a keyset tie-breaker to `(organization_id, created_at)` — **drop the shorter index in the same migration**. A B-tree whose columns (with matching sort order and collation) lead another index is redundant: the longer one serves every lookup, range and ordering it can, so the shorter one only costs writes. The same index-hygiene gate fails on any plain, non-unique index that is a leading prefix or duplicate of another.

#### D.4 Partial indexes

For boolean columns where one value is the minority (e.g. most rows are `is_active = true`):

```sql
CREATE INDEX idx_users_inactive ON auth.users(id) WHERE is_active = false;
```

For soft-delete queries (most queries exclude deleted rows):

```sql
CREATE INDEX idx_organizations_active ON tenancy.organizations(id) WHERE deleted_at IS NULL;
```

#### D.5 GIN indexes for JSONB

If a `jsonb` column will be queried with `@>`, `?`, or `?|` operators:

```sql
CREATE INDEX idx_audit_logs_metadata_gin ON audit.logs USING GIN (metadata);
```

Name: `idx_<table>_<column>_gin`.

#### D.6 Text search indexes

For columns that will be searched with `LIKE` or `ILIKE` patterns:

```sql
CREATE INDEX idx_users_email_trgm ON auth.users USING GIN (email gin_trgm_ops);
```

Requires `pg_trgm` extension. Only suggest when text search is a known requirement.

### E. Partitioning suggestions

For tables that are **append-heavy** and queried by **time range**, suggest partitioning. Output as a comment block — do not auto-apply.

#### E.1 Time-range partitioning (recommended for)

| Table pattern                          | Partition strategy                           |
| -------------------------------------- | -------------------------------------------- |
| `audit.logs`                           | `PARTITION BY RANGE (created_at)` — monthly  |
| `notify.notifications`                 | `PARTITION BY RANGE (created_at)` — monthly  |
| `notify.webhook_delivery_attempts`     | `PARTITION BY RANGE (created_at)` — monthly  |

Template:

```sql
-- PARTITIONING SUGGESTION (be-sql-design-guard)
-- This table is append-heavy and time-queried. Consider:
--
-- CREATE TABLE audit.logs (
--   ...
-- ) PARTITION BY RANGE (created_at);
--
-- CREATE TABLE audit.logs_y2026m01 PARTITION OF audit.logs
--   FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
-- CREATE TABLE audit.logs_y2026m02 PARTITION OF audit.logs
--   FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
--
-- Automate partition creation with pg_partman or a cron job.
-- Retention: DROP old partitions instead of DELETE for instant reclaim.
```

#### E.2 List partitioning (extreme scale only)

For multi-tenant tables at very high scale, suggest list partitioning by `organization_id`. This is rarely needed — only suggest when the table is expected to exceed 100M+ rows.

```sql
-- PARTITIONING SUGGESTION (be-sql-design-guard) — extreme scale only
-- CREATE TABLE tenancy.memberships (
--   ...
-- ) PARTITION BY LIST (organization_id);
```

#### E.3 When NOT to partition

- Tables under 10M expected rows — overhead outweighs benefit
- Tables with heavy UPDATE/DELETE workloads — partitioning adds complexity
- Tables without a clear partition key in WHERE clauses

### F. Constraint naming conventions

All constraints must be **explicitly named**. Never rely on auto-generated names.

| Object           | Pattern                                               | Example                                               |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Primary key      | `pk_<table>`                                          | `pk_subscriptions`                                                  |
| Foreign key      | `fk_<table>_<column>`                                 | `fk_subscriptions_organization_id`                                  |
| Check            | `chk_<table>_<column>` or `chk_<table>_<description>` | `chk_subscriptions_status`, `chk_subscriptions_period_end_positive` |
| Unique index     | `idx_<table>_<column>`                                | `idx_users_email`                                                   |
| Index            | `idx_<table>_<column(s)>`                             | `idx_subscriptions_organization_id`                                 |
| GIN index        | `idx_<table>_<column>_gin`                            | `idx_audit_logs_metadata_gin`                                       |
| Trigger          | `trg_<table>_<action>`                                | `trg_subscriptions_updated_at`                                      |
| Trigger function | `fn_<action>()`                                       | `fn_set_updated_at()`                                               |
| Sequence         | `seq_<table>_<column>`                                | `seq_subscriptions_id` (only when custom)                           |

### G. Audit and soft-delete patterns

#### G.1 Soft delete (standard on all user-facing tables)

```typescript
deleted_at: timestamp('deleted_at', { withTimezone: true }),
```

- Never hard-delete user data in production
- All queries on soft-deletable tables should filter `WHERE deleted_at IS NULL` by default
- Unique constraints on soft-delete tables must be partial: `WHERE deleted_at IS NULL`

#### G.2 Updated-at trigger

Every table with `updated_at` should have an auto-update trigger in the migration:

```sql
CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_<table>_updated_at
  BEFORE UPDATE ON <schema>.<table>
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
```

#### G.3 Audit log table template

For domains requiring audit trails, follow the pattern in `src/domains/audit/audit.schema.ts`:

- `actor_user_id` — who performed the action
- `target_user_id` — who was affected (if applicable)
- `organization_id` — tenant scope
- `action` — `text` + `CHECK (char_length(action) <= 100)`, describes what happened
- `resource_type` — `text` + `CHECK (char_length(resource_type) <= 50)`, the entity type
- `resource_id` — `bigint`, the affected row
- `metadata` — `jsonb`, stores changed fields, old/new values
- `severity` — `text` with CHECK constraint (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`)
- `created_at` — timestamp (no `updated_at` — audit logs are immutable)

### H. Row-level security (RLS)

Every production table must:

- Call `.enableRLS()` on the table definition
- Define at least one `pgPolicy` in the constraints array
- Include RLS migration SQL with `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`

Verify with: `grep -r "enableRLS" src/domains/` — every domain schema should have it.

### I. Foreign key strategy

1. **Always name FK constraints**: `fk_<table>_<column>`
2. **Always index FK columns** (see section D.1)
3. **Choose ON DELETE deliberately**:

   | Relationship                          | ON DELETE action            | Example                         |
   | ------------------------------------- | --------------------------- | ------------------------------- |
   | Parent owns children (cascade delete) | `CASCADE`                   | `webhook_delivery_attempts` → `webhooks` |
   | Child references critical parent      | `RESTRICT`                  | `subscriptions` → `plans`                |
   | Optional reference                    | `SET NULL`                  | `logs.actor_user_id` → `users`  |
   | Soft-delete parent                    | `NO ACTION` (handle in app) | `memberships` → `organizations` |

4. **In Drizzle schemas**, express FK references using `.references()`:

```typescript
subscription_id: bigserial('subscription_id', { mode: 'number' })
  .notNull()
  .references(() => subscriptions.id, { onDelete: 'restrict' }),
```

### J. SQL formatting rules (for migrations)

When writing raw SQL in migration files:

1. **Keywords**: `UPPERCASE` — `CREATE TABLE`, `ALTER TABLE`, `NOT NULL`, `DEFAULT`, `REFERENCES`
2. **Identifiers**: `lowercase_snake_case` — `webhook_events`, `subscription_id`
3. **One column per line** in `CREATE TABLE`
4. **Trailing commas** (comma at end of line)
5. **Constraints at bottom** of `CREATE TABLE` block or as separate `ALTER TABLE` statements
6. **Schema-qualify all objects**: `billing.subscriptions`, not just `subscriptions`
7. **Consistent indentation**: 2 or 4 spaces (match project preference)
8. **Semicolons**: every statement ends with `;`

Example:

```sql
CREATE TABLE billing.subscriptions (
  id BIGSERIAL PRIMARY KEY,
  public_id VARCHAR(28) NOT NULL,
  organization_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'INCOMPLETE',
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_subscriptions PRIMARY KEY (id),
  CONSTRAINT idx_subscriptions_public_id UNIQUE (public_id),
  CONSTRAINT fk_subscriptions_organization_id FOREIGN KEY (organization_id) REFERENCES tenancy.organizations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_subscriptions_plan_id FOREIGN KEY (plan_id) REFERENCES billing.plans(id) ON DELETE RESTRICT,
  CONSTRAINT chk_subscriptions_status CHECK (status IN ('ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'TRIALING'))
);

CREATE INDEX idx_subscriptions_organization_id ON billing.subscriptions(organization_id);
CREATE INDEX idx_subscriptions_plan_id ON billing.subscriptions(plan_id);
CREATE INDEX idx_subscriptions_status ON billing.subscriptions(status);
CREATE UNIQUE INDEX idx_subscriptions_public_id ON billing.subscriptions(public_id);

CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON billing.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
```

## Output format

When the skill runs, produce a **review block** at the end of your response with:

1. **Naming violations** — any table, column, index, or constraint that doesn't match conventions
2. **Type violations** — any new `varchar(n)` column (use `text` + CHECK), any unjustified `citext`, any non-UTF8 encoding directive
3. **Missing indexes** — FK columns without indexes, missing composite indexes for obvious query patterns; case-insensitive columns missing a `lower()` index
4. **Partitioning recommendation** — if the table matches append-heavy/time-series criteria
5. **Missing constraints** — unnamed FKs, missing CHECK constraints for controlled-value columns, missing `char_length` CHECK on `public_id`
6. **Missing audit columns** — tables missing `created_at`, `updated_at`, `deleted_at`, or audit trail columns
7. **Suggested migration SQL** — ready-to-use SQL for any missing indexes, constraints, or triggers

Format:

````markdown
## SQL Design Guard Review

### Naming
- [PASS/FAIL] Table name: ...
- [PASS/FAIL] Column names: ...

### Types
- [PASS/FAIL] No `varchar(n)` on new columns (use `text` + CHECK)
- [PASS/FAIL] `citext` use is justified (or absent)
- [PASS/FAIL] No non-UTF8 encoding / per-column collation overrides

### Indexes
- [MISSING] idx_<table>_<column> — FK column without index
- [SUGGEST] idx_<table>_<col1>_<col2> — composite for common query pattern

### Partitioning
- [SUGGEST] PARTITION BY RANGE (created_at) — append-heavy table

### Constraints
- [MISSING] chk_<table>_<column> — controlled-value column without CHECK
- [MISSING] fk_<table>_<column> — unnamed foreign key

### Audit
- [MISSING] deleted_at — user-facing table without soft delete
- [MISSING] trg_<table>_updated_at — table with updated_at but no auto-trigger

### Migration SQL (copy-paste ready)
​```sql
-- Suggested additions
CREATE INDEX idx_...
ALTER TABLE ... ADD CONSTRAINT chk_...
CREATE TRIGGER trg_...
​```
````

---

**Related skills:** [be-schema-generator](../be-schema-generator/SKILL.md) · [be-db-migration-maintainer](../be-db-migration-maintainer/SKILL.md)
