import { describe, it, expect, vi } from 'vitest';
import { withMaintenanceDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureException: vi.fn(),
}));

import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import { runOrganizationOffboardingReconcileJob } from '@/domains/tenancy/sub-domains/organization/workers/organization-offboarding-reconcile.processor.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const inner = vi.fn() as unknown as (...parameters: unknown[]) => unknown;
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn((_scope: unknown, ...parameters: unknown[]) =>
      inner(...parameters),
    ),
  };
});

describe('runOrganizationOffboardingReconcileJob (TEN-06)', () => {
  it('re-drives every stuck offboarding and counts the results', async () => {
    vi.mocked(withMaintenanceDatabaseContext).mockResolvedValue([
      { public_id: 'org_a' },
      { public_id: 'org_b' },
    ] as never);
    const service = { resumeOffboarding: vi.fn().mockResolvedValue(undefined) };

    const result = await runOrganizationOffboardingReconcileJob(service);

    expect(service.resumeOffboarding).toHaveBeenCalledTimes(2);
    expect(service.resumeOffboarding).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: 'org_a' }),
    );
    expect(result).toEqual({ scanned: 2, resumed: 2, failed: 0 });
  });

  it('counts a per-row failure without aborting the rest of the batch', async () => {
    vi.mocked(withMaintenanceDatabaseContext).mockResolvedValue([
      { public_id: 'org_a' },
      { public_id: 'org_b' },
    ] as never);
    const service = {
      resumeOffboarding: vi
        .fn()
        .mockRejectedValueOnce(new Error('stripe down'))
        .mockResolvedValueOnce(undefined),
    };

    const result = await runOrganizationOffboardingReconcileJob(service);

    expect(result).toEqual({ scanned: 2, resumed: 1, failed: 1 });
    // The failed organization offboarding is reported to Sentry with its public id and the reconcile source
    // tag (mirrors the user-offboarding reconcile twin), so a stuck teardown is not lost silently.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      organizationId: 'org_a',
      tags: { source: 'organization-offboarding-reconcile' },
    });
  });

  it('no-ops when nothing is stuck', async () => {
    vi.mocked(withMaintenanceDatabaseContext).mockResolvedValue([] as never);
    const service = { resumeOffboarding: vi.fn() };

    const result = await runOrganizationOffboardingReconcileJob(service);

    expect(service.resumeOffboarding).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, resumed: 0, failed: 0 });
  });
});
