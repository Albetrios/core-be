/**
 * Switch the repository's merge + production-deploy governance between two modes
 * and keep the two committed source-of-truth files consistent:
 *
 *   - personal : solo maintainer. 0 required approvals, no CODEOWNER review, a
 *                single production reviewer, self-review allowed. The automated
 *                gates (`Quality gate` + `Checks`) still block every merge.
 *   - team     : four-eyes control. 1 required approval from a CODEOWNER, a push
 *                after approval re-requires review, and the person who ships a
 *                production deploy cannot approve their own deploy.
 *
 * Why a tool instead of hand-editing JSON: the mode-specific fields are COUPLED —
 * turning on `preventSelfReview` while there is a single production reviewer, or
 * `require_code_owner_review` while there is a single CODEOWNER, deadlocks that
 * owner's own PRs / deploys. This tool flips every coupled field atomically and
 * refuses `team` mode when the CODEOWNERS roster cannot support it, so the repo
 * can never land in a deadlocking configuration.
 *
 * Source of truth (edited in place, then pushed by `pnpm github:sync`):
 *   - .github/rulesets/main.json                (pull_request rule parameters)
 *   - .github/environments/production.json      (requiredReviewers + preventSelfReview)
 *   - .github/CODEOWNERS                         (the reviewer roster — read only)
 *
 * Usage:
 *   pnpm github:tool:governance-mode                  # print current mode + roster + next step
 *   pnpm github:tool:governance-mode personal         # apply personal mode
 *   pnpm github:tool:governance-mode team             # apply team mode (needs ≥2 CODEOWNERS owners)
 *   pnpm github:tool:governance-mode --check          # fail if the committed files are inconsistent
 *
 * After applying a mode, run `pnpm github:sync` to push the ruleset + environment
 * protection to GitHub. The `--check` mode is a read-only invariant guard pinned
 * by src/tests/unit/ci/governance-mode.policy.unit.test.ts.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitMetadata } from '@tooling/setup/codegen/project-identity.util.js';
import { loadConfig } from '@tooling/setup/common/config.js';

const projectRoot = resolve(import.meta.dirname, '../../..');
// Resolve the trunk ruleset filename from the canonical config — never a static
// branch name (the ruleset file is `<defaultBranch>.json`).
const DEFAULT_BRANCH = resolveGitMetadata(loadConfig()).defaultBranch;
const MAIN_RULESET_PATH = resolve(projectRoot, `.github/rulesets/${DEFAULT_BRANCH}.json`);
const PRODUCTION_ENVIRONMENT_PATH = resolve(projectRoot, '.github/environments/production.json');
const CODEOWNERS_PATH = resolve(projectRoot, '.github/CODEOWNERS');

/** GitHub caps a deployment-environment's required-reviewer list at six entries. */
const MAX_PRODUCTION_REVIEWERS = 6;

/** The two governance modes this repository switches between. */
export type GovernanceMode = 'personal' | 'team';

interface PullRequestOverlay {
  readonly required_approving_review_count: number;
  readonly require_code_owner_review: boolean;
  readonly require_last_push_approval: boolean;
  readonly dismiss_stale_reviews_on_push: boolean;
}

/**
 * The exact `pull_request` rule parameters that define each mode in
 * `.github/rulesets/main.json`. A file matches a mode only when every field here
 * equals the file's value; anything else is reported as `inconsistent`.
 */
export const PULL_REQUEST_OVERLAY: Readonly<Record<GovernanceMode, PullRequestOverlay>> = {
  personal: {
    required_approving_review_count: 0,
    require_code_owner_review: false,
    require_last_push_approval: false,
    dismiss_stale_reviews_on_push: false,
  },
  team: {
    required_approving_review_count: 1,
    require_code_owner_review: true,
    require_last_push_approval: true,
    dismiss_stale_reviews_on_push: true,
  },
};

interface RulesetRule {
  readonly type: string;
  parameters?: Record<string, unknown>;
}

interface MainRuleset {
  readonly rules: RulesetRule[];
  readonly [key: string]: unknown;
}

interface RequiredReviewers {
  users: string[];
  teams?: string[];
  preventSelfReview?: boolean;
  readonly [key: string]: unknown;
}

