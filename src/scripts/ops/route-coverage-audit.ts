/**
 * Route Coverage Audit
 *
 * For each route in `docs/routes.txt`:
 *   1. Identifies test files that exercise the URL pattern (e2e, integration,
 *      security, smoke, contract).
 *   2. Classifies coverage by category:
 *      - hit by an explicit e2e/integration test → covered
 *      - hit by the smoke test only → smoke-only
 *      - no test reference found → gap
 *   3. Emits a markdown report at
 *      `docs/reviews/route-coverage-audit-2026-06-08.md`.
 *   4. Returns nonzero if any route is in the `gap` bucket and not on the
 *      explicit allowlist (so this can run as a CI ratchet alongside
 *      `validate-test-naming` and the no-direct-DB gate).
 *
 * Usage:
 *   pnpm exec tsx src/scripts/ops/route-coverage-audit.ts            # report-only
 *   pnpm exec tsx src/scripts/ops/route-coverage-audit.ts --check    # exit 1 on gap
 *
 * Notes:
 *   The matcher tolerates path-parameter substitution: a route declared as
 *   `/api/v1/tenancy/organization/api-keys/:api_key_id` is considered exercised by a test that
 *   contains `/tenancy/organization/api-keys/${API_KEY_ID}`, `/tenancy/organization/api-keys/test-key`,
 *   `/tenancy/organization/api-keys/:api_key_id`, `api-keys/\${apiKey.public_id}`,
 *   etc. The path is normalised by stripping `/api/v1/` and lowercasing.
 */
import { readFileSync } from 'node:fs';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface RouteEntry {
  method: string;
  pathOriginal: string;
  pathNormalised: string;
  authType: string;
}

interface CoverageHit {
  file: string;
  line: number;
  excerpt: string;
}

interface RouteCoverage {
  route: RouteEntry;
  hits: CoverageHit[];
  status: 'covered' | 'smoke-only' | 'gap';
}

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ROUTES_FILE = join(REPO_ROOT, 'docs', 'routes.txt');
const TEST_ROOTS = [join(REPO_ROOT, 'src', 'tests'), join(REPO_ROOT, 'src', 'domains')];
const SMOKE_FILE_FRAGMENT = 'src/scripts/ops/api-smoke-test.ts';

const SMOKE_FILE = join(REPO_ROOT, SMOKE_FILE_FRAGMENT);

const CHECK_MODE = process.argv.includes('--check');

/**
 * Routes that are explicitly allowed to lack a dedicated e2e/integration
 * test. Each entry MUST be justified — typically because:
 *   - The route is operational / metrics-only (token-protected, not a
 *     business flow).
 *   - The route exists but the team has consciously deferred writing the
 *     end-to-end test (in which case a follow-up task chip should exist).
 *
 * The route-coverage-audit-2026-06-08 sweep identified 10 routes that have
 * policy / unit tests asserting rate-limit + permission gating but no
 * integration / e2e test that walks the full request flow. Tracked as
 * task chips so the gap is owned, not silently ignored.
 */
const JUSTIFIED_GAPS = new Set<string>([
  // (empty — every route currently has an explicit test reference; add entries
  // only with a written justification)
]);

function parseRoutesFile(): RouteEntry[] {
  const text = readFileSync(ROUTES_FILE, 'utf8');
  const entries: RouteEntry[] = [];
  const routeLineRegex = /^\s+(GET|POST|PATCH|PUT|DELETE)\s+(\S+)\s+(.+)$/;
  for (const line of text.split('\n')) {
    const match = line.match(routeLineRegex);
    if (!match) continue;
    const method = match[1]!;
    const path = match[2]!;
    const authType = (match[3] ?? '').trim();
    entries.push({
      method,
      pathOriginal: path,
      pathNormalised: path
        .replace(/^\/api\/v\d+\//, '')
        .replace(/:[\w-]+/g, ':PARAM')
        .toLowerCase(),
      authType,
    });
  }
  return entries;
}

function walkTestFiles(root: string): string[] {
  const out: string[] = [];
  function recurse(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        recurse(full);
      } else if (
        stat.isFile() &&
        (full.endsWith('.test.ts') ||
          full.endsWith('.test.tsx') ||
          full.endsWith('.unit.test.ts') ||
          full.endsWith('.integration.test.ts') ||
          full.endsWith('.security.test.ts') ||
          full.endsWith('.contract.test.ts') ||
          full.endsWith('.global.test.ts'))
      ) {
        out.push(full);
      }
    }
  }
  recurse(root);
  return out;
}

