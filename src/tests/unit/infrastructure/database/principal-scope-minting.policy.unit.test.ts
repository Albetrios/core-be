import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Policy: principal scopes are minted ONLY through the `PRINCIPAL_SCOPE` family
 * namespace, and each member is confined to its trust boundary. A service or
 * repository minting from raw strings would collapse the brand's guarantee, so:
 *
 * - `createPrincipalDatabaseScope` (the private factory) never leaves
 *   `database-context.ts`.
 * - `PRINCIPAL_SCOPE.REQUEST` is called only where the verified request ids
 *   live: the auth middleware attachment (and its test mirror helper).
 * - `PRINCIPAL_SCOPE.JOB` is called only from worker paths — an HTTP handler
 *   reaching for a job scope would bypass the request attachment.
 * - `PRINCIPAL_SCOPE.VERIFIED` callers are ledgered in
 *   `verified-scope-usage.policy.unit.test.ts`.
 *
 * Extend an allowlist deliberately (new legitimate "top"), never casually.
 */
function grepFiles(pattern: string): string[] {
  let output = '';
  try {
    output = execFileSync('grep', ['-rl', pattern, 'src', '--include=*.ts'], {
      encoding: 'utf8',
    });
  } catch {
    // grep exits non-zero when nothing matches — that is also a pass.
  }
  return output
    .split('\n')
    .filter(Boolean)
    .filter((filePath) => !/\.test\.ts$/.test(filePath));
}

describe('principal-scope minting confinement', () => {
  it('createPrincipalDatabaseScope never leaves database-context.ts', () => {
    const offenders = grepFiles('createPrincipalDatabaseScope').filter(
      (filePath) => !filePath.endsWith('src/infrastructure/database/contexts/database-context.ts'),
    );
    expect(
      offenders,
      `createPrincipalDatabaseScope referenced outside the context module: ${offenders.join(', ')}. ` +
        'The factory is file-private — mint through a PRINCIPAL_SCOPE member instead.',
    ).toEqual([]);
  });

  it('PRINCIPAL_SCOPE.REQUEST is called only by the auth middleware attachment (and its test helper)', () => {
    const allowed = [
      'src/shared/middlewares/core/auth.middleware.ts',
      'src/infrastructure/database/contexts/database-context.ts',
      // Test mirror of the middleware attachment (doc reference only).
      'src/tests/helpers/principal-scope-getters.helper.ts',
    ];
    const offenders = grepFiles('PRINCIPAL_SCOPE.REQUEST').filter(
      (filePath) => !allowed.some((suffix) => filePath.endsWith(suffix)),
    );
    expect(
      offenders,
      `PRINCIPAL_SCOPE.REQUEST referenced outside the auth middleware: ${offenders.join(', ')}. ` +
        'Request scopes are attached once per request by attachRequestPrincipalScope — read request.principalScope (or the requireOrganizationScope / requireUserScope accessors) instead.',
    ).toEqual([]);
  });

  it('PRINCIPAL_SCOPE.JOB is referenced only from worker paths', () => {
    const allowedFragments = [
      'queue/worker-runtime/',
      '/workers/',
      'infrastructure/database/contexts/database-context.ts',
      'stripe-webhook/stripe-webhook-organization.util.ts', // worker-side organization resolution for Stripe events
    ];
    const offenders = grepFiles('PRINCIPAL_SCOPE.JOB').filter(
      (filePath) => !allowedFragments.some((fragment) => filePath.includes(fragment)),
    );
    expect(
      offenders,
      `PRINCIPAL_SCOPE.JOB referenced outside worker paths: ${offenders.join(', ')}. ` +
        'Job scopes carry enqueue-time provenance — HTTP code must use request.principalScope; self-verified flows use PRINCIPAL_SCOPE.VERIFIED (ledgered).',
    ).toEqual([]);
  });
});
