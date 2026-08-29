import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deployTool = readFileSync('tooling/setup/railway/deploy-image.ts', 'utf8');
const envValidator = readFileSync('tooling/setup/github/validate-environment-runtime.ts', 'utf8');
const deployWorkflow = readFileSync('.github/workflows/reusable-railway-deploy.yml', 'utf8');

/**
 * Code body only — the file's TSDoc header documents the GraphQL call order and
 * names the Railway CLI commands it deliberately avoids, so asserting against the
 * whole file would match the prose rather than the implementation.
 */
const deployToolCode = deployTool.slice(deployTool.indexOf('import '));

describe('Railway deploy tooling (policy)', () => {
  it('pins the image before creating the deployment', () => {
    // The whole reason this tool exists instead of the Railway CLI: the service
    // must be re-pointed at the freshly built GHCR image (serviceInstanceUpdate)
    // BEFORE a deployment is created from it (serviceInstanceDeployV2). Reversing
    // them deploys the PREVIOUS image while reporting success.
    const updateAt = deployToolCode.indexOf('serviceInstanceUpdate(');
    const deployAt = deployToolCode.indexOf('serviceInstanceDeployV2(');
    expect(updateAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(-1);
    expect(updateAt).toBeLessThan(deployAt);
  });

  it('never falls back to a Railway CLI deploy path', () => {
    // `railway redeploy` re-runs the previous deployment object (old image) and
    // `railway up` uploads runner source for Railway to build (bypasses the
    // Trivy-scanned GHCR image). Neither may creep back in.
    expect(deployToolCode).not.toContain('railway redeploy');
    expect(deployToolCode).not.toContain('railway up');
  });

  it('is repo-owned — the deploy path depends on no external repository', () => {
    expect(deployTool).not.toContain('core-infra');
    expect(deployWorkflow).not.toContain('core-infra');
    expect(deployWorkflow).not.toContain('pnpm --dir');
    expect(deployWorkflow).toContain('pnpm tool:railway-deploy-image');
  });

  it('CD never uses --skip-wait, so a failed deploy cannot report green', () => {
    // The tool supports --skip-wait for manual diagnostics only: it returns exit 0
    // without polling for terminal status. If CD ever passed it, a CRASHED deploy
    // would pass the workflow.
    expect(deployTool).toContain('--skip-wait');
    expect(deployWorkflow).not.toContain('--skip-wait');
  });

  it('validates the GitHub Environment before deploying anything', () => {
    // A missing schema-required secret must fail the workflow, not crash-loop the
    // deployed container — so the pre-flight has to run BEFORE the deploy step.
    const validateAt = deployWorkflow.indexOf('pnpm validate:github-env-runtime');
    const deployAt = deployWorkflow.indexOf('pnpm tool:railway-deploy-image \\');
    expect(validateAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(deployAt);
  });

  it('the env pre-flight checks schema-required keys and exits with its verdict', () => {
    // Presence alone is not enough: an empty GitHub Environment secret reaches the
    // runner as '' and would satisfy a naive `in process.env` check while failing
    // the app's Zod validation at boot. (The verdict logic itself is covered by
    // src/tests/unit/tooling/validate-environment-runtime.unit.test.ts.)
    expect(envValidator).toContain('envSchemaRequiredKeys');
    expect(envValidator).toContain(".trim() === ''");
    // The CLI must propagate the validation result as the exit code — a deploy job
    // only fails when this process does.
    expect(envValidator).toContain('process.exit(runEnvironmentValidation(');
  });

  it('seeds reference data after migrate so a fresh environment can provision orgs', () => {
    // Migrations create the schema but never insert the `tenancy.permissions` reference
    // rows that owner-role provisioning FK-references. Without the seed, a fresh
    // environment provisions NO personal/team organization — every provision rolls back on the
    // missing permission FK and the read-path self-heal swallows it to
    // `personal_organization_id: null`. The reference seed must run, and AFTER migrate
    // (the schema must exist first).
    const migrateAt = deployWorkflow.indexOf('pnpm db:migrate');
    const seedAt = deployWorkflow.indexOf('pnpm db:seed');
    expect(migrateAt).toBeGreaterThan(-1);
    expect(seedAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeLessThan(seedAt);
  });

  it('declares no dead target_branch input (single-trunk keeps one branch control)', () => {
    // `target_branch` was declared in both trigger blocks and passed as `main` by every
    // caller but never consumed — on manual dispatch it rendered a redundant single-option
    // `[main]` dropdown beside GitHub's native branch selector, which is the one branch
    // control on a single-trunk repo.
    expect(deployWorkflow).not.toContain('target_branch');
  });
});
