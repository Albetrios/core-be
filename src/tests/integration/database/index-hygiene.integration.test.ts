import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SQL, is } from 'drizzle-orm';
import { type IndexedColumn, PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, it, expect } from 'vitest';
import { sql } from '@/infrastructure/database/connection.js';

/**
 * Structural index invariants, asserted against the migrated catalog.
 *
 * Migrations create indexes; the Drizzle schema files describe them. The catalog is what the
 * database actually has, so every invariant is checked against `pg_index` — including the third,
 * which holds the schema files to it.
 *
 * 1. Every foreign key has an index its ON DELETE / ON UPDATE action can use. The action runs as
 *    `... WHERE <fk columns> = $1` on the child table once per deleted parent row, so a missing
 *    index turns a tombstone purge into one full scan of the child table per purged row.
 * 2. No B-tree index is a leading prefix (or a duplicate) of another on the same table. The
 *    longer index serves every lookup, range and ordering the shorter one can, so the shorter one
 *    only adds work to every insert and non-HOT update.
 * 3. The Drizzle schema declares exactly the indexes the database has — same name, uniqueness and
 *    key columns. An index that exists only in a migration is invisible to anyone reading the
 *    schema, and a drizzle-kit diff drafted from that schema would propose dropping it (the
 *    attribution FK indexes of `20260623000000` were in exactly that state).
 */

const APPLICATION_SCHEMAS = ['auth', 'tenancy', 'billing', 'notify', 'audit', 'upload', 'public'];

describe('Integration: index hygiene', () => {
  it('backs every foreign key with an index its ON DELETE / ON UPDATE action can use', async () => {
    // A partial index is usable only when the action's `<column> = $1` implies its predicate,
    // which holds for `<column> IS NOT NULL` and nothing else (e.g. not `revoked_at IS NULL`).
    const foreignKeys = await sql<
      {
        table_name: string;
        columns: string;
        referenced_table: string;
        constraint_name: string;
        usable_index: string | null;
      }[]
    >`
      SELECT c.conrelid::regclass::text AS table_name,
             c.confrelid::regclass::text AS referenced_table,
             c.conname AS constraint_name,
             (SELECT string_agg(a.attname, ', ' ORDER BY k.position)
                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
             (SELECT min(index_class.relname)
                FROM pg_index i
                JOIN pg_class index_class ON index_class.oid = i.indexrelid
                JOIN pg_am am ON am.oid = index_class.relam
               WHERE i.indrelid = c.conrelid
                 AND i.indisvalid
                 AND am.amname = 'btree'
                 AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
                 AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
                 AND (i.indpred IS NULL
                      OR pg_get_expr(i.indpred, i.indrelid) = ANY (
                           SELECT format('(%I IS NOT NULL)', a.attname)
                             FROM pg_attribute a
                            WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)))) AS usable_index
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'f' AND n.nspname = ANY (${APPLICATION_SCHEMAS})
    `;
    // Guard against a vacuous pass on an unmigrated database.
    expect(foreignKeys.length).toBeGreaterThan(50);

    const uncovered = foreignKeys
      .filter((foreignKey) => foreignKey.usable_index === null)
      .map(
        (foreignKey) =>
          `${foreignKey.table_name} (${foreignKey.columns}) → ${foreignKey.referenced_table} [${foreignKey.constraint_name}]`,
      );
    expect(
      uncovered,
      'Foreign keys whose ON DELETE/UPDATE action scans the whole child table — add a CONCURRENTLY index in a migration (model: 20260923152433_index_uncovered_foreign_keys.sql)',
    ).toEqual([]);
  });

  it('keeps no B-tree index that is a leading prefix or duplicate of another on the same table', async () => {
    // Redundant = plain (no predicate, no expression, no INCLUDE) and non-unique — a unique index
    // enforces a constraint and is never dropped for coverage. Its covering index must be plain and
    // match it column for column on operator class, sort order and collation.
    const [countRow] = await sql<{ btree_index_count: number }[]>`
      SELECT count(*)::int AS btree_index_count
        FROM pg_index i
        JOIN pg_class index_class ON index_class.oid = i.indexrelid
        JOIN pg_am am ON am.oid = index_class.relam
        JOIN pg_class table_class ON table_class.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = table_class.relnamespace
       WHERE am.amname = 'btree' AND n.nspname = ANY (${APPLICATION_SCHEMAS})
    `;
    expect(countRow?.btree_index_count ?? 0).toBeGreaterThan(100);

    const redundantIndexes = await sql<{ redundant_index: string; covering_index: string }[]>`
      WITH btree_indexes AS (
        SELECT i.indexrelid, i.indrelid, i.indisunique, i.indnkeyatts, i.indnatts,
               (i.indkey::int2[])[0:i.indnkeyatts - 1] AS key_columns,
               (i.indclass::oid[])[0:i.indnkeyatts - 1] AS operator_classes,
               (i.indoption::int2[])[0:i.indnkeyatts - 1] AS sort_options,
               (i.indcollation::oid[])[0:i.indnkeyatts - 1] AS collations,
               (i.indpred IS NULL AND i.indexprs IS NULL) AS is_plain
          FROM pg_index i
          JOIN pg_class index_class ON index_class.oid = i.indexrelid
          JOIN pg_am am ON am.oid = index_class.relam
          JOIN pg_class table_class ON table_class.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = table_class.relnamespace
         WHERE am.amname = 'btree' AND i.indisvalid AND n.nspname = ANY (${APPLICATION_SCHEMAS})
      )
      SELECT redundant.indexrelid::regclass::text AS redundant_index,
             covering.indexrelid::regclass::text AS covering_index
        FROM btree_indexes redundant
        JOIN btree_indexes covering
          ON covering.indrelid = redundant.indrelid
         AND covering.indexrelid <> redundant.indexrelid
         AND covering.is_plain
         AND covering.indnkeyatts >= redundant.indnkeyatts
         AND covering.key_columns[1:redundant.indnkeyatts] = redundant.key_columns
         AND covering.operator_classes[1:redundant.indnkeyatts] = redundant.operator_classes
         AND covering.sort_options[1:redundant.indnkeyatts] = redundant.sort_options
         AND covering.collations[1:redundant.indnkeyatts] = redundant.collations
       WHERE redundant.is_plain
         AND NOT redundant.indisunique
         AND redundant.indnatts = redundant.indnkeyatts
         -- an exact duplicate pair is reported once, not twice
         AND (covering.indnkeyatts > redundant.indnkeyatts
              OR covering.indisunique
              OR covering.indexrelid > redundant.indexrelid)
       ORDER BY 1
    `;
    expect(
      redundantIndexes.map((pair) => `${pair.redundant_index} ⊂ ${pair.covering_index}`),
      'Indexes the index on the right already serves — drop them with DROP INDEX CONCURRENTLY (model: 20260923130000_drop_redundant_prefix_indexes.sql)',
    ).toEqual([]);
  });

  it('declares in the Drizzle schema exactly the indexes the database has', async () => {
    // Constraint-backed indexes (primary keys, `.unique()` constraints) are declared through the
    // constraint, not as an index, so only standalone indexes are compared.
    const catalogRows = await sql<{ key: string; is_unique: boolean; key_columns: string }[]>`
      SELECT n.nspname || '.' || t.relname || '.' || i.relname AS key,
             x.indisunique AS is_unique,
             (SELECT string_agg(coalesce(a.attname, '<expression>'), ',' ORDER BY k.position)
                FROM unnest((x.indkey::int2[])[0:x.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, position)
                LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS key_columns
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = ANY (${APPLICATION_SCHEMAS})
         AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
    `;
    const catalog = new Map(catalogRows.map((row) => [row.key, describeIndex(row)]));
    const declared = await declaredDrizzleIndexes();
    // Guard against a vacuous pass: no schema files found, or an unmigrated database.
    expect(declared.size).toBeGreaterThan(100);
    expect(catalog.size).toBeGreaterThan(100);

    const drift = [
      ...[...catalog.keys()]
        .filter((key) => !declared.has(key))
        .map((key) => `${key} exists in the database but no schema declares it`),
      ...[...declared.keys()]
        .filter((key) => !catalog.has(key))
        .map((key) => `${key} is declared but no migration creates it`),
      ...[...declared.entries()]
        .filter(([key, shape]) => catalog.has(key) && catalog.get(key) !== shape)
        .map(
          ([key, shape]) =>
            `${key} is declared as ${shape} but the database has ${catalog.get(key)}`,
        ),
    ].sort();
    expect(
      drift,
      'Declare every index in its *.schema.ts, matching the migration that creates it (model: the attribution FK indexes of 20260623000000)',
    ).toEqual([]);
  });
});

