import { describe, expect, it } from 'vitest';
import {
  applyMigrationSql,
  emptySchema,
  findTable,
  parseColumnDef,
  type SchemaSnapshot,
} from '@tooling/db-viewer/lib/sql-migrations.mjs';
import { diffSchemas } from '@tooling/db-viewer/lib/diff.mjs';
import {
  normalizeDefault,
  normalizeOnDelete,
  tableKey,
} from '@tooling/db-viewer/lib/normalize.mjs';
import { hasSchemaFiles } from '@tooling/db-viewer/lib/project.mjs';
import { parseSchema } from '@tooling/db-viewer/lib/parser.mjs';
import path from 'node:path';

describe('db-viewer normalize', () => {
  it('treats null and no action onDelete as equivalent', () => {
    expect(normalizeOnDelete(null)).toBeNull();
    expect(normalizeOnDelete('no action')).toBeNull();
    expect(normalizeOnDelete('CASCADE')).toBe('cascade');
  });

  it('normalizes quoted / JSON-ish defaults', () => {
    expect(normalizeDefault("'{}'")).toBe('{}');
    expect(normalizeDefault('{}')).toBe('{}');
    expect(normalizeDefault('\'["en"]\'')).toBe('["en"]');
  });

  it('keys tables by schema.name', () => {
    expect(tableKey({ schema: 'audit', name: 'outbox' })).toBe('audit.outbox');
    expect(tableKey({ name: 'users' })).toBe('public.users');
  });
});

describe('db-viewer SQL constraints', () => {
  it('applies named CONSTRAINT PRIMARY KEY / UNIQUE', () => {
    const sql = `
      CREATE TABLE "tenancy"."role_permissions" (
        "role_id" integer NOT NULL,
        "permission_code" text NOT NULL,
        CONSTRAINT "pk_role_permissions" PRIMARY KEY("role_id","permission_code")
      );
      CREATE TABLE "auth"."sessions" (
        "id" integer PRIMARY KEY,
        "public_id" uuid NOT NULL,
        CONSTRAINT "sessions_public_id_unique" UNIQUE("public_id")
      );
    `;
    const { schema } = applyMigrationSql(emptySchema(), sql);
    const rp = findTable(schema, 'tenancy.role_permissions');
    expect(rp).toBeTruthy();
    expect(
      rp!.columns
        .filter((c) => c.pk)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['permission_code', 'role_id']);
    const sess = findTable(schema, 'auth.sessions');
    expect(sess!.columns.find((c) => c.name === 'public_id')?.unique).toBe(true);
  });

  it('does not drop columns named unique_*/check*/constraint_*', () => {
    expect(parseColumnDef('unique_code text')).toMatchObject({ name: 'unique_code', type: 'text' });
    expect(parseColumnDef('checksum text')).toMatchObject({ name: 'checksum', type: 'text' });
    expect(parseColumnDef('constraint_kind text')).toMatchObject({
      name: 'constraint_kind',
      type: 'text',
    });
  });

  it('parses quoted type names like "inet"', () => {
    const col = parseColumnDef('"ip_address" "inet" NOT NULL');
    expect(col).toMatchObject({ name: 'ip_address', type: 'inet', notNull: true });
  });

  it('applies multi-action ADD COLUMN', () => {
    const sql = `
      CREATE TABLE public.t (id int);
      ALTER TABLE public.t ADD COLUMN a int, ADD COLUMN b text;
    `;
    const { schema } = applyMigrationSql(emptySchema(), sql);
    const t = findTable(schema, 'public.t');
    expect(t!.columns.map((c) => c.name).sort()).toEqual(['a', 'b', 'id']);
  });

  it('does not cross-wire schema-qualified tables with the same bare name', () => {
    const sql = `
      CREATE TABLE audit.outbox (id bigint);
      CREATE TABLE notify.outbox (id bigint, payload text);
      ALTER TABLE notify.outbox ADD COLUMN oops text;
      ALTER TABLE notify.outbox DROP COLUMN id;
    `;
    const { schema } = applyMigrationSql(emptySchema(), sql);
    const audit = findTable(schema, 'audit.outbox');
    const notify = findTable(schema, 'notify.outbox');
    expect(audit!.columns.map((c) => c.name)).toEqual(['id']);
    expect(notify!.columns.map((c) => c.name).sort()).toEqual(['oops', 'payload']);
  });

  it('applies FK DDL inside DO $$ blocks', () => {
    const sql = `
      CREATE TABLE tenancy.api_keys (id bigint PRIMARY KEY);
      CREATE TABLE audit.logs (id bigint PRIMARY KEY, actor_api_key_id bigint);
      DO $$ BEGIN
        ALTER TABLE audit.logs
          ADD CONSTRAINT logs_actor_api_key_id_fk
          FOREIGN KEY (actor_api_key_id) REFERENCES tenancy.api_keys(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `;
    const { schema } = applyMigrationSql(emptySchema(), sql);
    const logs = findTable(schema, 'audit.logs');
    const col = logs!.columns.find((c) => c.name === 'actor_api_key_id');
    expect(col?.references).toMatchObject({
      table: 'api_keys',
      column: 'id',
      onDelete: 'set null',
    });
  });

  it('does not treat DEFAULT string contents as NOT NULL', () => {
    const col = parseColumnDef(`a text DEFAULT 'x NOT NULL y'`);
    expect(col?.notNull).toBe(false);
  });

  it('keeps PARTITION BY out of the column-def block', () => {
    const { schema, skipped } = applyMigrationSql(
      emptySchema(),
      `CREATE TABLE public.events (id bigint PRIMARY KEY, occurred_at timestamptz NOT NULL) PARTITION BY RANGE (occurred_at);`,
    );
    expect(skipped).toBe(0);
    const t = findTable(schema, 'public.events');
    expect(t!.columns.map((c) => c.name).sort()).toEqual(['id', 'occurred_at']);
  });
});

