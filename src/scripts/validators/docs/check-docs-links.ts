/**
 * Validates hand-written docs: stale path patterns, broken relative markdown
 * links, and inline-code path citations (`src/...`, `tooling/...`, …) that no
 * longer exist on disk.
 *
 * Limitations: fenced code blocks (``` … ```) are excluded from the inline-path
 * pass — directory-tree blocks cite names relative to their tree root, which
 * cannot be resolved reliably. Tree drift is covered by the generated
 * `docs/reference/architecture/src-structure-tree.txt` gate and the periodic
 * structure audit (`/structure-audit`) instead.
 *
 * Usage: pnpm docs:links:check
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd());

/** Known obsolete paths (substring match). */
const STALE_PATTERNS: { pattern: string; suggestion: string }[] = [
  { pattern: 'docs/LOAD-TESTING.md', suggestion: 'docs/reference/testing/load-testing.md' },
  { pattern: 'docs/API-TESTING.md', suggestion: 'docs/getting-started/api-testing.md' },
  {
    pattern: 'docs/PROJECT-STRUCTURE.md',
    suggestion: 'docs/reference/architecture/project-structure-guide.md',
  },
];

const SCAN_ROOTS = [
  join(REPO_ROOT, 'docs'),
  join(REPO_ROOT, 'README.md'),
  join(REPO_ROOT, 'CLAUDE.md'),
  join(REPO_ROOT, 'AGENTS.md'),
  join(REPO_ROOT, 'CONTRIBUTING.md'),
  join(REPO_ROOT, 'agent-os'),
  join(REPO_ROOT, '.github'),
  join(REPO_ROOT, 'src'),
];

const SKIP_DIR_NAMES = new Set(['openapi', 'node_modules', '.git']);

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

