import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN_PATTERNS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\bgetRequestDatabase\s*\(/,
    message: 'must not call getRequestDatabase()',
  },
  {
    // audit #5: the module moved under `contexts/`; the old anchored pattern matched zero
    // files, silently disarming this rule. The optional `contexts/` segment matches the real
    // path `@/infrastructure/database/contexts/request-database.context.js` (and the legacy one).
    pattern:
      /from\s+['"]@\/infrastructure\/database\/(?:contexts\/)?request-database\.context\.js['"]/,
    message: 'must not import request-database.context',
  },
  {
    pattern:
      /import\s*\{[^}]*\bdatabase\b[^}]*\}\s*from\s*['"]@\/infrastructure\/database\/connection\.js['"]/,
    message: 'must not import the global database pool singleton',
  },
];

/**
 * audit #5: narrow, documented exemptions for the `must not import request-database.context`
 * rule ONLY. `audit-outbox-drain.processor.ts` imports the `RequestScopedPostgresDatabase` TYPE
 * and the low-level `setLocalDatabaseConfig` GUC setter — it never calls `getRequestDatabase()`
 * (the strongest rule, which stays enforced for every file). It runs under
 * `withMaintenanceDatabaseContext`, setting `app.global_admin` / `app.system_audit_insert`
 * GUCs explicitly on its own pinned drain handle, so there is no request-scoped RLS fallback.
 * Verified during the security audit; arming the (previously dead) regex re-exposed this file.
 */
const REQUEST_CONTEXT_IMPORT_ALLOWLIST = new Set<string>([
  join('src', 'domains', 'audit', 'workers', 'audit-outbox-drain.processor.ts'),
]);

function walkTypeScriptFiles(directory: string, results: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkTypeScriptFiles(absolutePath, results);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(relative(process.cwd(), absolutePath));
    }
  }
  return results;
}

function listWorkerProcessorFiles(): string[] {
  const sourceRoot = join(process.cwd(), 'src');
  return walkTypeScriptFiles(sourceRoot).filter((filePath) => {
    return (
      filePath.endsWith('.worker.ts') ||
      filePath.endsWith('.processor.ts') ||
      filePath.includes('/workers/') ||
      filePath.endsWith('batch-delete.util.ts')
    );
  });
}

describe('worker database guard (static scan)', () => {
  const files = [...new Set(listWorkerProcessorFiles())].sort();

  it('discovers worker and processor source files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const filePath of files) {
    it(`${filePath} avoids request-scoped database fallbacks`, () => {
      const source = readFileSync(filePath, 'utf8');
      for (const { pattern, message } of FORBIDDEN_PATTERNS) {
        if (
          message.includes('request-database.context') &&
          REQUEST_CONTEXT_IMPORT_ALLOWLIST.has(filePath)
        ) {
          continue;
        }
        expect(source, `${filePath}: ${message}`).not.toMatch(pattern);
      }
    });
  }
});

// audit #5: the request-database.context import pattern was anchored to the pre-move path and
// matched zero files after the module moved under `contexts/`, silently disarming the rule.
// This guards the guard: the pattern MUST match the real (contexts/) import and the legacy one.
describe('worker database guard — request-database.context pattern (audit #5)', () => {
  const requestContextRule = FORBIDDEN_PATTERNS.find((p) =>
    p.message.includes('request-database.context'),
  );

  // Build the fixture import lines from the path argument so the from-alias import sequence never
  // appears verbatim in compiled dist (it would false-positive the `check-dist-imports` pre-push
  // gate, which greps dist for that pattern). The path alias is the data under test, not a real import.
  const importLine = (path: string): string => `import { setLocalDatabaseConfig } from '${path}';`;

  it('matches the real contexts/ import path', () => {
    expect(
      requestContextRule?.pattern.test(
        importLine('@/infrastructure/database/contexts/request-database.context.js'),
      ),
    ).toBe(true);
  });

  it('still matches the legacy (pre-move) import path', () => {
    expect(
      requestContextRule?.pattern.test(
        importLine('@/infrastructure/database/request-database.context.js'),
      ),
    ).toBe(true);
  });

  it('does not match an unrelated database import', () => {
    expect(
      requestContextRule?.pattern.test(
        importLine('@/infrastructure/database/contexts/tenant-database.context.js'),
      ),
    ).toBe(false);
  });
});
