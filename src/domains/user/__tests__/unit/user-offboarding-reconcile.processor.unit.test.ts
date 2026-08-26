import { describe, it, expect, vi } from 'vitest';
import { withMaintenanceDatabaseContext } from '@/infrastructure/database/contexts/maintenance-database.context.js';

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureException: vi.fn(),
}));

import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import { runUserOffboardingReconcileJob } from '@/domains/user/workers/user-offboarding-reconcile.processor.js';

vi.mock(
  '@/infrastructure/database/contexts/maintenance-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const inner = vi.fn() as unknown as (...parameters: unknown[]) => unknown;
    return {
      ...actual,
      withMaintenanceDatabaseContext: vi.fn((_scope: unknown, ...parameters: unknown[]) =>
        inner(...parameters),
      ),
    };
  },
);

describe('runUserOffboardingReconcileJob (USER-04/USER-09)', () => {
  it('re-drives every stuck offboarding and counts the results', async () => {
    vi.mocked(withMaintenanceDatabaseContext).mockResolvedValue([
      { public_id: 'user_a' },
      { public_id: 'user_b' },
    ] as never);
    const service = { resumeOffboarding: vi.fn().mockResolvedValue(undefined) };

    const result = await runUserOffboardingReconcileJob(service);

    expect(service.resumeOffboarding).toHaveBeenCalledTimes(2);
    expect(service.resumeOffboarding).toHaveBeenCalledWith('user_a');
    expect(service.resumeOffboarding).toHaveBeenCalledWith('user_b');
    expect(result).toEqual({ scanned: 2, resumed: 2, failed: 0 });
  });

  it('counts a per-row failure without aborting the rest of the batch', async () => {
    vi.mocked(withMaintenanceDatabaseContext).mockResolvedValue([
      { public_id: 'user_a' },
      { public_id: 'user_b' },
    ] as never);
    const service = {
      resumeOffboarding: vi
        .fn()
        .mockRejectedValueOnce(new Error('stripe down'))
        .mockResolvedValueOnce(undefined),
    };

    const result = await runUserOffboardingReconcileJob(service);

    expect(service.resumeOffboarding).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ scanned: 2, resumed: 1, failed: 1 });
    // The per-row failure is not merely counted — it is reported to Sentry with the row's public id
    // and the reconcile source tag, so a silently stuck offboarding surfaces operationally.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      userId: 'user_a',
      tags: { source: 'user-offboarding-reconcile' },
    });
  });

  it('no-ops when nothing is stuck', async () => {
    vi.mocked(withMaintenanceDatabaseContext).mockResolvedValue([] as never);
    const service = { resumeOffboarding: vi.fn() };

    const result = await runUserOffboardingReconcileJob(service);

    expect(service.resumeOffboarding).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, resumed: 0, failed: 0 });
  });
});