/**
 * Builds a regex that matches the route's URL inside a test source line,
 * tolerating typical path-parameter interpolations:
 *   - `${variable}` template literal
 *   - `${object.public_id}` template literal with member access
 *   - literal id (e.g. `"test-organization-id"`)
 *   - raw `:id` (when the test imports the URL pattern directly)
 *
 * Strategy: split the route into segments, then for each segment that's a
 * path param, allow `[^/\s'"\`]+` between the adjacent literal segments.
 */
function buildRouteUrlRegex(route: RouteEntry): RegExp {
  // Drop the `/api/v1/` prefix because tests typically use `testApiPath()`
  // which adds it; the comparison is against the unprefixed path.
  const stripped = route.pathOriginal.replace(/^\/api\/v\d+/, '');
  const segments = stripped.split('/').filter((s) => s.length > 0);
  const escaped = segments.map((segment) => {
    if (segment.startsWith(':')) {
      // Allow anything that's not a path separator as the interpolated
      // param value. Curly braces / quotes inside template literals
      // (`${var}`) are allowed; bounded by the literal `/` on each side.
      return `[^/]+`;
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`/${escaped.join('/')}(?=[\\s'"\`?,)\\\\]|$)`, 'g');
}

function findCoverageHits(
  route: RouteEntry,
  testFiles: { path: string; content: string }[],
): CoverageHit[] {
  const matcher = buildRouteUrlRegex(route);
  const hits: CoverageHit[] = [];
  for (const { path, content } of testFiles) {
    matcher.lastIndex = 0;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      matcher.lastIndex = 0;
      if (!matcher.test(line)) continue;
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('*')) continue;
      hits.push({
        file: path.replace(`${REPO_ROOT}/`, ''),
        line: i + 1,
        excerpt: line.trim().slice(0, 160),
      });
      if (hits.length >= 5) break;
    }
    if (hits.length >= 5) break;
  }
  return hits;
}

function hitIsSmokeOnly(hits: CoverageHit[]): boolean {
  if (hits.length === 0) return false;
  return hits.every((h) => h.file.includes(SMOKE_FILE_FRAGMENT));
}

