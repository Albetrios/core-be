/**
 * Static safety lint for SQL migrations (expand-then-contract / zero-downtime guardrails).
 *
 * Usage:
 *   pnpm db:migrate:lint
 *   pnpm db:migrate:lint path/to/other/migrations
 *
 * Override (first 20 lines of a migration file):
 *   -- migration-safety: allow <rule_id> reason="quoted reason"
 */

import chalk from 'chalk';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMigrationExecutionMode } from '@/infrastructure/database/migration/migration-execution-mode.js';
import { EXPECTED_FORCE_RLS_TABLES } from '@/infrastructure/database/utils/force-rls-tables.constants.js';

/** Identifiers of every rule {@link lintMigrationFileContent} can report; used for header-comment allow-lists. */
export const migrationSafetyRuleIds = [
  'add_column_not_null_without_default',
  'add_check_without_not_valid',
  'add_foreign_key_without_not_valid',
  'add_unique_constraint_inline',
  'alter_column_type',
  'concurrent_index_requires_non_transactional',
  'create_index_without_concurrently',
  'disable_row_security_guc',
  'force_rls_data_migration_without_owner_bracket',
  'drop_column',
  'drop_index_without_concurrently',
  'drop_table',
  'missing_if_not_exists_on_create',
  'non_transactional_statements_need_breakpoints',
  'rename_column_or_table',
  'set_not_null_on_existing_column',
] as const;

/** String-literal union of every migration safety rule id. */
export type MigrationSafetyRuleId = (typeof migrationSafetyRuleIds)[number];

const migrationSafetyRuleIdSet = new Set<string>(migrationSafetyRuleIds);

const ruleFixHints: Record<MigrationSafetyRuleId, string> = {
  add_column_not_null_without_default:
    'Add the column as nullable (or with DEFAULT), backfill, then SET NOT NULL using NOT VALID + VALIDATE then SET NOT NULL.',
  add_check_without_not_valid:
    'Use ADD CONSTRAINT ... CHECK (...) NOT VALID, then VALIDATE CONSTRAINT in a follow-up step.',
  add_foreign_key_without_not_valid:
    'Use ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID, then VALIDATE CONSTRAINT in a follow-up step.',
  add_unique_constraint_inline:
    'Prefer CREATE UNIQUE INDEX CONCURRENTLY, then ADD CONSTRAINT ... UNIQUE USING INDEX (runner may need a non-transactional migration).',
  alter_column_type:
    'Add a new column with the target type, backfill, switch reads/writes, then drop the old column in a later migration.',
  concurrent_index_requires_non_transactional:
    'CREATE INDEX CONCURRENTLY cannot run inside a transaction. Mark this migration non-transactional by adding `-- migration-transaction: none reason="..."` in the first 20 lines, and keep the index DDL idempotent (IF NOT EXISTS).',
  create_index_without_concurrently:
    'Prefer CREATE INDEX CONCURRENTLY in a non-transactional migration. This repo runs each file inside a transaction, so CONCURRENTLY cannot run as-is; split the index into a follow-up migration that runs outside a transaction, or explicitly allow this rule with a documented reason.',
  disable_row_security_guc:
    'Migrations must not SET / RESET the `row_security` GUC. Postgres enforces RLS on FORCE ROW LEVEL SECURITY tables for any non-privileged session role; SECURITY DEFINER functions already run as their owner and bypass RLS through ownership, not by toggling row_security. Drop the SET row_security clause and rely on SECURITY DEFINER + GRANT EXECUTE.',
  force_rls_data_migration_without_owner_bracket:
    'The migrator is RLS-subject (core_be_migrator is a member of core_be_owner and FORCE ROW LEVEL SECURITY binds owners), so a data migration that touches a FORCE RLS table is either rejected (writes) or silently handed zero rows (reads). Bracket EVERY FORCE RLS table the file writes OR reads with `ALTER TABLE <table> NO FORCE ROW LEVEL SECURITY` before the data statements and `ALTER TABLE <table> FORCE ROW LEVEL SECURITY` after, in a transactional migration so a failure rolls FORCE back too. Model: 20260921000000_team_owner_notify_permissions_backfill.sql.',
  drop_column:
    'Stop application writes, deploy, then drop the column in a later migration (contract phase).',
  drop_index_without_concurrently:
    'Prefer DROP INDEX CONCURRENTLY in a non-transactional migration. Plain DROP INDEX takes an ACCESS EXCLUSIVE lock on the parent table for the catalog update — short on a small index, but enough to stall a high-write table during the migration window. Move the DROP into a separate migration with `-- migration-transaction: none reason="DROP INDEX CONCURRENTLY cannot run inside a transaction"` and use `DROP INDEX CONCURRENTLY IF EXISTS <schema>.<name>;`.',
  drop_table:
    'DROP TABLE is destructive: use IF EXISTS for idempotency and add a migration-safety allow with a documented reason.',
  missing_if_not_exists_on_create:
    'Add IF NOT EXISTS to CREATE TABLE / CREATE INDEX / CREATE SCHEMA for safer retries.',
  non_transactional_statements_need_breakpoints:
    'A `migration-transaction: none` file runs each `--> statement-breakpoint` segment as its own command. Put exactly one statement per segment (separate every statement with `--> statement-breakpoint`) — CREATE INDEX CONCURRENTLY cannot share an implicit transaction with another statement.',
  rename_column_or_table:
    'Prefer add-new + backfill + switch + drop-old instead of in-place RENAME for zero-downtime.',
  set_not_null_on_existing_column:
    'Use NOT VALID check constraints + VALIDATE (or backfill) before SET NOT NULL on existing data.',
};

