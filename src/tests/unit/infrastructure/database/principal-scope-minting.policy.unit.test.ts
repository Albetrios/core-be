import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Policy: `createPrincipalDatabaseScope` is the minting primitive for the branded
 * {@link PrincipalDatabaseScope} — provenance is edge-only, so only the confined
 * minters may import it. A service or repository importing the factory would be
 * able to fabricate identity scope from raw strings, collapsing the brand's
 * guarantee. Extend the allowlist deliberately (new legitimate "top" = new minter),
 * never casually.
 */
const ALLOWED_IMPORTER_SUFFIXES = [
  'src/infrastructure/database/contexts/database-context.ts',
  'src/shared/utils/http/request.util.ts',
  'src/infrastructure/queue/worker-runtime/job-principal-scope.util.ts',
  'src/shared/utils/identity/verified-principal-scope.util.ts',
];

describe('principal-scope minting confinement', () => {
  it('createPrincipalDatabaseScope is imported only by the allowlisted minters (and tests)', () => {
    let output = '';
    try {
      output = execFileSync(
        'grep',
        ['-rl', 'createPrincipalDatabaseScope', 'src', '--include=*.ts'],
        { encoding: 'utf8' },
      );
    } catch {
      // grep exits non-zero when nothing matches — that would also be a pass.
    }

    const offenders = output
      .split('\n')
      .filter(Boolean)
      .filter((filePath) => !/\.test\.ts$/.test(filePath))
      .filter(
        (filePath) => !ALLOWED_IMPORTER_SUFFIXES.some((allowed) => filePath.endsWith(allowed)),
      );

    expect(
      offenders,
      `createPrincipalDatabaseScope referenced outside the confined minters: ${offenders.join(', ')}. ` +
        'Scopes must be minted at a legitimate top (request minters, worker-payload minter, provisioning) — add a new minter and extend the allowlist deliberately.',
    ).toEqual([]);
  });
});

/**
 * Job-source minters may only be used from worker paths — an HTTP handler
 * reaching for a job scope would bypass the token minter's claim precedence.
 */
const JOB_MINTER_ALLOWED_FRAGMENTS = [
  'queue/worker-runtime/',
  '/workers/',
  'stripe-webhook/stripe-webhook-organization.util.ts', // worker-side org resolution for Stripe events
];

describe('job-scope minting confinement', () => {
  it('resolve*JobScope is referenced only from worker paths (and tests)', () => {
    let output = '';
    try {
      output = execFileSync(
        'grep',
        [
          '-rlE',
          'resolve(Organization|User)?JobP?r?i?n?c?i?p?a?l?S?c?o?p?e?\\b|resolveJobPrincipalScope|resolveJobPrincipalScope|resolveJobPrincipalScope',
          'src',
          '--include=*.ts',
        ],
        { encoding: 'utf8' },
      );
    } catch {
      // no matches
    }
    const offenders = output
      .split('\n')
      .filter(Boolean)
      .filter((filePath) => !/\.test\.ts$/.test(filePath))
      .filter((filePath) => !JOB_MINTER_ALLOWED_FRAGMENTS.some((f) => filePath.includes(f)));
    expect(
      offenders,
      `job-scope minters referenced outside worker paths: ${offenders.join(', ')}.`,
    ).toEqual([]);
  });
});
