/**
 * Repo-wide gate: project-identity literals (the slug and the GitHub owner) may
 * appear only in files that legitimately carry them.
 *
 * @remarks
 * Algorithm: walk every git-tracked file, skip the excluded categories, skip the
 * files the identity generator itself writes, then flag any remaining occurrence
 * of the manifest's slug or owner unless an allowlist entry covers it.
 *
 * The generator's own targets are exempt BY CONSTRUCTION — they are passed in
 * rather than restated here, so adding a generated artifact can never leave a
 * stale exemption behind.
 *
 * Failure modes: a new hardcoded literal fails the gate with the file and line.
 * A stale allowlist entry (the literal it covers is gone) ALSO fails, so the
 * allowlist cannot silently rot — the same self-validating shape used by
 * `src/tests/unit/ci/redis-set-ttl.policy.unit.test.ts`.
 *
 * Side effects: none; reads the working tree and returns findings.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { gitEnvironmentWithoutInheritedRepository } from '@tooling/setup/common/git-environment.js';

import type { ProjectIdentitySnapshot } from './project-identity.util.js';

/** A file+reason pair permitting the identity literal to appear verbatim. */
export interface IdentityLiteralAllowance {
  /** Repository-relative path. */
  readonly file: string;
  /** Why the literal is legitimate here — shown when the entry goes stale. */
  readonly reason: string;
}

/** A literal occurrence the gate rejects. */
export interface IdentityLiteralViolation {
  readonly file: string;
  readonly line: number;
  readonly literal: string;
  readonly text: string;
}

/**
 * Path prefixes and suffixes scanned files are drawn from. Prose that names the
 * base project is expected and is not an identity defect, so all Markdown and
 * the agent-tooling mirrors are out of scope.
 */
const EXCLUDED_PREFIXES: readonly string[] = [
  'docs/',
  'agent-os/',
  '.claude/',
  '.cursor/',
  '.codex/',
  '.github/ISSUE_TEMPLATE/',
];

const EXCLUDED_SUFFIXES: readonly string[] = [
  '.md',
  '.mdc',
  '.dbml',
  '.snap',
  '.lock',
  '.png',
  '.jpg',
  '.svg',
  '.ico',
];

const EXCLUDED_FILES: readonly string[] = [
  'CHANGELOG.md',
  'pnpm-lock.yaml',
  'docs/routes.txt',
  'tooling/setup/setup.config.json',
];

/**
 * Files that legitimately carry the literal but are not generator outputs.
 *
 * @remarks
 * Intentionally EMPTY. Every non-prose file that names the project is a
 * generator target — either a whole-file output, a reconciled file, or a
 * shape-matched span in `text-identity-rewrites.ts`. An allowlist entry is
 * strictly worse than a rewrite rule: the file keeps the BASE project's name
 * after a fork, so the adopting team ships someone else's brand. Prefer adding
 * a rewrite rule; add an entry here only when a literal genuinely must survive
 * a rename, and say why.
 *
 * Entries are validated: one whose literal no longer appears fails the gate, so
 * a stale exemption cannot rot silently.
 */
export const IDENTITY_LITERAL_ALLOWLIST: readonly IdentityLiteralAllowance[] = [];

function isExcluded(repositoryRelativePath: string): boolean {
  if (EXCLUDED_FILES.includes(repositoryRelativePath)) return true;
  if (EXCLUDED_PREFIXES.some((prefix) => repositoryRelativePath.startsWith(prefix))) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => repositoryRelativePath.endsWith(suffix));
}

function listTrackedFiles(projectRoot: string): string[] {
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    // `projectRoot` is only honored once the inherited GIT_DIR/GIT_INDEX_FILE
    // are gone. Run from a hook (pre-commit, pre-push) they win over `cwd`, and
    // this lists the hook's repository instead — which makes the gate scan a
    // tree it was never pointed at, and pass vacuously when no path lines up.
    env: gitEnvironmentWithoutInheritedRepository(),
  });
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/** Literals a fork must not hardcode: the project slug and the GitHub owner. */
export function identityLiterals(snapshot: ProjectIdentitySnapshot): string[] {
  return [snapshot.slug, snapshot.repository.owner].filter(
    (literal, index, all) => literal.length > 0 && all.indexOf(literal) === index,
  );
}

export interface IdentityLiteralScanResult {
  readonly violations: IdentityLiteralViolation[];
  /** Allowlist entries whose file no longer contains any identity literal. */
  readonly staleAllowances: IdentityLiteralAllowance[];
}

/**
 * Scan the working tree for hardcoded identity literals.
 *
 * @param options.generatedPaths - Absolute paths the identity generator writes;
 *   exempt by construction so the exemption cannot drift from the generator.
 */
export function scanProjectIdentityLiterals(options: {
  readonly snapshot: ProjectIdentitySnapshot;
  readonly projectRoot: string;
  readonly generatedPaths: readonly string[];
}): IdentityLiteralScanResult {
  const { snapshot, projectRoot } = options;
  const literals = identityLiterals(snapshot);
  const generated = new Set(
    options.generatedPaths.map((path) => relative(projectRoot, path).replaceAll('\\', '/')),
  );
  const allowedFiles = new Map(
    IDENTITY_LITERAL_ALLOWLIST.map((allowance) => [allowance.file, allowance]),
  );
  const allowancesSeen = new Set<string>();

  const violations: IdentityLiteralViolation[] = [];
  for (const file of listTrackedFiles(projectRoot)) {
    if (isExcluded(file) || generated.has(file)) continue;
    const absolute = resolve(projectRoot, file);
    // lstat, NOT stat: a tracked symlink's git content is its target PATH, so scanning it says
    // nothing about identity, while stat() follows the link and reads whatever sits at the other
    // end. `.mcp.json` is exactly that — a tracked symlink to the gitignored, developer-specific
    // `agent-os/mcp/mcp.json`. Following it made this gate read a private config that may hold API
    // keys, and fail `pnpm ci:quality` on every machine that has scaffolded one, while passing in
    // CI where the target is absent and the link dangles. A tracked target is scanned via its own
    // entry; an untracked one is out of scope by definition.
    if (!existsSync(absolute)) continue;
    if (!lstatSync(absolute).isFile()) continue;

    const contents = readFileSync(absolute, 'utf-8');
    const matched = literals.filter((literal) => contents.includes(literal));
    if (matched.length === 0) continue;

    if (allowedFiles.has(file)) {
      allowancesSeen.add(file);
      continue;
    }
    for (const [index, text] of contents.split('\n').entries()) {
      for (const literal of matched) {
        if (text.includes(literal)) {
          violations.push({ file, line: index + 1, literal, text: text.trim() });
        }
      }
    }
  }

  const staleAllowances = IDENTITY_LITERAL_ALLOWLIST.filter(
    (allowance) => !allowancesSeen.has(allowance.file),
  );
  return { violations, staleAllowances };
}
