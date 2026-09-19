/**
 * Policy: the cross-domain audit surface is a PINNED, reviewed set.
 *
 * Audit emission is deliberately narrow — the audit domain owns the log tables,
 * and only a handful of places outside it may import `@/domains/audit/*`
 * (the composition plugin that wires the container, plus the two features that
 * expose or emit audit data). Pinning the set exactly means:
 *
 * - REMOVING an import (dropping an audit trail or the audit-log endpoint) is a
 *   visible, deliberate change — an audit trail cannot vanish in a refactor.
 * - ADDING an import (a new audit emission or read surface) gets reviewed here
 *   instead of growing silently.
 *
 * Same pattern as `public-route-allowlist.global.test.ts`: exact-set equality,
 * so drift in either direction fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const DOMAINS_ROOT = join(PROJECT_ROOT, 'src/domains');
const AUDIT_IMPORT_PREFIX = ['from ', "'@/domains/audit/"].join('');

/**
 * The reviewed cross-domain audit surface. Every entry says what it uses audit
 * for; update the list (and this comment discipline) when the surface changes.
 */
const REVIEWED_AUDIT_IMPORTERS = new Set<string>([
  // Composition plugin: wires the audit container into the other domain containers.
  'src/domains/domain-containers.plugin.ts',
  // GET /organization/audit-logs — organization-scoped audit-log read endpoint.
  'src/domains/tenancy/sub-domains/organization/organization.controller.ts',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts',
  // GDPR data-export bundles include the user's actor-scoped audit rows.
  'src/domains/user/sub-domains/user-data-export/user-data-export.service.ts',
]);

function collectAuditImporters(directory: string, accumulator: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__' || entry === 'seed') continue;
      // The audit domain itself may import its own modules freely.
      if (fullPath === join(DOMAINS_ROOT, 'audit')) continue;
      collectAuditImporters(fullPath, accumulator);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue;
    const source = readFileSync(fullPath, 'utf8');
    if (source.includes(AUDIT_IMPORT_PREFIX)) {
      accumulator.push(relative(PROJECT_ROOT, fullPath));
    }
  }
  return accumulator;
}

describe('Global: cross-domain audit surface pinning', () => {
  const importers = new Set(collectAuditImporters(DOMAINS_ROOT));

  it('exactly the reviewed set of non-audit domain files imports @/domains/audit', () => {
    const unexpected = [...importers].filter((file) => !REVIEWED_AUDIT_IMPORTERS.has(file));
    const missing = [...REVIEWED_AUDIT_IMPORTERS].filter((file) => !importers.has(file));
    expect(
      unexpected,
      'New cross-domain audit import — a new audit emission/read surface must be reviewed: ' +
        'add it to REVIEWED_AUDIT_IMPORTERS with a comment saying what it uses audit for.',
    ).toEqual([]);
    expect(
      missing,
      'A reviewed audit importer disappeared — an audit trail or audit read surface was ' +
        'dropped. If deliberate, remove the entry; if not, restore the emission.',
    ).toEqual([]);
  });
});
