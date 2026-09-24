import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the env-driven-config model (no NODE_ENV branching).
 *
 * Two invariants, both source-text scans (like no-stripe-shaped-literals) so a regression is caught
 * at the global suite / pre-commit rather than weeks later in a deploy:
 *
 *  1. **NODE_ENV is compared ONLY inside `env-schema.ts`** — the enum field plus the `.refine()`
 *     production constraints on parsed `data`. No other runtime, test, or tooling module compares or
 *     branches on NODE_ENV; every behaviour reads an explicit env flag that has a STATIC default. (The
 *     pre-schema `load-env-files.ts` loader *reads* `process.env.NODE_ENV` to name the `.env.<NODE_ENV>`
 *     file, but performs no comparison — so it needs no allowlist entry.)
 *  2. **NODE_ENV is never `test` / `staging`** — the enum is exactly `local | development | production`.
 *     `local` is a valid runtime value (the developer's machine, primary file `.env.local`); `test` and
 *     `staging` are NOT — the Vitest suite runs as `development`, and there is no `staging` environment.
 *     No source, harness, CI workflow, or Docker file assigns or compares NODE_ENV to a removed value.
 *
 * When adding an environment-varying behaviour: add a flag with a static production-safe default and a
 * production `.refine()` in `env-schema.ts`, read that flag, and set the dev value in `.env.example` /
 * the test harness. See `agent-os/skills/be-env-schema-add/SKILL.md`.
 */
describe('Global: no NODE_ENV branching, no removed env values (env-driven-config guard)', () => {
  const SKIP_EXTENSIONS = new Set<string>([
    '.json',
    '.snap',
    '.md',
    '.txt',
    '.svg',
    '.png',
    '.jpg',
    '.ico',
    '.lock',
  ]);
  const SKIP_DIRECTORIES = new Set<string>([
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.git',
    '__snapshots__',
    // Runtime-generated DB Viewer history — not source, can be large.
    '.db-viewer-history',
  ]);

  // NODE_ENV comparisons are legitimate ONLY inside env-schema.ts: the enum + the production
  // `.refine()`s (parsed data). The env-file loader reads NODE_ENV to name `.env.<NODE_ENV>` but does
  // NOT compare it, so it is intentionally NOT allowlisted here.
  const COMPARISON_ALLOWLIST = new Set<string>([
    'src/shared/config/env-schema.ts',
    // This test file — its own pattern/error strings mention NODE_ENV comparisons.
    'src/tests/global/no-nodeenv-branching.global.test.ts',
  ]);

  const CODE_ROOTS = ['src', 'tooling'] as const;
  // The removed-value scan additionally covers deploy surfaces where NODE_ENV=test used to live.
  const VALUE_EXTRA_ROOTS = ['.github/workflows'] as const;
  const VALUE_EXTRA_FILES = ['Dockerfile', 'Dockerfile.worker', 'docker-compose.yml'] as const;

  const COMPARISON = /NODE_ENV\s*(===|!==|==|!=)\s*['"`]/;
  // `local` is a VALID runtime value (developer machine); only `test` / `staging` are removed.
  const REMOVED_VALUE = /NODE_ENV[\s:=]{1,8}['"`]?(test|staging)\b/i;

  function isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('#')
    );
  }

  async function* walkFiles(directory: string): AsyncGenerator<string> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        yield* walkFiles(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const dotIndex = entry.name.lastIndexOf('.');
      const extension = dotIndex === -1 ? '' : entry.name.slice(dotIndex);
      if (SKIP_EXTENSIONS.has(extension)) continue;
      yield entryPath;
    }
  }

  async function collectFiles(roots: readonly string[]): Promise<string[]> {
    const repositoryRoot = process.cwd();
    const files: string[] = [];
    for (const root of roots) {
      for await (const absolutePath of walkFiles(join(repositoryRoot, root))) {
        files.push(absolutePath.slice(repositoryRoot.length + 1));
      }
    }
    return files;
  }

  it('compares NODE_ENV only inside env-schema.ts (no NODE_ENV branching in runtime/test/tooling code)', async () => {
    const violations: string[] = [];
    for (const relativePath of await collectFiles(CODE_ROOTS)) {
      if (COMPARISON_ALLOWLIST.has(relativePath)) continue;
      const lines = (await fs.readFile(relativePath, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (COMPARISON.test(line)) {
          violations.push(`  ${relativePath}:${index + 1} — ${line.trim().slice(0, 100)}`);
        }
      });
    }

    if (violations.length > 0) {
      throw new Error(
        'NODE_ENV is compared outside env-schema.ts. Runtime code must NEVER branch on NODE_ENV — ' +
          'add an explicit env flag (static production-safe default + a production `.refine()`) in ' +
          'env-schema.ts and read that flag instead (see agent-os/skills/be-env-schema-add/SKILL.md):\n' +
          violations.join('\n'),
      );
    }
    expect(violations).toEqual([]);
  }, 30_000);

  it('never sets or compares NODE_ENV to test / staging (enum is local | development | production)', async () => {
    const scanFiles = [
      ...(await collectFiles([...CODE_ROOTS, ...VALUE_EXTRA_ROOTS])),
      ...VALUE_EXTRA_FILES,
    ];
    const violations: string[] = [];
    for (const relativePath of scanFiles) {
      if (relativePath === 'src/tests/global/no-nodeenv-branching.global.test.ts') continue;
      let text: string;
      try {
        text = await fs.readFile(relativePath, 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (REMOVED_VALUE.test(line)) {
          violations.push(`  ${relativePath}:${index + 1} — ${line.trim().slice(0, 100)}`);
        }
      });
    }

    if (violations.length > 0) {
      throw new Error(
        'NODE_ENV set/compared to a removed value (test/staging). The enum is exactly ' +
          '`local | development | production`; the Vitest suite runs as `development` with explicit ' +
          'test-affordance flags. Use `development` and drive behaviour via env flags:\n' +
          violations.join('\n'),
      );
    }
    expect(violations).toEqual([]);
  }, 30_000);
});
