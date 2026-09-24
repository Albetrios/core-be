import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeCoverage,
  loadNightlyScenarioFiles,
  loadRoutes,
} from '@tooling/ci/check-load-coverage.mjs';

const workflowPath = join(process.cwd(), '.github/workflows/scheduled-k6-load-slo.yml');
const configPath = join(process.cwd(), 'src/tests/load/k6/helpers/config.js');
const coverageBudget = JSON.parse(
  readFileSync(join(process.cwd(), 'tooling/ci/load-coverage-budget.json'), 'utf8'),
) as { nightlyCoveredRoutes: number };

const gatedScenarios = [
  'health-stress.js',
  'api-stress.js',
  'login-smoke.js',
  'permission-cached.js',
  'stripe-webhook-ingest.js',
  'idempotency-storm.js',
];

describe('k6 coverage policy (#67)', () => {
  it('runs gated scenarios with SLO thresholds in nightly workflow', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const gateSection = workflow.slice(
      workflow.indexOf('Gate — health'),
      workflow.indexOf('k6 auth-onboarding'),
    );

    for (const scenario of gatedScenarios) {
      expect(gateSection).toContain(scenario);
    }
    expect(gateSection).toContain('id: gate');
    expect(workflow).toContain('Enforce gate success (SLO)');
  });

  it('defines smoke thresholds without minimum req/s for low-VU scenarios', () => {
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('SMOKE_THRESHOLDS');
    expect(config).not.toMatch(/SMOKE_THRESHOLDS[\s\S]*http_reqs/);
  });

  it('marks expected non-2xx responses in coverage scenarios', () => {
    const stripe = readFileSync(
      join(process.cwd(), 'src/tests/load/k6/scenarios/stripe-webhook-ingest.js'),
      'utf8',
    );
    const idempotency = readFileSync(
      join(process.cwd(), 'src/tests/load/k6/scenarios/idempotency-storm.js'),
      'utf8',
    );

    expect(stripe).toContain('expectedStatuses(400)');
    expect(idempotency).toContain('expectedStatuses(200, 200, 409, 422)');
  });

  it('never load-tests fewer routes nightly than the recorded budget (a ratchet)', () => {
    const { covered, required } = computeCoverage({
      routes: loadRoutes(),
      scenarios: loadNightlyScenarioFiles(),
    });

    expect(
      covered.length,
      `The nightly now load-tests ${covered.length} of ${required.length} routes, below the budget of ` +
        `${coverageBudget.nightlyCoveredRoutes} — restore the scenario, or see 'pnpm load:coverage --nightly'.`,
    ).toBeGreaterThanOrEqual(coverageBudget.nightlyCoveredRoutes);
  });
});
