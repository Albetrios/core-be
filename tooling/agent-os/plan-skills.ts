#!/usr/bin/env tsx
/**
 * agent-os plan-skills — given a changeset (explicit file args, or --diff vs a
 * base branch), compute the exact ordered series of skill chains to run by
 * matching changed files against the chain triggers in agent-os/skills/chains.json.
 * Output is a checklist the agent (or a human) follows in order — turning "here
 * are some skills" into "here is the precise ordered plan" for what changed.
 *
 * Usage:
 *   tsx tooling/agent-os/plan-skills.ts <file> [<file> ...]
 *   tsx tooling/agent-os/plan-skills.ts --diff [base]   # base default: origin/<git.defaultBranch>
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGitMetadata } from '@tooling/setup/codegen/project-identity.util.js';
import { loadConfig } from '@tooling/setup/common/config.js';
import { gitEnvironmentWithoutInheritedRepository } from '@tooling/setup/common/git-environment.js';

const repositoryRoot = process.cwd();
// Resolve the trunk from setup.config.json rather than hardcoding it (no-static-branch-names).
const DEFAULT_BRANCH = resolveGitMetadata(loadConfig()).defaultBranch;

interface ChainDefinition {
  description?: string;
  trigger?: string;
  steps?: string[];
  optional?: string[];
}

/** Minimal glob -> RegExp supporting `**`, `*`, and `{a,b}` (enough for chain triggers). */
function globToRegExp(glob: string): RegExp {
  const globStar = '__GLOBSTAR__';
  const pattern = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_match, group: string) => `(?:${group.split(',').join('|')})`)
    .replace(/\*\*/g, globStar)
    .replace(/\*/g, '[^/]*')
    .replaceAll(globStar, '.*');
  return new RegExp(`^${pattern}$`);
}

/** Changed files from `git diff <base>...HEAD` plus the uncommitted working tree. */
function changedFromGit(base: string): string[] {
  const run = (command: string): string[] => {
    try {
      return execSync(command, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        // A hook's GIT_DIR/GIT_PREFIX outrank `cwd`: without the strip this
        // reports another repository's diff, and `git status --porcelain`
        // prints paths relative to the prefix rather than the repository root.
        env: gitEnvironmentWithoutInheritedRepository(),
      })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const committed = run(`git diff --name-only ${base}...HEAD`);
  const working = run('git status --porcelain')
    .map((line) => line.slice(3))
    .filter(Boolean);
  return [...new Set([...committed, ...working])];
}

const args = process.argv.slice(2);
let files: string[];
if (args.includes('--diff')) {
  const after = args[args.indexOf('--diff') + 1];
  const base = after && !after.startsWith('-') ? after : `origin/${DEFAULT_BRANCH}`;
  files = changedFromGit(base);
} else {
  files = args.filter((argument) => !argument.startsWith('-'));
}

const chains =
  (
    JSON.parse(readFileSync(join(repositoryRoot, 'agent-os/skills/chains.json'), 'utf8')) as {
      chains?: Record<string, ChainDefinition>;
    }
  ).chains ?? {};

const applicable: Array<{ name: string; definition: ChainDefinition; matched: string[] }> = [];
for (const [name, definition] of Object.entries(chains)) {
  if (!definition.trigger) continue;
  const regExp = globToRegExp(definition.trigger);
  const matched = files.filter((file) => regExp.test(file));
  if (matched.length) applicable.push({ name, definition, matched });
}

console.log(`\nagent-os plan-skills - ${files.length} changed file(s)\n`);
if (!files.length) {
  console.log('  (no files - pass file paths or use --diff)\n');
  process.exit(0);
}
if (!applicable.length) {
  console.log(
    '  No chain trigger matched. For single-file changes consult agent-os/docs/skill-triggers.md',
  );
  console.log('  (the file->skill map) and run the listed skill(s) directly.\n');
  process.exit(0);
}

const ordered: string[] = [];
for (const { name, definition, matched } of applicable) {
  console.log(`> ${name}  (trigger: ${definition.trigger}; ${matched.length} file[s])`);
  (definition.steps ?? []).forEach((step, index) => {
    console.log(`   ${index + 1}. ${step}`);
    if (!ordered.includes(step)) ordered.push(step);
  });
  if (definition.optional?.length)
    console.log(`   (+ optional: ${definition.optional.join(', ')})`);
  console.log('');
}
console.log(`Ordered skill series (deduped): ${ordered.join(' -> ')}`);
console.log('Then finish green: pnpm validate + pnpm agent-os:check.\n');