describe('db-viewer drizzle parser', () => {
  it('does not treat // inside a TS regex literal as a comment', () => {
    // Single line on purpose: pre-fix, the `//` inside the regex stripped the rest of
    // the line, silently dropping the second table.
    const source = `export const users = pgTable('users', { id: text('id').primaryKey() }); const collapse = (v) => v.replace(/\\/\\//g, '/'); export const posts = pgTable('posts', { id: text('id').primaryKey() });`;
    const schema = parseSchema(source);
    expect(schema.tables.map((t) => t.name).sort()).toEqual(['posts', 'users']);
  });
});

describe('db-viewer diffSchemas', () => {
  it('does not report false positives for onDelete null vs no action', () => {
    const a = {
      dialect: 'postgres',
      enums: [],
      tables: [
        {
          var: 'organizations',
          name: 'organizations',
          schema: 'tenancy',
          columns: [
            {
              key: 'created_by_user_id',
              name: 'created_by_user_id',
              type: 'bigint',
              pk: false,
              notNull: false,
              unique: false,
              default: null,
              references: { table: 'users', column: 'id', onDelete: 'no action' },
            },
          ],
          indexes: [],
        },
      ],
      relations: [],
    } satisfies SchemaSnapshot;
    const organization = a.tables[0]!;
    const col = organization.columns[0]!;
    const b = {
      ...a,
      tables: [
        {
          ...organization,
          columns: [
            {
              ...col,
              references: { table: 'users', column: 'id', onDelete: null },
            },
          ],
        },
      ],
    };
    const diff = diffSchemas(a, b);
    expect(diff.counts.columnsModified).toBe(0);
  });

  it('keys diff maps by schema.name (no cross-schema collision)', () => {
    const left = {
      dialect: 'postgres',
      enums: [],
      tables: [
        {
          var: 'outbox',
          name: 'outbox',
          schema: 'audit',
          columns: [
            {
              key: 'id',
              name: 'id',
              type: 'bigint',
              pk: true,
              notNull: true,
              unique: false,
              default: null,
              references: null,
            },
          ],
          indexes: [],
        },
        {
          var: 'outbox',
          name: 'outbox',
          schema: 'notify',
          columns: [
            {
              key: 'id',
              name: 'id',
              type: 'bigint',
              pk: true,
              notNull: true,
              unique: false,
              default: null,
              references: null,
            },
            {
              key: 'payload',
              name: 'payload',
              type: 'text',
              pk: false,
              notNull: false,
              unique: false,
              default: null,
              references: null,
            },
          ],
          indexes: [],
        },
      ],
      relations: [],
    } satisfies SchemaSnapshot;
    const diff = diffSchemas(left, left);
    expect(diff.counts.columnsAdded).toBe(0);
    expect(diff.counts.columnsRemoved).toBe(0);
    expect(diff.counts.columnsModified).toBe(0);
  });
});