interface ProductionEnvironment {
  protection: {
    requiredReviewers?: RequiredReviewers;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/** A single human-readable reason the committed governance files are inconsistent. */
export interface GovernanceIssue {
  readonly dimension: string;
  readonly detail: string;
}

/**
 * Parse `.github/CODEOWNERS` into the distinct owner handles it references, in
 * first-seen order, with the leading `@` stripped.
 *
 * @remarks
 * Comment (`#`) and blank lines are ignored. Each remaining line is
 * `pattern @owner [@owner…]`; only the `@`-prefixed tokens are collected.
 */
export function parseCodeownersOwners(codeownersText: string): string[] {
  const owners: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of codeownersText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    for (const token of line.split(/\s+/).slice(1)) {
      if (!token.startsWith('@')) continue;
      const handle = token.slice(1);
      if (handle !== '' && !seen.has(handle)) {
        seen.add(handle);
        owners.push(handle);
      }
    }
  }
  return owners;
}

/**
 * The subset of CODEOWNERS handles usable as production-environment reviewers:
 * individual users only. Team handles (`@organization/team`, containing a slash) are
 * dropped — they resolve only on organization repositories, not personal ones.
 */
export function codeownerUsers(owners: readonly string[]): string[] {
  return owners.filter((owner) => !owner.includes('/'));
}

function getPullRequestParameters(ruleset: MainRuleset): Record<string, unknown> {
  const rule = ruleset.rules.find((candidate) => candidate.type === 'pull_request');
  if (!rule?.parameters) {
    throw new Error(`${MAIN_RULESET_PATH}: no "pull_request" rule with parameters found.`);
  }
  return rule.parameters;
}

function overlayMatches(parameters: Record<string, unknown>, overlay: PullRequestOverlay): boolean {
  return (Object.entries(overlay) as [keyof PullRequestOverlay, unknown][]).every(
    ([key, value]) => parameters[key] === value,
  );
}

/** Detect which mode a `main.json` ruleset encodes, or `inconsistent` if neither. */
export function detectRulesetMode(ruleset: MainRuleset): GovernanceMode | 'inconsistent' {
  const parameters = getPullRequestParameters(ruleset);
  if (overlayMatches(parameters, PULL_REQUEST_OVERLAY.personal)) return 'personal';
  if (overlayMatches(parameters, PULL_REQUEST_OVERLAY.team)) return 'team';
  return 'inconsistent';
}

interface ProductionReviewerState {
  readonly reviewers: string[];
  readonly preventSelfReview: boolean;
}

function readProductionReviewerState(environment: ProductionEnvironment): ProductionReviewerState {
  const requiredReviewers = environment.protection.requiredReviewers;
  return {
    reviewers: requiredReviewers?.users ?? [],
    preventSelfReview: requiredReviewers?.preventSelfReview === true,
  };
}

/** The mode a `production.json` environment encodes (team ⇔ self-review is prevented). */
export function detectProductionMode(environment: ProductionEnvironment): GovernanceMode {
  return readProductionReviewerState(environment).preventSelfReview ? 'team' : 'personal';
}

interface GovernanceInputs {
  readonly mainRuleset: MainRuleset;
  readonly productionEnvironment: ProductionEnvironment;
  readonly owners: readonly string[];
}

/**
 * Report every reason the committed governance files are inconsistent or would
 * deadlock. An empty array means the two files agree on a mode the CODEOWNERS
 * roster can safely support.
 *
 * @remarks
 * Invariants checked: (1) `main.json` encodes a recognized mode; (2) the ruleset
 * mode equals the production-environment mode; (3) team mode has ≥2 distinct
 * CODEOWNERS users and ≥2 production reviewers; (4) production reviewers are
 * drawn from CODEOWNERS; (5) the deadlock combos (`preventSelfReview` with <2
 * reviewers, `require_code_owner_review` with <2 owners) never occur.
 */
export function findGovernanceIssues(inputs: GovernanceInputs): GovernanceIssue[] {
  const { mainRuleset, productionEnvironment, owners } = inputs;
  const issues: GovernanceIssue[] = [];

  const rulesetMode = detectRulesetMode(mainRuleset);
  if (rulesetMode === 'inconsistent') {
    issues.push({
      dimension: 'main.json',
      detail:
        'pull_request rule parameters match neither the personal nor the team preset — run `pnpm github:tool:governance-mode <personal|team>`.',
    });
  }

  const productionMode = detectProductionMode(productionEnvironment);
  const { reviewers, preventSelfReview } = readProductionReviewerState(productionEnvironment);
  const users = codeownerUsers(owners);

  if (rulesetMode !== 'inconsistent' && rulesetMode !== productionMode) {
    issues.push({
      dimension: 'main.json ↔ production.json',
      detail: `ruleset mode "${rulesetMode}" disagrees with production environment mode "${productionMode}" — reapply with \`pnpm github:tool:governance-mode ${rulesetMode}\`.`,
    });
  }

  const effectiveTeamMode = rulesetMode === 'team' || productionMode === 'team';
  if (effectiveTeamMode) {
    if (users.length < 2) {
      issues.push({
        dimension: 'CODEOWNERS',
        detail: `team mode needs ≥2 distinct CODEOWNERS users; found ${users.length} (${users.join(', ') || 'none'}).`,
      });
    }
    if (reviewers.length < 2) {
      issues.push({
        dimension: 'production.json',
        detail: `team mode needs ≥2 production reviewers so \`preventSelfReview\` cannot deadlock the shipper; found ${reviewers.length}.`,
      });
    }
  }

  // Reviewer roster must come from CODEOWNERS (single source of truth for owners).
  const outsiders = reviewers.filter((reviewer) => !users.includes(reviewer));
  if (outsiders.length > 0) {
    issues.push({
      dimension: 'production.json ↔ CODEOWNERS',
      detail: `production reviewers not present in CODEOWNERS: ${outsiders.join(', ')}.`,
    });
  }

  // Mode-independent deadlock guards.
  if (preventSelfReview && reviewers.length < 2) {
    issues.push({
      dimension: 'production.json',
      detail:
        '`preventSelfReview` is true with <2 reviewers — the only reviewer cannot approve their own deploy.',
    });
  }
  const requireCodeOwnerReview =
    getPullRequestParameters(mainRuleset).require_code_owner_review === true;
  if (requireCodeOwnerReview && users.length < 2) {
    issues.push({
      dimension: 'main.json ↔ CODEOWNERS',
      detail:
        '`require_code_owner_review` is true with <2 CODEOWNERS users — a sole owner cannot approve their own PRs.',
    });
  }

  return issues;
}

interface AppliedGovernance {
  readonly mainRuleset: MainRuleset;
  readonly productionEnvironment: ProductionEnvironment;
  readonly reviewers: string[];
}

/**
 * Return copies of the two governance files patched to the requested mode.
 *
 * @remarks
 * Throws when `team` mode is requested but the CODEOWNERS roster has fewer than
 * two individual users — applying it anyway would deadlock. Only the coupled
 * fields are touched; every other field in each file is preserved verbatim.
 */
export function applyGovernanceMode(inputs: {
  readonly mode: GovernanceMode;
  readonly mainRuleset: MainRuleset;
  readonly productionEnvironment: ProductionEnvironment;
  readonly owners: readonly string[];
}): AppliedGovernance {
  const { mode, mainRuleset, productionEnvironment, owners } = inputs;
  const users = codeownerUsers(owners);
  if (users.length === 0) {
    throw new Error('CODEOWNERS lists no individual users — cannot pick a production reviewer.');
  }
  if (mode === 'team' && users.length < 2) {
    throw new Error(
      `team mode needs ≥2 distinct CODEOWNERS users; found ${users.length} (${users.join(', ') || 'none'}). ` +
        'Add owners to .github/CODEOWNERS first, then re-run.',
    );
  }

  const nextMainRuleset = structuredClone(mainRuleset);
  const parameters = getPullRequestParameters(nextMainRuleset);
  Object.assign(parameters, PULL_REQUEST_OVERLAY[mode]);

  const nextEnvironment = structuredClone(productionEnvironment);
  const requiredReviewers: RequiredReviewers = nextEnvironment.protection.requiredReviewers ?? {
    users: [],
    teams: [],
    preventSelfReview: false,
  };
  const reviewers =
    mode === 'team' ? users.slice(0, MAX_PRODUCTION_REVIEWERS) : [users[0] as string];
  requiredReviewers.users = reviewers;
  requiredReviewers.preventSelfReview = mode === 'team';
  nextEnvironment.protection.requiredReviewers = requiredReviewers;

  return { mainRuleset: nextMainRuleset, productionEnvironment: nextEnvironment, reviewers };
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function loadGovernanceInputs(): GovernanceInputs {
  return {
    mainRuleset: readJsonFile<MainRuleset>(MAIN_RULESET_PATH),
    productionEnvironment: readJsonFile<ProductionEnvironment>(PRODUCTION_ENVIRONMENT_PATH),
    owners: parseCodeownersOwners(readFileSync(CODEOWNERS_PATH, 'utf-8')),
  };
}

function printStatus(inputs: GovernanceInputs): void {
  const rulesetMode = detectRulesetMode(inputs.mainRuleset);
  const productionMode = detectProductionMode(inputs.productionEnvironment);
  const users = codeownerUsers(inputs.owners);
  const issues = findGovernanceIssues(inputs);

  console.log('Governance mode');
  console.log('---------------');
  console.log(`Ruleset (main.json):        ${rulesetMode}`);
  console.log(`Production (production.json): ${productionMode}`);
  console.log(`CODEOWNERS users (${users.length}):        ${users.join(', ') || 'none'}`);
  console.log(`Team mode available:        ${users.length >= 2 ? 'yes' : 'no (need ≥2 owners)'}`);
  console.log('');
  if (issues.length > 0) {
    console.log('Inconsistencies:');
    for (const issue of issues) console.log(`  - [${issue.dimension}] ${issue.detail}`);
    console.log('');
  }
  console.log(
    'Switch:  pnpm github:tool:governance-mode <personal|team>   then   pnpm github:sync',
  );
}

function runApply(mode: GovernanceMode, inputs: GovernanceInputs): void {
  const applied = applyGovernanceMode({
    mode,
    mainRuleset: inputs.mainRuleset,
    productionEnvironment: inputs.productionEnvironment,
    owners: inputs.owners,
  });
  writeJsonFile(MAIN_RULESET_PATH, applied.mainRuleset);
  writeJsonFile(PRODUCTION_ENVIRONMENT_PATH, applied.productionEnvironment);

  console.log(`Applied "${mode}" governance mode:`);
  console.log(`  .github/rulesets/main.json         pull_request → ${mode} preset`);
  console.log(
    `  .github/environments/production.json  reviewers=[${applied.reviewers.join(', ')}], preventSelfReview=${mode === 'team'}`,
  );
  console.log('');
  console.log(
    'Next: run `pnpm github:sync` to push the ruleset + environment protection to GitHub.',
  );
}

function runCheck(inputs: GovernanceInputs): never {
  const issues = findGovernanceIssues(inputs);
  if (issues.length === 0) {
    console.log('Governance files are consistent.');
    process.exit(0);
  }
  console.error('Governance files are inconsistent:');
  for (const issue of issues) console.error(`  - [${issue.dimension}] ${issue.detail}`);
  console.error('\nReapply a mode with `pnpm github:tool:governance-mode <personal|team>`.');
  process.exit(1);
}

/** CLI entry point — status (no args), apply a mode, or `--check` the committed files. */
export function main(): void {
  const argumentsList = process.argv.slice(2);

  if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
    console.log('Usage: pnpm github:tool:governance-mode [personal | team | --check]');
    console.log('');
    console.log('  (no args)   Print the current mode, CODEOWNERS roster, and next step');
    console.log('  personal    Apply solo-maintainer governance (0 approvals, self-review ok)');
    console.log('  team        Apply four-eyes governance (needs ≥2 CODEOWNERS owners)');
    console.log('  --check     Exit non-zero if the committed governance files are inconsistent');
    return;
  }

  const inputs = loadGovernanceInputs();

  if (argumentsList.includes('--check')) {
    runCheck(inputs);
  }

  const modeArgument = argumentsList.find((argument) => !argument.startsWith('-'));
  if (modeArgument === undefined) {
    printStatus(inputs);
    return;
  }
  if (modeArgument !== 'personal' && modeArgument !== 'team') {
    throw new Error(`Unknown mode "${modeArgument}". Use "personal", "team", or --check.`);
  }

  runApply(modeArgument, inputs);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