/** Inline-code spans (single backtick) — the citation form the path pass scans. */
const INLINE_CODE = /`([^`\n]+)`/g;

/** A cited token must start with one of these to be treated as a repo path. */
const PATH_PREFIXES = [
  'src/',
  'tooling/',
  'migrations/',
  'agent-os/',
  'docs/',
  '.github/',
  '.husky/',
];

/** Generated or gitignored targets a doc may cite without them existing on a fresh clone. */
const GENERATED_PATH_PREFIXES = [
  'docs/openapi/',
  'docs/ONBOARDING.md', // optional output of /understand-onboard
  'agent-os/mcp/mcp.json', // gitignored live MCP config (scaffold via pnpm mcp:setup)
  'agent-os/hooks/.telemetry.log', // gitignored runtime hook telemetry log
  'src/tests/load/k6/data/credential-pool.json', // gitignored k6 credential pool
];

/**
 * Git-ignored targets a doc may LINK to (markdown `[text](path)`). Unlike inline
 * citations these have no prefix pass, so they are matched here as exact repo-root
 * relative paths and skipped — they legitimately dangle on a fresh clone.
 * `.mcp.json` is a tracked symlink to the gitignored `agent-os/mcp/mcp.json`, so it
 * resolves on a developer's machine (target present) but dangles on CI.
 */
const IGNORED_LINK_TARGETS = new Set<string>([
  '.mcp.json',
  'docs/reference/security/adversarial-audit-report.md',
]);

/**
 * Paths docs cite as deliberately absent ("there is intentionally no …", "never
 * commit a …") or as retired locations kept for contrast. Exact-token match
 * (trailing slash ignored).
 */
const INTENTIONALLY_ABSENT = new Set<string>([
  'src/infrastructure/database/schemas',
  'src/infrastructure/queue/processors',
  'src/tests/node_modules',
  'migrations/meta', // Drizzle bookkeeping — docs instruct never to commit it
  'tooling/feature-docs', // retired DOCS.md aggregator, cited historically
  '.github/sync.config.json', // dead reference the evals README quotes as a past finding
  'docs/reference/load-testing.md', // docs-audit skill cites it as the example of a stale flat path
  // `init:project --reset-history` deletes the BASE project's audit history, so these are
  // legitimately empty in a freshly adopted repo. Restoring them would import another
  // product's history; leaving the links unguarded made this gate permanently red after
  // any adoption. Both `ci:local` and `ci:quality` run it.
  'docs/reviews',
  'docs/superpowers',
]);

/**
 * Git branch-name examples cited in the branch-naming guides. A branch is
 * `<type>/<slug>` where `<type>` is a conventional-commit type (BRANCH_TYPES in
 * `.husky/pre-push`), and `docs` is both a valid type and a PATH_PREFIX — so
 * `docs/american-spelling-organization` reads as a repo path to the pass below.
 * These are branch names, not files: nothing on disk should ever match them.
 * Add new branch examples here when the naming docs gain one.
 * Owner: agent-os/rules/git-branch-naming.mdc.
 */
const BRANCH_NAME_EXAMPLES = new Set<string>(['docs/american-spelling-organization']);

/**
 * Archival point-in-time snapshots — exempt from both passes (they legitimately
 * cite paths and link targets as they existed at the time).
 */
const ARCHIVAL_DIRS = ['docs/reviews/', 'docs/superpowers/'];

/** Archive-suffixed docs are inline-path exempt for the same reason. */
const ARCHIVE_FILE_SUFFIX = '-archive.md';

/** Placeholder / glob / prose markers that mean a token is not a literal path. */
const NON_LITERAL_TOKEN = /[*?<>{}|,()\s€£§]|\.{3}|…/;

function collectMarkdownFiles(path: string, out: string[]): void {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    if (path.endsWith('.md') || path.endsWith('.mdc')) out.push(path);
    return;
  }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = join(path, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectMarkdownFiles(full, out);
    else if (entry.endsWith('.md') || entry.endsWith('.mdc')) out.push(full);
  }
}

/**
 * Drops gitignored files from the scan set.
 *
 * @remarks
 * - **Algorithm:** one `git check-ignore --stdin` over every collected path; it echoes back only
 *   the ignored ones. Exit status 1 means "none ignored", which is a result rather than an error.
 * - **Failure modes:** if git is unavailable or errors for any other reason, every file is scanned
 *   — the previous behaviour. This filter narrows the gate; it must never be the reason the gate
 *   stops running.
 * - **Side effects:** one child process.
 * - **Notes:** without this the gate fails locally on files CI never sees. A scratch
 *   `*REPORT*.md` left in `docs/` is gitignored, absent from a fresh clone, and its stale links
 *   made `pnpm docs:links:check` permanently red on one machine — which is how a gate stops being
 *   read at all.
 */
function withoutGitIgnoredFiles(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  try {
    const ignoredOutput = execFileSync('git', ['check-ignore', '--stdin'], {
      input: paths.join('\n'),
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });
    const ignored = new Set(
      ignoredOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    return paths.filter((path) => !ignored.has(path));
  } catch {
    return paths;
  }
}

function isExternalOrAnchor(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith('#')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
  return false;
}

function resolveMarkdownTarget(fromFile: string, target: string): string | null {
  const withoutAnchor = target.split('#')[0]?.trim() ?? '';
  if (!withoutAnchor) return fromFile;
  // Docs use two href conventions: relative to the file, and repo-root-relative
  // (clickable from the repo root — the style used by src/ overview docs).
  // Accept either: resolve relative first, fall back to repo root.
  const relative = resolve(dirname(fromFile), withoutAnchor);
  if (statSync(relative, { throwIfNoEntry: false })) return relative;
  const fromRoot = resolve(REPO_ROOT, withoutAnchor);
  if (statSync(fromRoot, { throwIfNoEntry: false })) return fromRoot;
  return null;
}

/** Repo-root-relative form of a markdown link target, whether or not it exists on disk. */
function markdownTargetRepoPath(fromFile: string, target: string): string {
  const withoutAnchor = target.split('#')[0]?.trim() ?? '';
  const absolute = resolve(dirname(fromFile), withoutAnchor);
  return absolute.startsWith(REPO_ROOT) ? absolute.slice(REPO_ROOT.length + 1) : absolute;
}

function stripFences(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '');
}

function extractCitedPath(rawToken: string): string | null {
  // Trim trailing prose punctuation and a `:line` / `#L10` suffix (`file.ts:42`).
  const token = rawToken
    .replace(/[.,;:!]+$/, '')
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/#L\d+(?:-L?\d+)?$/, '');
  if (NON_LITERAL_TOKEN.test(token)) return null;
  if (!PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return null;
  if (GENERATED_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return null;
  if (INTENTIONALLY_ABSENT.has(token.replace(/\/$/, ''))) return null;
  if (BRANCH_NAME_EXAMPLES.has(token)) return null;
  return token;
}

function citedPathExists(cited: string): boolean {
  if (statSync(resolve(REPO_ROOT, cited), { throwIfNoEntry: false })) return true;
  // Import-specifier convention: docs may cite the runtime `.js` name of a `.ts` source.
  if (cited.endsWith('.js')) {
    const twin = `${cited.slice(0, -'.js'.length)}.ts`;
    if (statSync(resolve(REPO_ROOT, twin), { throwIfNoEntry: false })) return true;
  }
  return false;
}

function main(): void {
  const collected: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      collectMarkdownFiles(root, collected);
    } catch {
      // optional path missing
    }
  }
  // Gitignored files are not part of the repo CI sees, so their links are not this gate's problem.
  const files = withoutGitIgnoredFiles(collected);

  const staleHits: string[] = [];
  const brokenLinks: string[] = [];
  const missingCitedPaths: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const relativeFile = relativePath(file);
    const isArchival =
      ARCHIVAL_DIRS.some((dir) => relativeFile.startsWith(dir)) ||
      relativeFile.endsWith(ARCHIVE_FILE_SUFFIX);

    for (const { pattern, suggestion } of STALE_PATTERNS) {
      if (content.includes(pattern)) {
        staleHits.push(`${relativeFile}: stale reference "${pattern}" → use ${suggestion}`);
      }
    }

    if (isArchival) continue;

    for (const match of content.matchAll(MARKDOWN_LINK)) {
      const target = match[1];
      if (!target || isExternalOrAnchor(target)) continue;
      if (!resolveMarkdownTarget(file, target)) {
        if (IGNORED_LINK_TARGETS.has(markdownTargetRepoPath(file, target))) continue;
        brokenLinks.push(`${relativeFile}: broken link (${target})`);
      }
    }

    const seenTokens = new Set<string>();
    for (const match of stripFences(content).matchAll(INLINE_CODE)) {
      const cited = extractCitedPath(match[1] ?? '');
      if (!cited || seenTokens.has(cited)) continue;
      seenTokens.add(cited);
      if (!citedPathExists(cited)) {
        missingCitedPaths.push(`${relativeFile}: cited path does not exist (\`${cited}\`)`);
      }
    }
  }

  if (staleHits.length === 0 && brokenLinks.length === 0 && missingCitedPaths.length === 0) {
    console.log(`docs:links:check OK (${files.length} files scanned)`);
    return;
  }

  if (staleHits.length > 0) {
    console.error('\nStale path patterns:\n');
    for (const line of staleHits) console.error(`  ${line}`);
  }
  if (brokenLinks.length > 0) {
    console.error('\nBroken relative links:\n');
    for (const line of brokenLinks) console.error(`  ${line}`);
  }
  if (missingCitedPaths.length > 0) {
    console.error(
      '\nInline-cited paths that do not exist (fix the doc or the allowlists at the top of check-docs-links.ts):\n',
    );
    for (const line of missingCitedPaths) console.error(`  ${line}`);
  }
  process.exit(1);
}

function relativePath(absolute: string): string {
  return absolute.startsWith(REPO_ROOT) ? absolute.slice(REPO_ROOT.length + 1) : absolute;
}

main();
