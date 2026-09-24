import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  computeCoverage,
  extractScenarioRequests,
  isExcluded,
  nightlyScenarioNames,
  normalizeScenarioPath,
  parseRoutes,
} from '@tooling/ci/check-load-coverage.mjs';

const CATALOG = [
  '  GET    /api/v1/users/me                                         200  -    both  AUTH',
  '  PATCH  /api/v1/users/me                                         200  -    both  AUTH',
  '  GET    /api/v1/notify/webhooks/:webhook_id                      200  -    both  PERM: webhook:read',
  '  POST   /api/v1/tenancy/organization/memberships                 200  req  team  PERM: membership:manage',
  '  POST   /api/v1/users/:user_id/suspend                           200  -    both  ROLE: super_admin',
  '  POST   /api/v1/auth/email/login                                 200  -    both  PUBLIC',
  // The idempotency section repeats routes without the S/I/O columns — not route lines.
  '    POST /api/v1/tenancy/organization/memberships',
].join('\n');

describe('check-load-coverage', () => {
  it('parses the catalog columns, keeping an auth value that contains spaces', () => {
    const routes = parseRoutes(CATALOG);

    expect(routes).toHaveLength(6);
    expect(routes[2]).toEqual({
      method: 'GET',
      path: '/api/v1/notify/webhooks/:webhook_id',
      auth: 'PERM: webhook:read',
    });
  });

  it('excludes ROLE and public infrastructure routes, and nothing else', () => {
    const excluded = parseRoutes(CATALOG).filter((route) => isExcluded(route));

    expect(excluded.map((route) => route.path)).toEqual([
      '/api/v1/users/:user_id/suspend',
      '/api/v1/auth/email/login',
    ]);
  });

  it('normalizes scenario URL literals to catalog-comparable paths', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: scenario source text — the checker must read ${…} literally
    expect(normalizeScenarioPath('`${API_PREFIX}/users/me`')).toBe('/users/me');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: scenario source text — the checker must read ${…} literally
    expect(normalizeScenarioPath('`${API}/notify/webhooks/${webhookId}?limit=5`')).toBe(
      '/notify/webhooks/:param',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: scenario source text — the checker must read ${…} literally
    expect(normalizeScenarioPath('`${BASE_URL}/readyz`')).toBe('/readyz');
    expect(normalizeScenarioPath("'/users/me'")).toBe('/users/me');
    // A fully dynamic URL is no path: the table that feeds it supplies the real ones.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: scenario source text — the checker must read ${…} literally
    expect(normalizeScenarioPath('`${API}${path}`')).toBeNull();
  });

  it('extracts direct calls, calls through a const, and METHOD/path table pairs', () => {
    const requests = extractScenarioRequests(`
      http.get(\`\${API_PREFIX}/users/me\`, { headers });
      const settingsUrl = \`\${API_PREFIX}/users/me/settings\`;
      http.patch(settingsUrl, body, { headers });
      http.del(\`\${API_PREFIX}/notify/webhooks/\${id}\`);
      const STEPS = [['07-get-me', 'GET', '/users/me'], ['19-list', 'POST', '/uploads']];
    `);

    expect(requests).toEqual([
      { method: 'GET', path: '/users/me' },
      { method: 'PATCH', path: '/users/me/settings' },
      { method: 'DELETE', path: '/notify/webhooks/:param' },
      { method: 'GET', path: '/users/me' },
      { method: 'POST', path: '/uploads' },
    ]);
  });

  it('counts a route only when a scenario calls its method, with :param matching any segment', () => {
    const { covered, uncovered, coveringFiles } = computeCoverage({
      routes: parseRoutes(CATALOG),
      scenarios: [
        {
          name: 'reads.js',
          content:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: scenario source text — the checker must read ${…} literally
            'http.get(`${API_PREFIX}/users/me`); http.get(`${API_PREFIX}/notify/webhooks/${id}`);',
        },
      ],
    });

    expect(covered.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/v1/users/me',
      'GET /api/v1/notify/webhooks/:webhook_id',
    ]);
    // Same path, different method: a GET does not cover the PATCH.
    expect(uncovered.map((route) => `${route.method} ${route.path}`)).toContain(
      'PATCH /api/v1/users/me',
    );
    expect(coveringFiles.get(covered[0] as (typeof covered)[number])).toEqual(['reads.js']);
  });

  it('reads the nightly scenario set from the workflow source', () => {
    expect(
      nightlyScenarioNames(`
        k6 run src/tests/load/k6/scenarios/api-stress.js
        k6 run --summary-export=x.json src/tests/load/k6/scenarios/daily-ops.js || failed=1
        k6 run src/tests/load/k6/scenarios/api-stress.js
      `),
    ).toEqual(['api-stress.js', 'daily-ops.js']);
  });

  it('runs as a CLI: the main guard fires and prints the report', () => {
    const output = execFileSync('node', ['tooling/ci/check-load-coverage.mjs', '--report-only'], {
      encoding: 'utf8',
    });

    expect(output).toContain('k6 Load-test Route Coverage (all scenario files)');
    expect(output).toMatch(/Covered\s+: \d+/);
  });
});
