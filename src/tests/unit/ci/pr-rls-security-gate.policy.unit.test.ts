import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGitMetadata } from '@tooling/setup/codegen/project-identity.util.js';
import { loadConfig } from '@tooling/setup/common/config.js';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard: the non-superuser RLS suite must run on the PR gate, not post-merge only.
 *
 * FORCE ROW LEVEL SECURITY bugs are invisible under the local/CI superuser; they surface only when
 * tests run as the non-superuser `core_be_app` role against a real Postgres. The organization-mandated-MFA
 * bypass reached production partly because the RLS suite ran post-merge only — too late to block the
 * merge. This test fails if the PR-gate RLS job is removed, stops running the `rls` test directory,
 * or loses its database.
 */
const prCiPath = join(process.cwd(), '.github/workflows/pr-ci.yml');
// Trunk resolved from the canonical config (git.defaultBranch) — no static branch name.
const DEFAULT_BRANCH = resolveGitMetadata(loadConfig()).defaultBranch;

describe('PR CI runs the non-superuser RLS security suite against Postgres', () => {
  const prCi = readFileSync(prCiPath, 'utf8');

  it('declares the rls-security job', () => {
    expect(prCi).toContain('rls-security:');
    // Exact display name — the required-check context (`RLS security (non-superuser)`)
    // in .github/rulesets/*.json is derived from it, so a rename here must stay in sync.
    expect(prCi).toContain('name: RLS security (non-superuser)');
  });

  it('runs the RLS test directory under the security project', () => {
    expect(prCi).toContain('--project security src/tests/security/rls');
  });

  it('provisions Postgres and migrates before the suite (the RLS tests need a real database)', () => {
    expect(prCi).toContain('postgres:17');
    // `pnpm db:migrate` (not `:lint`) appears only in the DB-backed RLS jobs within pr-ci.yml.
    expect(prCi).toContain('pnpm db:migrate\n');
  });

  it('skips docs-only PRs but runs on source/ci changes', () => {
    expect(prCi).toContain("needs.changes.outputs.docs-only-md != 'true'");
    expect(prCi).toContain("needs.changes.outputs.src-code == 'true'");
  });
});

/**
 * The policy lane above opts INTO `core_be_app` per statement; this lane opens the whole pool as
 * `core_be_app`, so application code paths are RLS-subject too. A query that runs without a
 * database context reads zero rows there and in production, but every row on the RLS-exempt
 * superuser the other lanes use — which is how offboarding came to erase nothing with every check
 * green. It must stay a PR gate, run as the role, and migrate before the role is applied.
 */
describe('PR CI runs the application-role lane against Postgres', () => {
  const prCi = readFileSync(prCiPath, 'utf8');
  const start = prCi.indexOf('\n  rls-application-role:');
  const job = prCi.slice(start, prCi.indexOf('\n  build-verify:', start));

  it('declares the rls-application-role job', () => {
    expect(start, 'pr-ci.yml must declare the rls-application-role job').toBeGreaterThan(-1);
    expect(job).toContain('name: RLS application role (whole connection)');
  });

  it('migrates as the superuser, then runs the suites as the application role', () => {
    expect(job).toContain('postgres:17');
    const migrateAt = job.indexOf('pnpm db:migrate\n');
    const roleRunAt = job.indexOf('pnpm test:rls-role');
    expect(migrateAt).toBeGreaterThan(-1);
    expect(roleRunAt).toBeGreaterThan(migrateAt);
  });

  it('skips docs-only PRs but runs on source/ci changes', () => {
    expect(job).toContain("needs.changes.outputs.docs-only-md != 'true'");
    expect(job).toContain("needs.changes.outputs.src-code == 'true'");
  });
});

/**
 * The RLS job is a real merge gate only if a REQUIRED status check depends on it — otherwise a red
 * RLS run does not block the merge. Under the single-aggregate model that dependency is INDIRECT:
 * branch protection requires just the bare `Quality gate` context (GitHub reports a check context as
 * the bare job `name:`, never workflow-prefixed), and the `quality-gate` job `needs:` the
 * `rls-security` lane — so a red RLS run fails the aggregate and blocks the merge. These assertions
 * fail if the ruleset drops `Quality gate`, or the aggregator stops depending on `rls-security`
 * (either would silently un-gate RLS). The generic ruleset ↔ needs invariant is pinned by
 * pr-quality-gate.policy.unit.test.ts; this keeps a dedicated tripwire on the RLS lane specifically.
 */
const REQUIRED_AGGREGATE_CONTEXT = 'Quality gate';
const RLS_LANES = ['rls-security', 'rls-application-role'] as const;

interface BranchRuleset {
  rules: {
    type: string;
    parameters?: { required_status_checks?: { context: string }[] };
  }[];
}

describe.each([DEFAULT_BRANCH])(
  'the %s ruleset gates RLS through the quality-gate aggregate',
  (branch) => {
    it('requires the Quality gate aggregate context', () => {
      const ruleset = JSON.parse(
        readFileSync(join(process.cwd(), `.github/rulesets/${branch}.json`), 'utf8'),
      ) as BranchRuleset;

      const requiredContexts = ruleset.rules
        .find((rule) => rule.type === 'required_status_checks')
        ?.parameters?.required_status_checks?.map((check) => check.context);

      expect(requiredContexts, `${branch}.json must declare required_status_checks`).toBeDefined();
      expect(requiredContexts).toContain(REQUIRED_AGGREGATE_CONTEXT);
    });

    it.each(RLS_LANES)('makes the quality-gate aggregate depend on the %s lane', (lane) => {
      // quality-gate is the final job in pr-ci.yml — slice from its header to EOF so
      // the `- <lane>` match is scoped to the aggregate's `needs:` list.
      const prCiText = readFileSync(prCiPath, 'utf8');
      const start = prCiText.indexOf('\n  quality-gate:');
      expect(start, 'pr-ci.yml must declare the quality-gate aggregate job').toBeGreaterThan(-1);
      expect(prCiText.slice(start)).toContain(`- ${lane}`);
    });
  },
);

/**
 * Single-trunk: the trunk is maintained solo, so its ruleset requires status checks but
 * **0 approvals** (D8) — a red check (incl. RLS) still blocks the merge, but the author isn't locked
 * out waiting for an approval they can't give (the pre-migration params — 1 approval + code-owner +
 * last-push — were promotion-gate settings that locked out solo merges). Guard against a silent
 * regression to a non-zero count. Change this deliberately if/when a second reviewer is added.
 */
it('the default-branch ruleset requires 0 approvals (solo maintainer — checks still block merge)', () => {
  const ruleset = JSON.parse(
    readFileSync(join(process.cwd(), `.github/rulesets/${DEFAULT_BRANCH}.json`), 'utf8'),
  ) as { rules: { type: string; parameters?: { required_approving_review_count?: number } }[] };

  const pullRequestRule = ruleset.rules.find((rule) => rule.type === 'pull_request');
  expect(
    pullRequestRule,
    `${DEFAULT_BRANCH}.json must keep a pull_request rule (changes go via a PR)`,
  ).toBeDefined();
  expect(pullRequestRule?.parameters?.required_approving_review_count).toBe(0);
});