const headerAllowLinePattern =
  /^--\s+migration-safety:\s+allow\s+([a-z0-9_]+)\s+reason="([^"]*)"\s*$/i;

const bareMigrationSafetyPattern = /^--\s+migration-safety:\s*$/i;
const nonAllowMigrationSafetyPattern = /^--\s+migration-safety:\s+(?!allow\s+)/i;

type Violation = {
  filename: string;
  lineNumber: number;
  ruleId: MigrationSafetyRuleId;
  message: string;
};

type ParsedHeader = {
  allows: Map<MigrationSafetyRuleId, string>;
  headerErrors: string[];
};

function offsetToLineNumber(fileContent: string, offset: number): number {
  if (offset <= 0) return 1;
  let lineNumber = 1;
  const limit = Math.min(offset, fileContent.length);
  for (let index = 0; index < limit; index += 1) {
    if (fileContent.charCodeAt(index) === 10) lineNumber += 1;
  }
  return lineNumber;
}

function skipLineComment(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length && source.charCodeAt(index) !== 10) index += 1;
  return index;
}

function skipBlockComment(source: string, startIndex: number): number {
  let index = startIndex + 2;
  while (index < source.length - 1) {
    if (source[index] === '*' && source[index + 1] === '/') return index + 2;
    index += 1;
  }
  return source.length;
}

function skipSingleQuotedString(source: string, startIndex: number): number {
  let index = startIndex + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "'") {
      if (source[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/** Skip a PostgreSQL dollar-quoted literal starting at the opening `$`. */
function skipDollarQuotedString(source: string, dollarIndex: number): number {
  if (source[dollarIndex] !== '$') return dollarIndex + 1;
  let index = dollarIndex + 1;
  let tag = '';
  while (index < source.length && source[index] !== '$') {
    tag += source[index];
    index += 1;
  }
  if (index >= source.length) return source.length;
  index += 1;
  const closingDelimiter = `$${tag}$`;
  const closingFoundAt = source.indexOf(closingDelimiter, index);
  if (closingFoundAt === -1) return source.length;
  return closingFoundAt + closingDelimiter.length;
}

/**
 * Splits a SQL file into top-level statements, preserving the start offset of
 * each so violation messages can report accurate line numbers. Handles
 * dollar-quoted strings, line/block comments, and single-quoted literals.
 */
export function splitSqlStatements(source: string): { text: string; startOffset: number }[] {
  const statements: { text: string; startOffset: number }[] = [];
  let segmentStart = 0;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (character === '-' && source[index + 1] === '-') {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === "'") {
      index = skipSingleQuotedString(source, index);
      continue;
    }
    if (character === '$') {
      index = skipDollarQuotedString(source, index);
      continue;
    }
    if (character === ';') {
      const rawSlice = source.slice(segmentStart, index);
      const leadingWhitespaceLength = rawSlice.length - rawSlice.trimStart().length;
      const trimmed = rawSlice.trim();
      if (trimmed.length > 0) {
        statements.push({
          text: trimmed,
          startOffset: segmentStart + leadingWhitespaceLength,
        });
      }
      index += 1;
      while (index < source.length && /\s/.test(source.charAt(index))) index += 1;
      segmentStart = index;
      continue;
    }
    index += 1;
  }

  const tail = source.slice(segmentStart);
  const leadingWhitespaceLength = tail.length - tail.trimStart().length;
  const trimmedTail = tail.trim();
  if (trimmedTail.length > 0) {
    statements.push({
      text: trimmedTail,
      startOffset: segmentStart + leadingWhitespaceLength,
    });
  }

  return statements;
}

function normalizeSqlWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function scanAlterActionEnd(source: string, startIndex: number): number {
  let depthParenthesis = 0;
  let depthSquare = 0;
  let index = startIndex;
  let inSingleQuote = false;

  while (index < source.length) {
    const character = source[index];

    if (inSingleQuote) {
      if (character === "'") {
        if (source[index + 1] === "'") {
          index += 2;
          continue;
        }
        inSingleQuote = false;
      }
      index += 1;
      continue;
    }

    if (character === '-' && source[index + 1] === '-') {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
      index += 1;
      continue;
    }
    if (character === '$') {
      index = skipDollarQuotedString(source, index);
      continue;
    }

    if (character === '(') depthParenthesis += 1;
    else if (character === ')') depthParenthesis = Math.max(0, depthParenthesis - 1);
    else if (character === '[') depthSquare += 1;
    else if (character === ']') depthSquare = Math.max(0, depthSquare - 1);
    else if (character === ',' && depthParenthesis === 0 && depthSquare === 0) return index;

    index += 1;
  }

  return source.length;
}

function violatesAddColumnNotNullWithoutDefault(statement: string): boolean {
  const lower = statement.toLowerCase();
  let from = 0;
  while (true) {
    const keywordIndex = lower.indexOf('add column', from);
    if (keywordIndex === -1) break;
    const clauseEnd = scanAlterActionEnd(statement, keywordIndex + 'add column'.length);
    const clause = statement.slice(keywordIndex, clauseEnd);
    const clauseLower = clause.toLowerCase();

    if (clauseLower.includes('set not null')) {
      from = clauseEnd + 1;
      continue;
    }

    if (clauseLower.includes('not null')) {
      const hasExplicitDefault = /\bdefault\b/i.test(clause);
      const hasGeneratedDefault =
        /\bgenerated\b/i.test(clause) || /\b(big)?serial\b/i.test(clauseLower);
      if (!(hasExplicitDefault || hasGeneratedDefault)) return true;
    }

    from = clauseEnd + 1;
  }
  return false;
}

/** Remove full-line SQL line comments so the first token is the DDL keyword. */
function removeFullLineDashDashComments(statementText: string): string {
  return statementText
    .split('\n')
    .filter((line) => !/^\s*--/u.test(line))
    .join('\n')
    .trim();
}

const leadingDdlKeywords = [
  'CREATE',
  'ALTER',
  'DROP',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
] as const;

function lowestKeywordIndexIgnoringCase(source: string): number | null {
  let bestIndex: number | null = null;
  for (const keyword of leadingDdlKeywords) {
    const searchIndex = source.toUpperCase().indexOf(keyword);
    if (searchIndex === -1) continue;
    const before = searchIndex === 0 ? ' ' : source.charAt(searchIndex - 1);
    const after =
      searchIndex + keyword.length >= source.length
        ? ' '
        : source.charAt(searchIndex + keyword.length);
    const beforeCharacterIsAlphanumericOrUnderscore = /[A-Z0-9_]/iu.test(before);
    const afterCharacterIsAlphanumericOrUnderscore = /[A-Z0-9_]/iu.test(after);
    if (beforeCharacterIsAlphanumericOrUnderscore || afterCharacterIsAlphanumericOrUnderscore)
      continue;
    if (bestIndex === null || searchIndex < bestIndex) {
      bestIndex = searchIndex;
    }
  }
  return bestIndex;
}

/**
 * Character index within `statementFullText` of the first top-level DDL keyword.
 * Full-line `--` comments are skipped; truncates each line at an inline `--` before matching.
 */
function characterIndexOfFirstDdlKeyword(statementFullText: string): number {
  const lines = statementFullText.split('\n');
  let statementCharacterOffset = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) {
      statementCharacterOffset += line.length + 1;
      continue;
    }

    let lineBody = line;
    const dashDashIndex = lineBody.indexOf('--');
    if (dashDashIndex !== -1) {
      lineBody = lineBody.slice(0, dashDashIndex);
    }

    const keywordIndex = lowestKeywordIndexIgnoringCase(lineBody);
    if (keywordIndex !== null) {
      return statementCharacterOffset + keywordIndex;
    }

    statementCharacterOffset += line.length + 1;
  }

  return 0;
}

