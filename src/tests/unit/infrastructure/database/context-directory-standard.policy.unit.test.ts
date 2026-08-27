import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE STANDARD: `src/infrastructure/database/contexts/` holds exactly TWO files —
 * `database-context.ts` (the three scope patterns: principal / session /
 * maintenance) and
 * `database-context-runtime.ts` (non-scope plumbing). A new way to open an
 * RLS-scoped database context is a new KIND inside one of the three registries,
 * never a new file/wrapper. Adding a file here means either extending a pattern
 * (wrong — add a kind) or inventing a fourth pattern (a design decision that
 * must be made deliberately, by editing this test).
 */
const SCOPE_PATTERN_FILES = ['database-context.ts'] as const;

/** Non-scope plumbing: ALS storages, worker-kind assertions, timeout lift, handle guards. */
const PLUMBING_FILES = ['database-context-runtime.ts'] as const;

/*
 * The legacy identity-family wrappers (organization/tenant/user/retention
 * context files) were fully absorbed into the principal + maintenance
 * registries in Phase 7.5 and DELETED. None of those filenames may return.
 */

describe('context directory standard — three scope patterns only', () => {
  const contextsDirectory = join(process.cwd(), 'src', 'infrastructure', 'database', 'contexts');

  it('contains only the three scope patterns and plumbing', () => {
    const allowed = new Set<string>([...SCOPE_PATTERN_FILES, ...PLUMBING_FILES]);
    const actual = readdirSync(contextsDirectory).filter((name) => name.endsWith('.ts'));

    const unexpected = actual.filter((name) => !allowed.has(name));
    expect(
      unexpected,
      `New file(s) in contexts/: ${unexpected.join(', ')}. The standard is TWO files (patterns + runtime) — ` +
        'add a kind to an existing registry (principal source / session kind / maintenance kind), ' +
        'do not add a wrapper file. A genuine fourth pattern requires editing this test deliberately.',
    ).toEqual([]);
  });

  it('the scope-pattern file exists', () => {
    const actual = new Set(readdirSync(contextsDirectory));
    for (const file of SCOPE_PATTERN_FILES) {
      expect(actual.has(file), `missing scope pattern file: ${file}`).toBe(true);
    }
  });
});
