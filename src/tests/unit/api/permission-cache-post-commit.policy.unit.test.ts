/**
 * Policy (audit R11): permission-cache invalidation MUST run AFTER the write transaction commits,
 * i.e. OUTSIDE the `withPrincipalDatabaseContext(...)` callback — never inside it.
 *
 * Invalidating inside the callback (pre-commit) opens a race: a concurrent permission recompute for
 * the affected user reads the OLD committed permission set and re-caches it before the writer
 * commits, so a downgraded/removed member keeps access (or a newly-granted one is delayed) until the
 * cache TTL (~5 min). `AuditService`-style emitters and the org-delete path already invalidate after
 * the context block; this guard keeps every tenancy mutation consistent and prevents regressions.
 *
 * The scan strips comments and string/template literals, then asserts no `invalidatePermissions(`,
 * `invalidateOrganizationPermissions(`, or `invalidatePermissionsForMembership(` call appears inside
 * any `withPrincipalDatabaseContext(...)` call expression.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const TENANCY_ROOT = join(PROJECT_ROOT, 'src/domains/tenancy');

const INVALIDATION_CALLS = [
  'invalidatePermissions(',
  'invalidateOrganizationPermissions(',
  'invalidatePermissionsForMembership(',
];

function collectServiceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      collectServiceFiles(fullPath, collected);
    } else if (entry.endsWith('.service.ts')) {
      collected.push(fullPath);
    }
  }
  return collected;
}

/** Blanks comments and string/template literals so braces/parens/identifiers inside them are ignored. */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Returns the body spans (paren-balanced) of every `withPrincipalDatabaseContext(...)` call. */
function organizationContextCallSpans(source: string): string[] {
  const spans: string[] = [];
  const marker = 'withPrincipalDatabaseContext(';
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 0;
    let index = start + marker.length - 1; // position of the opening '('
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push(source.slice(start, index + 1));
    searchFrom = index + 1;
  }
  return spans;
}

describe('Policy: permission-cache invalidation runs post-commit (audit R11)', () => {
  const files = collectServiceFiles(TENANCY_ROOT);

  it('scans at least the known tenancy services', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    const relativePath = relative(PROJECT_ROOT, file);
    it(`no permission-cache invalidation inside a withPrincipalDatabaseContext callback — ${relativePath}`, () => {
      const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      const offenders: string[] = [];
      for (const span of organizationContextCallSpans(stripped)) {
        for (const call of INVALIDATION_CALLS) {
          if (span.includes(call)) offenders.push(call);
        }
      }
      expect(
        offenders,
        `${relativePath}: ${offenders.join(', ')} called INSIDE withPrincipalDatabaseContext — ` +
          'move the invalidation AFTER the context block (post-commit) to avoid the stale re-cache race.',
      ).toEqual([]);
    });
  }
});
