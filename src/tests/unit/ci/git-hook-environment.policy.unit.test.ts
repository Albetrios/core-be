import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  gitEnvironmentWithoutInheritedRepository,
  INHERITED_GIT_REPOSITORY_VARIABLES,
} from '@tooling/setup/common/git-environment.js';

/**
 * Git exports GIT_DIR and friends into every hook it runs, and the hook's whole process tree
 * inherits them. They outrank `cwd`, so a directory-scoped `git` call in tooling silently answers
 * for the hook's repository instead — reading the wrong tree, or, for a write, overwriting the
 * developer's index with a throwaway fixture's contents.
 *
 * `tooling/**\/*.ts` is the scanned surface. `src/scripts/tooling/run-pre-commit-guard.ts` is
 * deliberately NOT in it: it stages and inspects the real index from inside the pre-commit hook,
 * which is exactly the inheritance every other call site has to shed.
 */
const TOOLING_ROOT = join(process.cwd(), 'tooling');
const HELPER_FILE = 'tooling/setup/common/git-environment.ts';
const HELPER_NAME = 'gitEnvironmentWithoutInheritedRepository';

/** A `git` command handed to a child-process helper, as a string literal. */
const GIT_COMMAND_PATTERN = /(['"`])git(?:\1|\s)/;

/** Files known to shell out to git — pins the scan against a regex that quietly stops matching. */
const KNOWN_GIT_CALLERS: readonly string[] = [
  'tooling/agent-os/plan-skills.ts',
  'tooling/setup/codegen/validate-project-identity-literals.ts',
  'tooling/setup/github/rulesets.ts',
  'tooling/setup/init-project.ts',
];

function collectToolingFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) collectToolingFiles(absolutePath, collected);
    else if (entry.name.endsWith('.ts')) collected.push(absolutePath);
  }
  return collected;
}

function findGitCallers(): { callers: string[]; unguarded: string[] } {
  const callers: string[] = [];
  const unguarded: string[] = [];
  for (const absolutePath of collectToolingFiles(TOOLING_ROOT)) {
    const relativePath = relative(process.cwd(), absolutePath);
    if (relativePath === HELPER_FILE) continue;
    const content = readFileSync(absolutePath, 'utf-8');
    // Only lines that hand a command to a child process — not prose or a `type: 'git'` field.
    const invokes = content
      .split('\n')
      .some(
        (line) =>
          GIT_COMMAND_PATTERN.test(line) &&
          /exec(?:File)?Sync\(|spawnSync\(|\brun\(/.test(line.replace(/\/\/.*$/, '')),
      );
    if (!invokes) continue;
    callers.push(relativePath);
    if (!content.includes(HELPER_NAME)) unguarded.push(relativePath);
  }
  return { callers, unguarded };
}

describe('git hook environment — inherited repository variables', () => {
  it('pins the variables git exports into a hook', () => {
    // Pinned as an exact set: dropping one is invisible end-to-end, because a leaked
    // GIT_INDEX_FILE makes the fixture's write and the gate's read land in the same wrong
    // place, and the two errors cancel.
    expect([...INHERITED_GIT_REPOSITORY_VARIABLES]).toEqual([
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_WORK_TREE',
      'GIT_PREFIX',
      'GIT_OBJECT_DIRECTORY',
      'GIT_COMMON_DIR',
      'GIT_NAMESPACE',
    ]);
  });

  it('removes every pinned variable and passes the rest through', () => {
    const restore = new Map(
      INHERITED_GIT_REPOSITORY_VARIABLES.map((variable) => [variable, process.env[variable]]),
    );
    try {
      for (const variable of INHERITED_GIT_REPOSITORY_VARIABLES) {
        process.env[variable] = `/somewhere/else/${variable}`;
      }
      const environment = gitEnvironmentWithoutInheritedRepository();

      for (const variable of INHERITED_GIT_REPOSITORY_VARIABLES) {
        expect(
          environment[variable],
          `${variable} must not reach the child process`,
        ).toBeUndefined();
        // PATH, credential helpers and proxy settings have to survive, so the strip is
        // surgical — never a blank environment.
        expect(process.env[variable], `${variable} must not be mutated in-process`).toBe(
          `/somewhere/else/${variable}`,
        );
      }
      expect(environment.PATH).toBe(process.env.PATH);
    } finally {
      for (const [variable, value] of restore) {
        if (value === undefined) delete process.env[variable];
        else process.env[variable] = value;
      }
    }
  });

  it('strips the inherited repository in every tooling file that shells out to git', () => {
    const { callers, unguarded } = findGitCallers();
    // Anti-vacuity: an empty scan would satisfy the assertion below for free.
    expect(callers).toEqual(expect.arrayContaining([...KNOWN_GIT_CALLERS]));
    expect(unguarded).toEqual([]);
  });
});
