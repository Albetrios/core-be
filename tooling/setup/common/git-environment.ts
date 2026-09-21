/**
 * Detaching a child `git` process from the repository its parent was pinned to.
 *
 * @remarks
 * Git exports {@link INHERITED_GIT_REPOSITORY_VARIABLES} into every hook it
 * runs, and a hook's whole process tree inherits them. They take precedence
 * over `cwd`, so an invocation that looks directory-scoped —
 * `execFileSync('git', […], { cwd })` — silently operates on the hook's
 * repository instead. Two ways that bites:
 *
 * - A throwaway repository built under `os.tmpdir()` never gets one: `git init`
 *   re-initializes the inherited gitdir and `git add` overwrites the real index,
 *   leaving the host repository with the fixture's files staged and everything
 *   else staged as a deletion.
 * - A read scoped to a `projectRoot` argument answers for the inherited
 *   repository instead, so a directory-scoped gate reports on a tree it was
 *   never pointed at — and passes vacuously when no path lines up.
 *
 * Do NOT use this in code that is *meant* to act on the hook's repository:
 * `src/scripts/tooling/run-pre-commit-guard.ts` stages and inspects the real
 * index on purpose, and stripping these there would break it.
 */

/** The variables git exports into hooks that pin a child `git` process to a repository. */
export const INHERITED_GIT_REPOSITORY_VARIABLES: readonly string[] = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
];

/**
 * Build an environment for a `git` child process that honors `cwd` instead of
 * an inherited repository.
 *
 * @remarks
 * Algorithm: copy `process.env`, delete every name in
 * {@link INHERITED_GIT_REPOSITORY_VARIABLES}, return the copy. Removing them
 * rather than overriding them restores git's normal discovery — the repository
 * is found from `cwd`, which is what every call site already means. The rest of
 * the environment passes through untouched, so PATH, credential helpers and
 * proxy settings keep working.
 *
 * Failure modes: none — a variable that is already absent is simply not present.
 *
 * Side effects: none; `process.env` is not mutated.
 *
 * @example
 * ```ts
 * execFileSync('git', ['ls-files', '-z'], {
 *   cwd: projectRoot,
 *   env: gitEnvironmentWithoutInheritedRepository(),
 * });
 * ```
 */
export function gitEnvironmentWithoutInheritedRepository(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of INHERITED_GIT_REPOSITORY_VARIABLES) {
    delete environment[variable];
  }
  return environment;
}