function splitNormalizedWords(normalizedStatement: string): string[] {
  return normalizedStatement
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/** Uppercase comparator for PostgreSQL DDL keywords parsed from migrations. */
function upperKeyword(word: string): string {
  return word.toUpperCase();
}

function matchesCreateTableWithoutIfNotExists(normalizedStatement: string): boolean {
  const words = splitNormalizedWords(normalizedStatement).map(upperKeyword);
  if (words[0] !== 'CREATE') return false;
  let index = 1;
  if (words[index] === 'GLOBAL' || words[index] === 'LOCAL') index += 1;
  if (words[index] === 'TEMP' || words[index] === 'TEMPORARY') index += 1;
  if (words[index] === 'UNLOGGED') index += 1;
  if (words[index] !== 'TABLE') return false;
  index += 1;
  const hasIfNotExists =
    words[index] === 'IF' && words[index + 1] === 'NOT' && words[index + 2] === 'EXISTS';
  return !hasIfNotExists;
}

function matchesCreateSchemaWithoutIfNotExists(normalizedStatement: string): boolean {
  const words = splitNormalizedWords(normalizedStatement).map(upperKeyword);
  if (words[0] !== 'CREATE' || words[1] !== 'SCHEMA') return false;
  const hasIfNotExists = words[2] === 'IF' && words[3] === 'NOT' && words[4] === 'EXISTS';
  return !hasIfNotExists;
}

function parseCreateIndexPrefix(normalizedStatement: string): {
  isCreateIndex: boolean;
  hasConcurrently: boolean;
  hasIfNotExists: boolean;
} {
  const words = splitNormalizedWords(normalizedStatement).map(upperKeyword);
  if (words.length < 3 || words[0] !== 'CREATE') {
    return { isCreateIndex: false, hasConcurrently: false, hasIfNotExists: false };
  }
  let index = 1;
  if (words[index] === 'UNIQUE') index += 1;
  if (words[index] !== 'INDEX') {
    return { isCreateIndex: false, hasConcurrently: false, hasIfNotExists: false };
  }
  index += 1;
  let hasConcurrently = false;
  if (words[index] === 'CONCURRENTLY') {
    hasConcurrently = true;
    index += 1;
  }
  const hasIfNotExists =
    words[index] === 'IF' && words[index + 1] === 'NOT' && words[index + 2] === 'EXISTS';
  return {
    isCreateIndex: true,
    hasConcurrently,
    hasIfNotExists,
  };
}

/**
 * Recognises a `DROP INDEX ...` statement and reports whether it carries the
 * CONCURRENTLY modifier.
 *
 * @remarks
 * Mirrors {@link parseCreateIndexPrefix}: tolerates `DROP INDEX [CONCURRENTLY]
 * [IF EXISTS] <name>`. Used by the {@link drop_index_without_concurrently}
 * rule which flags plain `DROP INDEX` inside transactional migrations (those
 * hold an `ACCESS EXCLUSIVE` lock for the duration of the file's transaction,
 * blocking writers on the parent table).
 */
function parseDropIndexPrefix(normalizedStatement: string): {
  isDropIndex: boolean;
  hasConcurrently: boolean;
} {
  const words = splitNormalizedWords(normalizedStatement).map(upperKeyword);
  if (words.length < 2 || words[0] !== 'DROP' || words[1] !== 'INDEX') {
    return { isDropIndex: false, hasConcurrently: false };
  }
  const hasConcurrently = words[2] === 'CONCURRENTLY';
  return { isDropIndex: true, hasConcurrently };
}

function parseMigrationHeader(rawFileContent: string): ParsedHeader {
  const allows = new Map<MigrationSafetyRuleId, string>();
  const headerErrors: string[] = [];
  const lines = rawFileContent.split('\n');
  const headerLineCount = Math.min(20, lines.length);

  for (let lineIndex = 0; lineIndex < headerLineCount; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const trimmed = line.trimEnd().trim();
    if (!trimmed.startsWith('--')) continue;

    if (bareMigrationSafetyPattern.test(trimmed)) {
      headerErrors.push(
        `Line ${lineIndex + 1}: bare "migration-safety" comment is not allowed; use "-- migration-safety: allow <rule_id> reason=\\"...\\""`,
      );
      continue;
    }

    if (
      trimmed.toLowerCase().includes('migration-safety:') &&
      nonAllowMigrationSafetyPattern.test(trimmed)
    ) {
      headerErrors.push(
        `Line ${lineIndex + 1}: only "allow <rule_id> reason=\\"...\\"" overrides are permitted for migration-safety headers`,
      );
      continue;
    }

    const allowMatch = trimmed.match(headerAllowLinePattern);
    if (!allowMatch) continue;

    const ruleId = allowMatch[1]?.toLowerCase() ?? '';
    const reason = allowMatch[2]?.trim() ?? '';
    if (!migrationSafetyRuleIdSet.has(ruleId)) {
      headerErrors.push(
        `Line ${lineIndex + 1}: unknown migration-safety rule "${ruleId}". Valid: ${migrationSafetyRuleIds.join(', ')}`,
      );
      continue;
    }
    if (reason.length === 0) {
      headerErrors.push(
        `Line ${lineIndex + 1}: migration-safety allow override requires a non-empty reason`,
      );
      continue;
    }

    allows.set(ruleId as MigrationSafetyRuleId, reason);
  }

  return { allows, headerErrors };
}

function emitViolationIfNotAllowed(
  allows: Map<MigrationSafetyRuleId, string>,
  usedAllowRules: Set<MigrationSafetyRuleId>,
  ruleId: MigrationSafetyRuleId,
  filename: string,
  lineNumber: number,
): Violation | null {
  if (allows.has(ruleId)) {
    usedAllowRules.add(ruleId);
    return null;
  }
  return {
    filename,
    lineNumber,
    ruleId,
    message: ruleFixHints[ruleId],
  };
}

/**
 * Matches any SET / RESET of the `row_security` GUC (top-level statement,
 * SET LOCAL, function-attribute SET clause inside a CREATE FUNCTION header,
 * or inside a DO/function body) so the lint catches every form. RLS bypass
 * for trusted lookups must go through SECURITY DEFINER + ownership, not
 * the row_security session GUC.
 */
const rowSecurityGucPattern =
  /\b(?:SET\s+LOCAL\s+row_security\b|SET\s+SESSION\s+row_security\b|SET\s+row_security\b|RESET\s+row_security\b)/iu;

/** Splitter used by the migration runner to send each segment independently. */
const statementBreakpointPattern = /\n--> statement-breakpoint\s*\n?/g;

/**
 * Grandfathered filenames that pre-date the rule's introduction. Adding a file
 * here is the equivalent of `-- migration-safety: allow <rule>` for migrations
 * that were already applied to deployed environments before the rule existed
 * (modifying an already-applied migration would lie about history).
 *
 * @remarks
 * - **drop_index_without_concurrently:**
 *   `20260606010000_user_notif_prefs_drop_org_branch.sql` uses
 *   `DROP INDEX IF EXISTS auth.idx_user_notif_prefs_org` inside a transactional
 *   migration. The lock window was small (single-column dead index) and the
 *   correct-pattern follow-up `20260608060000_user_notif_prefs_drop_org_index_concurrently.sql`
 *   exists; we grandfather this one file rather than retroactively editing
 *   applied history.
 */
const ruleFilenameAllowlist: Partial<Record<MigrationSafetyRuleId, ReadonlySet<string>>> = {
  drop_index_without_concurrently: new Set<string>([
    '20260606010000_user_notif_prefs_drop_org_branch.sql',
  ]),
};

function isFilenameAllowlistedForRule(filename: string, ruleId: MigrationSafetyRuleId): boolean {
  return ruleFilenameAllowlist[ruleId]?.has(filename) ?? false;
}

/**
 * Flags non-transactional migrations whose `--> statement-breakpoint` segments
 * contain more than one statement. The runner sends each segment to Postgres as
 * a single command, so a segment with two statements becomes an implicit
 * transaction — and `CREATE INDEX CONCURRENTLY` cannot run inside one. Reports
 * each offending segment at the line of its second statement.
 */
function findNonTransactionalBreakpointViolations(
  filename: string,
  fileContent: string,
): Violation[] {
  const violations: Violation[] = [];
  let searchOffset = 0;

  for (const segment of fileContent.split(statementBreakpointPattern)) {
    const segmentStart = fileContent.indexOf(segment, searchOffset);
    searchOffset = segmentStart === -1 ? searchOffset : segmentStart + segment.length;

    const statements = splitSqlStatements(segment);
    if (statements.length <= 1) continue;

    const secondStatement = statements[1];
    const lineNumber =
      segmentStart === -1 || !secondStatement
        ? 1
        : offsetToLineNumber(fileContent, segmentStart + secondStatement.startOffset);
    violations.push({
      filename,
      lineNumber,
      ruleId: 'non_transactional_statements_need_breakpoints',
      message: ruleFixHints.non_transactional_statements_need_breakpoints,
    });
  }

  return violations;
}

/**
 * Migrations applied after the role taxonomy run under an RLS-subject migrator, so this rule
 * only binds them. Earlier files ran as a role that bypassed RLS and are historical record.
 */
const RLS_SUBJECT_MIGRATOR_SINCE = '20260827050000';

const dataWriteStatementPattern = /\b(insert\s+into|update|delete\s+from)\s/i;

/** SQL with `--` comments stripped, so prose that names a table is not mistaken for a statement. */
function stripSqlLineComments(fileContent: string): string {
  return fileContent
    .split('\n')
    .map((line) => {
      const commentIndex = line.indexOf('--');
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join('\n');
}

/**
 * Flags a data migration that touches a FORCE RLS table without lifting FORCE around it.
 *
 * @remarks
 * - **Why:** `core_be_migrator` is a member of `core_be_owner`, and FORCE ROW LEVEL SECURITY
 *   binds table owners — so the migrator is RLS-subject on data, by design. A write to a FORCE
 *   RLS table is rejected; a READ from one returns zero rows. The second is the dangerous case:
 *   an `INSERT ... SELECT` whose source is FORCE RLS inserts nothing and reports success.
 *   Hosted migrations run as a provider owner that bypasses RLS, so both pass there and fail
 *   only where the migrator is RLS-subject — which is exactly how
 *   `20260921000000_team_owner_notify_permissions_backfill` blocked every later migration.
 * - **Algorithm:** skip files before {@link RLS_SUBJECT_MIGRATOR_SINCE} and files with no data
 *   statement. Otherwise every FORCE RLS table named anywhere in the SQL — write target or read
 *   source — must be lifted with `NO FORCE` and re-applied with `FORCE` in the same file.
 * - **Notes:** the table list is {@link EXPECTED_FORCE_RLS_TABLES}, the same source the RLS
 *   matrix asserts against, so a newly forced table is covered here without a second list.
 */
function findForceRlsDataMigrationViolations(filename: string, fileContent: string): Violation[] {
  if (filename.slice(0, RLS_SUBJECT_MIGRATOR_SINCE.length) <= RLS_SUBJECT_MIGRATOR_SINCE) return [];
  const sqlOnly = stripSqlLineComments(fileContent);
  if (!dataWriteStatementPattern.test(sqlOnly)) return [];

  const violations: Violation[] = [];
  for (const { schemaName, tableName } of EXPECTED_FORCE_RLS_TABLES) {
    const qualified = `${schemaName}.${tableName}`;
    const escaped = qualified.replace('.', '\\.');
    if (!new RegExp(`\\b${escaped}\\b`, 'i').test(sqlOnly)) continue;
    const lifted = new RegExp(
      `alter\\s+table\\s+${escaped}\\s+no\\s+force\\s+row\\s+level\\s+security`,
      'i',
    ).test(sqlOnly);
    const reapplied = new RegExp(
      `alter\\s+table\\s+${escaped}\\s+force\\s+row\\s+level\\s+security`,
      'i',
    ).test(sqlOnly);
    if (lifted && reapplied) continue;
    violations.push({
      filename,
      lineNumber: 1,
      ruleId: 'force_rls_data_migration_without_owner_bracket',
      message: `${qualified}: ${ruleFixHints.force_rls_data_migration_without_owner_bracket}`,
    });
  }
  return violations;
}

function findRowSecurityGucViolations(filename: string, fileContent: string): Violation[] {
  const violations: Violation[] = [];
  const lines = fileContent.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? '';
    const commentIndex = rawLine.indexOf('--');
    const lineBody = commentIndex === -1 ? rawLine : rawLine.slice(0, commentIndex);
    if (!rowSecurityGucPattern.test(lineBody)) continue;
    violations.push({
      filename,
      lineNumber: lineIndex + 1,
      ruleId: 'disable_row_security_guc',
      message: ruleFixHints.disable_row_security_guc,
    });
  }
  return violations;
}

/**
 * Runs the full migration safety rule set against a single SQL file's text and
 * returns every violation. Header-level `-- migration-safety: allow <ruleId>`
 * comments suppress matching rules. Used by `pnpm db:migrate:lint` and unit
 * tests.
 */
export function lintMigrationFileContent(
  filename: string,
  fileContent: string,
): {
  violations: Violation[];
  headerErrors: string[];
  usedAllowRules: Set<MigrationSafetyRuleId>;
} {
  const violations: Violation[] = [];
  const { allows, headerErrors } = parseMigrationHeader(fileContent);
  const executionMode = parseMigrationExecutionMode(fileContent);
  const combinedHeaderErrors = [...headerErrors, ...executionMode.headerErrors];
  const usedAllowRules = new Set<MigrationSafetyRuleId>();

  if (combinedHeaderErrors.length > 0) {
    return { violations, headerErrors: combinedHeaderErrors, usedAllowRules };
  }

  if (!executionMode.transactional) {
    violations.push(...findNonTransactionalBreakpointViolations(filename, fileContent));
  }

  violations.push(...findRowSecurityGucViolations(filename, fileContent));
  violations.push(...findForceRlsDataMigrationViolations(filename, fileContent));

  const statements = splitSqlStatements(fileContent);

  for (const statement of statements) {
    const statementWithoutFullLineComments = removeFullLineDashDashComments(statement.text);
    if (statementWithoutFullLineComments.length === 0) continue;

    const keywordRelativeCharacterIndex = characterIndexOfFirstDdlKeyword(statement.text);
    const lineNumber = offsetToLineNumber(
      fileContent,
      statement.startOffset + keywordRelativeCharacterIndex,
    );
    const normalized = normalizeSqlWhitespace(statementWithoutFullLineComments);
    if (normalized.length === 0) continue;

    if (violatesAddColumnNotNullWithoutDefault(statementWithoutFullLineComments)) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'add_column_not_null_without_default',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (/\bALTER\s+TABLE\b.*\bRENAME\b/iu.test(normalized)) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'rename_column_or_table',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (/\bDROP\s+COLUMN\b/iu.test(normalized)) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'drop_column',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (/\bALTER\s+COLUMN\b.*\bTYPE\b/iu.test(normalized)) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'alter_column_type',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (/\bSET\s+NOT\s+NULL\b/iu.test(normalized)) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'set_not_null_on_existing_column',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    const createIndexInfo = parseCreateIndexPrefix(normalized);
    if (createIndexInfo.isCreateIndex) {
      if (createIndexInfo.hasConcurrently && executionMode.transactional) {
        violations.push({
          filename,
          lineNumber,
          ruleId: 'concurrent_index_requires_non_transactional',
          message: ruleFixHints.concurrent_index_requires_non_transactional,
        });
      }
      if (!createIndexInfo.hasConcurrently) {
        const violation = emitViolationIfNotAllowed(
          allows,
          usedAllowRules,
          'create_index_without_concurrently',
          filename,
          lineNumber,
        );
        if (violation) violations.push(violation);
      }
      if (!createIndexInfo.hasIfNotExists) {
        const violation = emitViolationIfNotAllowed(
          allows,
          usedAllowRules,
          'missing_if_not_exists_on_create',
          filename,
          lineNumber,
        );
        if (violation) violations.push(violation);
      }
    }

    // DROP INDEX must use CONCURRENTLY inside a transactional migration —
    // sec-r4-D5 follow-up. Pre-existing transactional migrations are
    // grandfathered via `ruleFilenameAllowlist`.
    const dropIndexInfo = parseDropIndexPrefix(normalized);
    if (
      dropIndexInfo.isDropIndex &&
      !dropIndexInfo.hasConcurrently &&
      executionMode.transactional &&
      !isFilenameAllowlistedForRule(filename, 'drop_index_without_concurrently')
    ) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'drop_index_without_concurrently',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (matchesCreateTableWithoutIfNotExists(normalized)) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'missing_if_not_exists_on_create',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (matchesCreateSchemaWithoutIfNotExists(normalized)) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'missing_if_not_exists_on_create',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (/\bDROP\s+TABLE\b/iu.test(normalized)) {
      const hasIfExists = /\bDROP\s+TABLE\s+IF\s+EXISTS\b/iu.test(normalized);
      if (!hasIfExists) {
        violations.push({
          filename,
          lineNumber,
          ruleId: 'drop_table',
          message:
            'DROP TABLE without IF EXISTS is not allowed. Add IF EXISTS or avoid destructive DDL.',
        });
      } else {
        const violation = emitViolationIfNotAllowed(
          allows,
          usedAllowRules,
          'drop_table',
          filename,
          lineNumber,
        );
        if (violation) violations.push(violation);
      }
    }

    if (
      /\bALTER\s+TABLE\b/iu.test(normalized) &&
      /\bADD\s+CONSTRAINT\b/iu.test(normalized) &&
      /\bFOREIGN\s+KEY\b/iu.test(normalized) &&
      !/\bNOT\s+VALID\b/iu.test(normalized)
    ) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'add_foreign_key_without_not_valid',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (
      /\bALTER\s+TABLE\b/iu.test(normalized) &&
      /\bADD\s+CONSTRAINT\b/iu.test(normalized) &&
      /\bCHECK\s*\(/iu.test(normalized) &&
      !/\bFOREIGN\s+KEY\b/iu.test(normalized) &&
      !/\bPRIMARY\s+KEY\b/iu.test(normalized) &&
      !/\bUNIQUE\b/iu.test(normalized) &&
      !/\bNOT\s+VALID\b/iu.test(normalized)
    ) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'add_check_without_not_valid',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }

    if (
      /\bALTER\s+TABLE\b/iu.test(normalized) &&
      /\bADD\s+CONSTRAINT\b/iu.test(normalized) &&
      /\bUNIQUE\s*\(/iu.test(normalized) &&
      !/\bPRIMARY\s+KEY\b/iu.test(normalized) &&
      !/\bFOREIGN\s+KEY\b/iu.test(normalized)
    ) {
      const violation = emitViolationIfNotAllowed(
        allows,
        usedAllowRules,
        'add_unique_constraint_inline',
        filename,
        lineNumber,
      );
      if (violation) violations.push(violation);
    }
  }

  return { violations, headerErrors: combinedHeaderErrors, usedAllowRules };
}

/** A single failure from {@link lintMigrationRollbackPairing}. */
export type RollbackViolation = {
  filename: string;
  ruleId: 'missing_required_down_migration' | 'orphan_down_migration';
  message: string;
};

const migrationRollbackHeaderPattern =
  /--\s*migration-rollback:\s*requires\s+down\s+reason="([^"]*)"/i;

/**
 * Parses the optional `-- migration-rollback: requires down reason="..."`
 * header from the first five lines of a migration file. The header marks an
 * up-migration as requiring a paired `.down.sql` companion.
 */
export function parseMigrationRollbackHeader(fileContent: string): {
  requiresDown: boolean;
  headerErrors: string[];
} {
  const headerWindow = fileContent.split('\n').slice(0, 5).join('\n');
  const match = migrationRollbackHeaderPattern.exec(headerWindow);
  if (!match) {
    return { requiresDown: false, headerErrors: [] };
  }
  const reason = match[1] ?? '';
  if (reason.trim().length === 0) {
    return {
      requiresDown: false,
      headerErrors: ['migration-rollback header requires a non-empty reason="..."'],
    };
  }
  return { requiresDown: true, headerErrors: [] };
}

function isDownMigrationFilename(filename: string): boolean {
  return filename.endsWith('.down.sql');
}

/** Identifiers of every rule {@link lintMigrationTimestamps} can report. */
export const migrationTimestampRuleIds = [
  'migration_filename_format',
  'migration_timestamp_not_monotonic',
  'migration_timestamp_far_future',
  'migration_timestamp_gap',
] as const;

/** String-literal union of every migration timestamp rule id. */
export type MigrationTimestampRuleId = (typeof migrationTimestampRuleIds)[number];

/** A single failure from {@link lintMigrationTimestamps}; `severity` controls whether CI fails or just warns. */
export type TimestampViolation = {
  filename: string;
  ruleId: MigrationTimestampRuleId;
  message: string;
  severity: 'error' | 'warning';
};

const upMigrationFilenamePattern = /^(\d{14})_[a-z0-9_]+\.sql$/;

const timestampFarFutureWindowMs = 7 * 24 * 60 * 60 * 1000;
const migrationTimestampGapWarningDays = 90;

/** Extracts the 14-digit ordering prefix from an up-migration filename, or null if invalid. */
export function extractMigrationPrefix(filename: string): string | null {
  const match = upMigrationFilenamePattern.exec(filename);
  return match?.[1] ?? null;
}

/** Returns the greatest valid prefix among up-migration filenames, or null when none are valid. */
export function getMaxMigrationPrefix(upMigrationFilenames: string[]): string | null {
  let maxPrefix: string | null = null;
  for (const filename of upMigrationFilenames) {
    const prefix = extractMigrationPrefix(filename);
    if (prefix === null) continue;
    if (maxPrefix === null || prefix > maxPrefix) {
      maxPrefix = prefix;
    }
  }
  return maxPrefix;
}

/**
 * Suggests the next migration prefix using the real UTC wall clock.
 *
 * Always returns the current UTC time formatted as `YYYYMMDDHHMMSS` so
 * concurrent developers on different branches naturally land on distinct
 * prefixes and avoid the merge conflict that comes from incrementing a shared
 * counter. `currentMax` is returned for display/diagnostics only; the
 * monotonic-ordering invariant is enforced separately by
 * `lintMigrationTimestamps` (`pnpm db:migrate:lint`).
 *
 * `now` is injectable for deterministic tests.
 */
export function suggestNextMigrationPrefix(
  upMigrationFilenames: string[],
  now: Date = new Date(),
): {
  currentMax: string | null;
  nextPrefix: string;
} {
  const currentMax = getMaxMigrationPrefix(upMigrationFilenames);
  return { currentMax, nextPrefix: formatTimestampPrefix(now) };
}

function parsePrefixDateUtc(prefix: string): Date {
  const year = prefix.slice(0, 4);
  const month = prefix.slice(4, 6);
  const day = prefix.slice(6, 8);
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
}

function daysBetweenPrefixDates(previousPrefix: string, prefix: string): number {
  const previousDate = parsePrefixDateUtc(previousPrefix);
  const currentDate = parsePrefixDateUtc(prefix);
  return Math.abs(currentDate.getTime() - previousDate.getTime()) / (24 * 60 * 60 * 1000);
}

/** Formats a Date as a 14-digit UTC `YYYYMMDDHHMMSS` migration ordering prefix. */
export function formatTimestampPrefix(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
}

/** Validates up-migration filename prefixes (YYYYMMDDHHMMSS_snake_case.sql) and monotonic ordering. */
export function lintMigrationTimestamps(upMigrationFilenames: string[]): TimestampViolation[] {
  const violations: TimestampViolation[] = [];
  const sortedFilenames = [...upMigrationFilenames].sort((a, b) => a.localeCompare(b));
  const farFutureThreshold = formatTimestampPrefix(
    new Date(Date.now() + timestampFarFutureWindowMs),
  );

  let previousPrefix: string | null = null;

  for (const filename of sortedFilenames) {
    const match = upMigrationFilenamePattern.exec(filename);
    if (!match) {
      violations.push({
        filename,
        ruleId: 'migration_filename_format',
        message:
          'Up migration filename must match YYYYMMDDHHMMSS_snake_case.sql (14-digit UTC ordering prefix).',
        severity: 'error',
      });
      continue;
    }

    const prefix = match[1];
    if (prefix === undefined) {
      continue;
    }
    if (previousPrefix !== null && prefix <= previousPrefix) {
      violations.push({
        filename,
        ruleId: 'migration_timestamp_not_monotonic',
        message: `Timestamp prefix ${prefix} must be strictly greater than the previous migration prefix ${previousPrefix}.`,
        severity: 'error',
      });
    }
    if (prefix > farFutureThreshold) {
      violations.push({
        filename,
        ruleId: 'migration_timestamp_far_future',
        message: `Timestamp prefix ${prefix} is more than 7 days ahead of now (check for a typo in the date).`,
        severity: 'warning',
      });
    }
    if (previousPrefix !== null) {
      const gapDays = daysBetweenPrefixDates(previousPrefix, prefix);
      if (gapDays > migrationTimestampGapWarningDays) {
        violations.push({
          filename,
          ruleId: 'migration_timestamp_gap',
          message: `Date portion of prefix jumps ${Math.round(gapDays)} days from ${previousPrefix.slice(0, 8)} to ${prefix.slice(0, 8)}. Ordering is lexicographic on the 14-digit prefix, not calendar write order — use pnpm db:migrate:next-prefix for the next filename.`,
          severity: 'warning',
        });
      }
    }
    previousPrefix = prefix;
  }

  return violations;
}

/**
 * Cross-checks up- and down-migration filenames: every up-migration with a
 * `migration-rollback: requires down` header must have a paired
 * `<prefix>_<name>.down.sql` companion, and orphan `.down.sql` files (no
 * matching up) are reported.
 */
export function lintMigrationRollbackPairing(
  _migrationsFolder: string,
  upMigrationFilenames: string[],
  fileContentsByFilename: Map<string, string>,
): RollbackViolation[] {
  const violations: RollbackViolation[] = [];
  const allFilenames = [...fileContentsByFilename.keys()];

  for (const upFilename of upMigrationFilenames) {
    const fileContent = fileContentsByFilename.get(upFilename);
    if (fileContent === undefined) continue;
    const { requiresDown, headerErrors } = parseMigrationRollbackHeader(fileContent);
    if (headerErrors.length > 0) continue;
    if (requiresDown) {
      const downFilename = upFilename.replace(/\.sql$/i, '.down.sql');
      if (!allFilenames.includes(downFilename)) {
        violations.push({
          filename: upFilename,
          ruleId: 'missing_required_down_migration',
          message: `Missing required companion ${downFilename}`,
        });
      }
    }
  }

  for (const filename of allFilenames) {
    if (!isDownMigrationFilename(filename)) continue;
    const upFilename = filename.replace(/\.down\.sql$/i, '.sql');
    if (!allFilenames.includes(upFilename)) {
      violations.push({
        filename,
        ruleId: 'orphan_down_migration',
        message: `Orphan down migration without up file ${upFilename}`,
      });
    }
  }

  return violations;
}

/**
 * Reads every `.sql` file in `migrationsFolder` and runs the full safety,
 * timestamp, and rollback-pairing rule sets. Returns aggregated violations
 * keyed by category so the CLI / CI can render a single report and exit
 * non-zero on any error-severity finding.
 */
export async function lintMigrationsDirectory(migrationsFolder: string): Promise<{
  allViolations: Violation[];
  rollbackViolations: RollbackViolation[];
  timestampViolations: TimestampViolation[];
  filesScanned: number;
  headerFailureCount: number;
}> {
  const allFiles = await readdir(migrationsFolder);
  const sqlFiles = allFiles
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  const upMigrationFilenames = sqlFiles.filter((filename) => !isDownMigrationFilename(filename));
  const fileContentsByFilename = new Map<string, string>();

  const allViolations: Violation[] = [];
  let filesScanned = 0;
  let headerFailureCount = 0;

  for (const filename of sqlFiles) {
    const fullPath = resolve(migrationsFolder, filename);
    const fileContent = await readFile(fullPath, 'utf8');
    fileContentsByFilename.set(filename, fileContent);
    filesScanned += 1;

    if (isDownMigrationFilename(filename)) {
      continue;
    }

    const { violations, headerErrors } = lintMigrationFileContent(filename, fileContent);

    if (headerErrors.length > 0) {
      headerFailureCount += headerErrors.length;
      for (const message of headerErrors) {
        console.error(chalk.red(`${filename}: ${message}`));
      }
      continue;
    }

    allViolations.push(...violations);

    for (const violation of violations) {
      console.error(
        chalk.red(`${violation.filename}:${violation.lineNumber}  [${violation.ruleId}]`),
      );
      console.error(`  ${violation.message}`);
    }
  }

  const summaryPieces = [
    `${allViolations.length} violation(s)`,
    `${filesScanned} migration file(s) scanned`,
  ];
  if (headerFailureCount > 0) {
    summaryPieces.push(`${headerFailureCount} header error(s)`);
  }
  const rollbackViolations = lintMigrationRollbackPairing(
    migrationsFolder,
    upMigrationFilenames,
    fileContentsByFilename,
  );

  for (const violation of rollbackViolations) {
    console.error(chalk.red(`${violation.filename}  [${violation.ruleId}]`));
    console.error(`  ${violation.message}`);
  }

  if (rollbackViolations.length > 0) {
    summaryPieces.push(`${rollbackViolations.length} rollback violation(s)`);
  }

  const timestampViolations = lintMigrationTimestamps(upMigrationFilenames);
  const timestampErrors = timestampViolations.filter((violation) => violation.severity === 'error');
  const timestampWarnings = timestampViolations.filter(
    (violation) => violation.severity === 'warning',
  );

  for (const violation of timestampErrors) {
    console.error(chalk.red(`${violation.filename}  [${violation.ruleId}]`));
    console.error(`  ${violation.message}`);
  }
  for (const violation of timestampWarnings) {
    console.error(chalk.yellow(`${violation.filename}  [${violation.ruleId}]`));
    console.error(`  ${violation.message}`);
  }

  if (timestampErrors.length > 0) {
    summaryPieces.push(`${timestampErrors.length} timestamp error(s)`);
  }
  if (timestampWarnings.length > 0) {
    summaryPieces.push(`${timestampWarnings.length} timestamp warning(s)`);
  }

  console.log(`\nSummary: ${summaryPieces.join(', ')}.`);

  return {
    allViolations,
    rollbackViolations,
    timestampViolations,
    filesScanned,
    headerFailureCount,
  };
}

async function main(): Promise<void> {
  const migrationsArgument = process.argv[2];
  const migrationsFolder = migrationsArgument
    ? resolve(process.cwd(), migrationsArgument)
    : resolve(process.cwd(), 'migrations');

  const { allViolations, rollbackViolations, timestampViolations, headerFailureCount } =
    await lintMigrationsDirectory(migrationsFolder);
  const timestampErrors = timestampViolations.filter((violation) => violation.severity === 'error');
  if (
    allViolations.length > 0 ||
    rollbackViolations.length > 0 ||
    timestampErrors.length > 0 ||
    headerFailureCount > 0
  ) {
    process.exit(1);
  }
}

const currentScriptPath = resolve(fileURLToPath(import.meta.url));
const invokedEntryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isDirectExecution = invokedEntryPath === currentScriptPath;
if (isDirectExecution) {
  void main();
}