describe('db-viewer skip counter', () => {
  it('counts ALTER on a missing table as skipped (not silently applied)', () => {
    const { schema, skipped } = applyMigrationSql(
      emptySchema(),
      `ALTER TABLE public.does_not_exist ADD COLUMN oops text;`,
    );
    expect(schema.tables).toHaveLength(0);
    expect(skipped).toBeGreaterThanOrEqual(1);
  });

  it('counts mixed ADD COLUMN + ALTER COLUMN as skipped when sibling is dropped', () => {
    const seed = `
      CREATE TABLE public.t (id int, b text);
    `;
    const { schema: base } = applyMigrationSql(emptySchema(), seed);
    const { schema, skipped } = applyMigrationSql(
      base,
      `ALTER TABLE public.t ADD COLUMN a int, ALTER COLUMN b SET NOT NULL;`,
    );
    // Whole statement fails closed so we don't pretend partial apply succeeded.
    expect(skipped).toBeGreaterThanOrEqual(1);
    expect(schema.tables[0]?.columns.find((c) => c.name === 'a')).toBeUndefined();
  });

  it('counts genuinely unhandled structural DDL as skipped', () => {
    const { skipped } = applyMigrationSql(emptySchema(), `ALTER TABLE public.t OWNER TO app_user;`);
    expect(skipped).toBeGreaterThanOrEqual(1);
  });

  it('applies SET DATA TYPE (drizzle-kit form) and counts unknown ALTER COLUMN as skipped', () => {
    const { schema: base } = applyMigrationSql(
      emptySchema(),
      `CREATE TABLE public.t (a varchar(32));`,
    );
    const { schema, skipped } = applyMigrationSql(
      base,
      `ALTER TABLE public.t ALTER COLUMN a SET DATA TYPE text;`,
    );
    expect(skipped).toBe(0);
    expect(schema.tables[0]?.columns.find((c) => c.name === 'a')?.type).toBe('text');

    const { skipped: skippedUnknown } = applyMigrationSql(
      schema,
      `ALTER TABLE public.t ALTER COLUMN a SET STATISTICS 100;`,
    );
    expect(skippedUnknown).toBeGreaterThanOrEqual(1);
  });

  it('applies every action in a multi ALTER COLUMN statement', () => {
    const { schema: base } = applyMigrationSql(
      emptySchema(),
      `CREATE TABLE public.t (a text, b text);`,
    );
    const { schema, skipped } = applyMigrationSql(
      base,
      `ALTER TABLE public.t ALTER COLUMN a SET NOT NULL, ALTER COLUMN b SET NOT NULL;`,
    );
    expect(skipped).toBe(0);
    const cols = schema.tables[0]?.columns ?? [];
    expect(cols.find((c) => c.name === 'a')?.notNull).toBe(true);
    expect(cols.find((c) => c.name === 'b')?.notNull).toBe(true);
  });
});

describe('db-viewer project detect', () => {
  it('finds schema files in this repo src/ despite file count >> 400', () => {
    const src = path.resolve(process.cwd(), 'src');
    expect(hasSchemaFiles(src)).toBe(true);
  });
});
