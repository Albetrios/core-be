import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Policy: `getContextFreeDatabase()` skips the unscoped-query counter, so it may only front a query
 * that cannot depend on a database context:
 * - a `SECURITY DEFINER` resolver (`<schema>.resolve_*(`) run through `.execute`, which reads as
 *   its owner whatever the caller's GUCs are; or
 * - the `tenancy.permissions` reference catalog read in `permission.repository.ts`, whose policy
 *   is unconditional.
 *
 * Anything else must use `getRequestDatabase()` (which counts) or a context wrapper — otherwise the
 * accessor becomes a way to silence the counter, and a non-zero `database_unscoped_query_total`
 * stops meaning "a query that needed a context ran without one". Checked per call site, not per
 * file, so a new resolver call is allowed without editing this test and a misuse is not.
 */
const ACCESSOR_CALL = 'getContextFreeDatabase()';
const DEFINITION_FILE = 'src/infrastructure/database/contexts/database-context-runtime.ts';

function callSites(): { location: string; following: string; file: string }[] {
  let output = '';
  try {
    output = execFileSync('grep', ['-rl', ACCESSOR_CALL, 'src', '--include=*.ts'], {
      encoding: 'utf8',
    });
  } catch {
    // no matches
  }
  return output
    .split('\n')
    .filter(Boolean)
    .filter((file) => !/\.test\.ts$/.test(file) && file !== DEFINITION_FILE)
    .flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const sites: { location: string; following: string; file: string }[] = [];
      let index = source.indexOf(ACCESSOR_CALL);
      while (index !== -1) {
        const line = source.slice(0, index).split('\n').length;
        sites.push({
          file,
          location: `${file}:${line}`,
          following: source.slice(index + ACCESSOR_CALL.length, index + ACCESSOR_CALL.length + 320),
        });
        index = source.indexOf(ACCESSOR_CALL, index + ACCESSOR_CALL.length);
      }
      return sites;
    });
}

describe('context-free database usage', () => {
  it('fronts only SECURITY DEFINER resolvers and the permission catalog read', () => {
    const sites = callSites();
    // Guard against a vacuous pass (e.g. the accessor renamed and this scan finding nothing).
    expect(sites.length).toBeGreaterThanOrEqual(10);

    const offenders = sites
      .filter(({ file, following }) => {
        const securityDefinerResolver = /^\s*\.execute\b[\s\S]*?\b[a-z]+\.resolve_[a-z_]+\(/.test(
          following,
        );
        const permissionCatalogRead =
          file.endsWith('permission/permission.repository.ts') &&
          /^\s*\.select\(\)\s*\.from\(permissions\)/.test(following);
        return !(securityDefinerResolver || permissionCatalogRead);
      })
      .map((site) => site.location);

    expect(
      offenders,
      'getContextFreeDatabase() is only for queries that cannot depend on a context (SECURITY DEFINER resolvers, the permission catalog). Use getRequestDatabase() or a context wrapper instead.',
    ).toEqual([]);
  });
});