/** An index's comparable shape: uniqueness plus its key columns in order. */
function describeIndex(index: { is_unique: boolean; key_columns: string }): string {
  return `${index.is_unique ? 'unique' : 'non-unique'}(${index.key_columns})`;
}

/** Every index declared on a Drizzle table in any `*.schema.ts` under `src/`, keyed like the catalog. */
async function declaredDrizzleIndexes(): Promise<Map<string, string>> {
  const indexes = new Map<string, string>();
  for (const file of schemaFiles('src')) {
    const schemaModule = (await import(
      `@/${file.slice('src/'.length).replace(/\.ts$/, '.js')}`
    )) as Record<string, unknown>;
    for (const exported of Object.values(schemaModule)) {
      if (!is(exported, PgTable)) continue;
      const table = getTableConfig(exported);
      for (const index of table.indexes) {
        const columns = index.config.columns
          // `index().on(...)` stores IndexedColumn wrappers (carrying the column `name`); an
          // expression index stores the SQL itself.
          .map((column) =>
            is(column, SQL)
              ? '<expression>'
              : ((column as Partial<IndexedColumn>).name ?? '<expression>'),
          )
          .join(',');
        indexes.set(
          `${table.schema ?? 'public'}.${table.name}.${index.config.name}`,
          describeIndex({ is_unique: index.config.unique, key_columns: columns }),
        );
      }
    }
  }
  return indexes;
}

function schemaFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : schemaFiles(path);
    return path.endsWith('.schema.ts') ? [path] : [];
  });
}
