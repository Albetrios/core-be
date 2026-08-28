import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * sec-r5-architecture: enforce the codebase rule that
 *   "only repositories own the DB connection — services / controllers / utils
 *    may use `with*DatabaseContext` orchestration helpers but MUST go through
 *    a repository for the actual SQL."
 *
 * Until 2026-06-08 the rule lived only in `CLAUDE.md`; a single util
 * (`stripe-webhook-organization.util.ts`) had drifted to call raw `sql\`\``.
 * This test prevents the drift from happening again:
 *
 * Walks every `.ts` file under `src/domains/**` that is NOT a repository,
 * NOT a schema, NOT a test, NOT a seed. Fails if any such file imports one
 * of the DB-query primitives — the `database` connection singleton, the
 * raw postgres-js `sql` template, or `getRequestDatabase`. Context wrappers
 * (`withAppDatabaseContext`, `withMaintenanceDatabaseContext`,
 * `withTransaction`, etc.) and DB-handle TYPES are allowed because they
 * model service-layer orchestration; the SQL queries they wrap still go
 * through repositories.
 */
describe('Global: no direct DB-query primitives outside repositories (sec-r5-architecture)', () => {
  const FORBIDDEN_IMPORT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    {
      name: '`database` singleton from connection.js',
      pattern:
        /from\s+['"]@\/infrastructure\/database\/connection\.js['"][\s\S]*?\{[^}]*\bdatabase\b/g,
    },
    {
      name: 'raw `sql` tagged-template from connection.js',
      pattern: /from\s+['"]@\/infrastructure\/database\/connection\.js['"][\s\S]*?\{[^}]*\bsql\b/g,
    },
    {
      name: 'getRequestDatabase() from request-database.context.js',
      pattern: /\bgetRequestDatabase\b/g,
    },
  ];

  /**
   * Files that are intentionally allowed to import the DB primitives. Adding
   * a file here requires a comment explaining WHY the architecture rule does
   * not apply (typically: this file IS a repository / schema / migration
   * runner / context wrapper / very narrow infra glue).
   */
  const REPOSITORY_OR_SCHEMA_SUFFIXES = ['.repository.ts', '.schema.ts'];

  const JUSTIFIED_NON_REPO_DOMAIN_FILES = new Set<string>([
    // Each of these is a domain-level infra adapter that legitimately owns a
    // DB session / handle wiring; they are NOT services issuing queries.
    // Listed individually so any new addition gets reviewed.
    // (Empty today — every previously-direct call has been migrated to a
    // repository. If you must add a file, document why here.)
  ]);

  const SKIP_DIRECTORIES = new Set<string>([
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.git',
    '__tests__',
    '__snapshots__',
    'seed',
  ]);

  async function* walkDomainFiles(root: string): AsyncGenerator<string> {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        yield* walkDomainFiles(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      // Repositories and schemas are the ONLY files allowed to touch the
      // DB-query primitives directly.
      if (REPOSITORY_OR_SCHEMA_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      yield entryPath;
    }
  }

  it('forbids `database` / `sql` / `getRequestDatabase` outside repositories', async () => {
    const repositoryRoot = process.cwd();
    const domainsRoot = join(repositoryRoot, 'src', 'domains');
    const violations: string[] = [];

    for await (const absolutePath of walkDomainFiles(domainsRoot)) {
      const relativePath = relative(repositoryRoot, absolutePath);
      if (JUSTIFIED_NON_REPO_DOMAIN_FILES.has(relativePath)) continue;

      const fileText = await fs.readFile(absolutePath, 'utf8');

      for (const { name, pattern } of FORBIDDEN_IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(fileText)) {
          violations.push(`  ${relativePath} — uses ${name}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found direct DB-query usage outside a repository — violates the codebase architecture rule (CLAUDE.md):\n${violations.join('\n')}\n\nFix: move the query to the relevant *.repository.ts and have the caller invoke the repository method instead. OR add the file to JUSTIFIED_NON_REPO_DOMAIN_FILES with a comment explaining why this is unavoidable.`,
      );
    }
    expect(violations).toEqual([]);
  });

  /**
   * Closes the gap that let `resolve-active-organization.ts` build a full `.select().from()` query
   * inline on the login path while still passing the check above (it imported `sql` from
   * `drizzle-orm` + a context wrapper, not from `connection.js`). Request-path domain files MUST
   * delegate SQL to a repository. Only repositories (`.repository.ts`, already skipped by the walk)
   * and the async maintenance layer (`*.worker.ts` / `*.processor.ts`, which bind a context handle
   * for retention jobs) may import the `drizzle-orm` query builder.
   */
  it('forbids drizzle-orm query builders in request-path domain files (only repositories and workers/processors may build SQL)', async () => {
    const repositoryRoot = process.cwd();
    const domainsRoot = join(repositoryRoot, 'src', 'domains');
    const DRIZZLE_ORM_IMPORT = /from\s+['"]drizzle-orm['"]/;
    const violations: string[] = [];

    for await (const absolutePath of walkDomainFiles(domainsRoot)) {
      const relativePath = relative(repositoryRoot, absolutePath);
      if (relativePath.endsWith('.worker.ts') || relativePath.endsWith('.processor.ts')) continue;

      const fileText = await fs.readFile(absolutePath, 'utf8');
      if (DRIZZLE_ORM_IMPORT.test(fileText)) {
        violations.push(
          `  ${relativePath} — imports the drizzle-orm query builder outside a repository`,
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found drizzle-orm query construction in request-path files — violates the codebase architecture rule (CLAUDE.md: only repositories own the actual SQL):\n${violations.join('\n')}\n\nFix: move the query into the relevant *.repository.ts and call the repository method from here.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
