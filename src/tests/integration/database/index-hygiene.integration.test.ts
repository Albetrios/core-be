import { describe, it, expect } from 'vitest';
import { sql } from '@/infrastructure/database/connection.js';

/**
 * Structural index invariants, asserted against the migrated catalog.
 *
 * The catalog — not the Drizzle schema files — is the source here, because some indexes (the
 * attribution FK indexes of `20260623000000_attribution_fk_indexes.sql`) exist only in
 * migrations; only `pg_index` sees every one.
 *
 * 1. Every foreign key has an index its ON DELETE / ON UPDATE action can use. The action runs as
 *    `... WHERE <fk columns> = $1` on the child table once per deleted parent row, so a missing
 *    index turns a tombstone purge into one full scan of the child table per purged row.
 * 2. No B-tree index is a leading prefix (or a duplicate) of another on the same table. The
 *    longer index serves every lookup, range and ordering the shorter one can, so the shorter one
 *    only adds work to every insert and non-HOT update.
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
});
