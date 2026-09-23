import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGitMetadata } from '@tooling/setup/codegen/project-identity.util.js';
import { loadConfig } from '@tooling/setup/common/config.js';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the single-aggregate PR merge gate.
 *
 * The default-branch ruleset requires exactly two bare contexts — `Quality gate` (the pr-ci.yml
 * aggregate) and `Checks` (pr-governance.yml). The aggregate rolls up every required PR-CI lane via
 * its `needs:` list, so adding, removing, or renaming a lane changes ONLY that list — never the
 * ruleset, never a `pnpm github:sync`. That is what removes the class of "a job rename silently
 * disabled a required check" drift the old 13-explicit-context model was exposed to.
 *
 * This test pins both halves of the invariant so the drift cannot come back:
 *   1. the ruleset requires exactly {Quality gate, Checks} — nobody re-expands to per-lane contexts
 *      (which reintroduces the drift) or drops the aggregate (which un-gates everything);
 *   2. the `quality-gate` job exists, runs `if: always()` (so a legitimately skipped lane still
 *      evaluates), and `needs:` every merge-gating lane — nobody silently excludes a lane from the
 *      rollup.
 */
const prCiPath = join(process.cwd(), '.github/workflows/pr-ci.yml');
// Resolve the trunk from the canonical config (tooling/setup/setup.config.json →
// git.defaultBranch) — no static branch name. The ruleset file is `<branch>.json`.
const DEFAULT_BRANCH = resolveGitMetadata(loadConfig()).defaultBranch;
const rulesetPath = join(process.cwd(), `.github/rulesets/${DEFAULT_BRANCH}.json`);

/**
 * The merge-gating PR-CI lanes the aggregate must depend on. Job ids (not display names) — these are
 * the `- <id>` entries under `quality-gate.needs`. `unit` and `matrix` are the always-runs wrapper
 * gates that normalise a skipped suite to a pass. `agent-os-gate` only runs on agent-os/** changes and
 * skip-counts as a pass otherwise. Promote an advisory lane to blocking by adding it to the
 * aggregate's `needs:` AND to this list.
 */
const REQUIRED_LANES = [
  'lint',
  'typecheck',
  'static-sync',
  'agent-os-gate',
  'unit',
  'matrix',
  'migration-lint',
  'knip',
  'build-verify',
  'security-audit',
  'security-secrets',
  'security-sast',
  'security-iac',
  'dependency-review',
  'contract-property',
  'rls-security',
  'rls-application-role',
  'actionlint',
] as const;

const EXPECTED_REQUIRED_CONTEXTS = ['Checks', 'Quality gate'];

interface BranchRuleset {
  rules: {
    type: string;
    parameters?: { required_status_checks?: { context: string }[] };
  }[];
}

/**
 * quality-gate is the final job in pr-ci.yml, so slicing from its header to EOF scopes `needs:`
 * assertions to the aggregate (a `- lint` elsewhere in the file cannot produce a false pass).
 */
function qualityGateBlock(prCiText: string): string {
  const start = prCiText.indexOf('\n  quality-gate:');
  expect(start, 'pr-ci.yml must declare the quality-gate aggregate job').toBeGreaterThan(-1);
  return prCiText.slice(start);
}

describe('pr-ci.yml declares the quality-gate aggregate', () => {
  const prCi = readFileSync(prCiPath, 'utf8');
  const block = qualityGateBlock(prCi);

  it('exposes the bare check context `Quality gate`', () => {
    // The ruleset requires the bare job `name:`, never a workflow-prefixed form.
    expect(block).toContain('name: Quality gate');
  });

  it('runs even when upstream lanes are skipped or failed (`if: always()`)', () => {
    expect(block).toContain('if: always()');
  });

  it('depends on every merge-gating lane', () => {
    for (const lane of REQUIRED_LANES) {
      expect(block, `quality-gate must \`needs:\` the ${lane} lane`).toContain(`- ${lane}`);
    }
  });

  it('treats only success/skipped as a pass (a real failure fails the gate)', () => {
    expect(block).toContain('"success"');
    expect(block).toContain('"skipped"');
    expect(block).toContain('exit 1');
  });
});

describe('the default-branch ruleset requires exactly the two aggregate contexts', () => {
  it('lists {Quality gate, Checks} and nothing else', () => {
    const ruleset = JSON.parse(readFileSync(rulesetPath, 'utf8')) as BranchRuleset;

    const requiredContexts = ruleset.rules
      .find((rule) => rule.type === 'required_status_checks')
      ?.parameters?.required_status_checks?.map((check) => check.context)
      .sort();

    expect(
      requiredContexts,
      `${DEFAULT_BRANCH}.json must declare required_status_checks`,
    ).toBeDefined();
    // Exact equality: re-adding per-lane contexts (drift) or dropping the aggregate (un-gating) both
    // fail here. Grow coverage by extending quality-gate.needs, not this list.
    expect(requiredContexts).toEqual(EXPECTED_REQUIRED_CONTEXTS);
  });
});