async function main(): Promise<void> {
  console.log('Reading docs/routes.txt…');
  const routes = parseRoutesFile();
  console.log(`Parsed ${routes.length} routes.`);

  console.log('Walking test files…');
  const testFilePaths = TEST_ROOTS.flatMap((root) => walkTestFiles(root));
  // Include the smoke file too so we can detect smoke-only coverage.
  let smokeContent = '';
  try {
    smokeContent = readFileSync(SMOKE_FILE, 'utf8');
  } catch {
    smokeContent = '';
  }
  const testFiles = testFilePaths.map((path) => ({
    path,
    content: readFileSync(path, 'utf8'),
  }));
  if (smokeContent) {
    testFiles.push({ path: SMOKE_FILE, content: smokeContent });
  }
  console.log(`Indexed ${testFiles.length} test/smoke files.`);

  console.log('Computing per-route coverage…');
  const coverages: RouteCoverage[] = [];
  for (const route of routes) {
    const hits = findCoverageHits(route, testFiles);
    let status: RouteCoverage['status'];
    if (hits.length === 0) status = 'gap';
    else if (hitIsSmokeOnly(hits)) status = 'smoke-only';
    else status = 'covered';
    coverages.push({ route, hits, status });
  }

  const covered = coverages.filter((c) => c.status === 'covered');
  const smokeOnly = coverages.filter((c) => c.status === 'smoke-only');
  const gaps = coverages.filter(
    (c) => c.status === 'gap' && !JUSTIFIED_GAPS.has(`${c.route.method} ${c.route.pathOriginal}`),
  );

  const reportLines: string[] = [];
  reportLines.push('# Route Coverage Audit — 2026-06-08');
  reportLines.push('');
  reportLines.push(`Total routes: ${routes.length}`);
  reportLines.push('');
  reportLines.push(`- ✅ Covered by explicit test: **${covered.length}**`);
  reportLines.push(`- 🟡 Smoke-only (probe but no assertion-rich test): **${smokeOnly.length}**`);
  reportLines.push(`- ❌ Gap (no test reference found): **${gaps.length}**`);
  reportLines.push('');

  reportLines.push('## Verdict');
  reportLines.push('');
  if (gaps.length === 0) {
    reportLines.push(
      'Every route in `docs/routes.txt` is referenced by at least one explicit test file or the smoke test.',
    );
  } else {
    reportLines.push(
      `${gaps.length} route(s) have NO test reference anywhere in \`src/tests/**\`, \`src/domains/**/__tests__/**\`, or the smoke test. These are listed below.`,
    );
  }
  reportLines.push('');

  reportLines.push('## ❌ Gap routes (need explicit test coverage)');
  reportLines.push('');
  if (gaps.length === 0) {
    reportLines.push('_None._');
  } else {
    reportLines.push('| Method | Route | Auth |');
    reportLines.push('|---|---|---|');
    for (const c of gaps) {
      reportLines.push(`| ${c.route.method} | \`${c.route.pathOriginal}\` | ${c.route.authType} |`);
    }
  }
  reportLines.push('');

  reportLines.push('## 🟡 Smoke-only routes (referenced only by api-smoke-test.ts)');
  reportLines.push('');
  if (smokeOnly.length === 0) {
    reportLines.push('_None._');
  } else {
    reportLines.push('| Method | Route | Auth |');
    reportLines.push('|---|---|---|');
    for (const c of smokeOnly) {
      reportLines.push(`| ${c.route.method} | \`${c.route.pathOriginal}\` | ${c.route.authType} |`);
    }
  }
  reportLines.push('');

  reportLines.push('## ✅ Covered routes (sample of 20)');
  reportLines.push('');
  reportLines.push('| Method | Route | First test reference |');
  reportLines.push('|---|---|---|');
  for (const c of covered.slice(0, 20)) {
    const firstHit = c.hits[0];
    const hitLabel = firstHit ? `\`${firstHit.file}:${firstHit.line}\`` : '_(none)_';
    reportLines.push(`| ${c.route.method} | \`${c.route.pathOriginal}\` | ${hitLabel} |`);
  }
  reportLines.push(`| ... | ... | (${covered.length - 20} more) |`);
  reportLines.push('');

  reportLines.push('## Method overview');
  reportLines.push('');
  const byMethod: Record<string, { covered: number; smokeOnly: number; gap: number }> = {};
  for (const c of coverages) {
    byMethod[c.route.method] ??= { covered: 0, smokeOnly: 0, gap: 0 };
    byMethod[c.route.method]![c.status === 'smoke-only' ? 'smokeOnly' : c.status]++;
  }
  reportLines.push('| Method | Covered | Smoke-only | Gap |');
  reportLines.push('|---|---|---|---|');
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
    const row = byMethod[method] ?? { covered: 0, smokeOnly: 0, gap: 0 };
    reportLines.push(`| ${method} | ${row.covered} | ${row.smokeOnly} | ${row.gap} |`);
  }
  reportLines.push('');

  reportLines.push('## Methodology');
  reportLines.push('');
  reportLines.push(
    '- Routes parsed from `docs/routes.txt` (auto-generated by `pnpm routes:catalog`).',
  );
  reportLines.push(
    [
      '- Match is anchored on the full URL after stripping `/api/v1/` and replacing param tokens (`:id`, `:publicId`, etc.) with `[^/]+`, so a test that hits ',
      '`/tenancy/organization/api-keys/' + '$' + '{apiKey.public_id}` ',
      'is correctly associated with `GET /api/v1/tenancy/organization/api-keys/:api_key_id`.',
    ].join(''),
  );
  reportLines.push(
    '- Files scanned: `src/tests/**/*.test.ts`, `src/tests/**/*.integration.test.ts`, `src/tests/**/*.security.test.ts`, `src/tests/**/*.contract.test.ts`, `src/tests/**/*.global.test.ts`, `src/domains/**/__tests__/**/*.test.ts`, plus `src/scripts/ops/api-smoke-test.ts`.',
  );
  reportLines.push(
    '- "Covered" requires a hit outside the smoke file (an explicit assertion-rich test). "Smoke-only" means the only reference is in `api-smoke-test.ts` — useful for liveness, but not as strong as a full e2e / integration test with body + DB-state assertions.',
  );
  reportLines.push(
    '- This audit does NOT verify that the test asserts the correct behaviour — only that the route is referenced. Use it as a coverage-existence gate, not a correctness gate.',
  );
  reportLines.push('');

  // `--check` is read-only: writing from it mutated the repository AND crashed, because
  // `init:project --reset-history` purges `docs/reviews/`, so the unconditional write hit
  // ENOENT before the gap verdict below could run. Create the directory when we do write.
  if (!CHECK_MODE) {
    const outputDirectory = join(REPO_ROOT, 'docs', 'reviews');
    const outputPath = join(outputDirectory, 'route-coverage-audit-2026-06-08.md');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(outputPath, reportLines.join('\n'));
    console.log(`Wrote ${outputPath}`);
  }

  console.log('');
  console.log(`Covered: ${covered.length}`);
  console.log(`Smoke-only: ${smokeOnly.length}`);
  console.log(`Gap: ${gaps.length}`);

  if (CHECK_MODE && gaps.length > 0) {
    console.error('\n❌ Gap routes found — see report.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
