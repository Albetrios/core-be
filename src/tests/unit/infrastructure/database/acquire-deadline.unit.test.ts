import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  getActiveOrganizationRlsCheckoutCount,
  resetOrganizationRlsCheckoutCountForTests,
} from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import { DATABASE_ACQUIRE_RETRY_AFTER_SECONDS } from '@/infrastructure/database/pool/pool.constants.js';

/**
 * The connection-acquire deadline shared by every pooled unit of work (`runPooledUnitOfWork`),
 * driven through the maintenance context, which always counts toward the in-flight gauge.
 *
 * `transaction` stands in for postgres.js: with a cold pool and an unreachable database it never
 * calls back, and when the database returns it calls back late — the two cases the deadline exists
 * for.
 */
const acquireDeadline = vi.hoisted(() => ({ milliseconds: 1_000 }));
const transactionMock = vi.fn();
const databaseHandle = { execute: vi.fn().mockResolvedValue(undefined) };

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: {
    transaction: (...arguments_: unknown[]) => transactionMock(...arguments_),
  },
}));

vi.mock('@/shared/config/env.config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/shared/config/env.config.js')>();
  return {
    ...original,
    getEnv: () => ({
      ...original.getEnv(),
      DATABASE_POOL_ACQUIRE_TIMEOUT_MS: acquireDeadline.milliseconds,
    }),
  };
});

type TransactionCallback = (transaction: unknown) => Promise<unknown>;

/** A pool that has no connection yet: the transaction starts only when `connect()` is called. */
function coldPool() {
  let connect: () => Promise<unknown> = async () => {
    throw new Error('connect() called before the transaction was requested');
  };
  transactionMock.mockImplementation(
    (callback: TransactionCallback) =>
      new Promise((resolve, reject) => {
        connect = () => {
          const transaction = callback(databaseHandle);
          transaction.then(resolve, reject);
          return transaction;
        };
      }),
  );
  return { connect: () => connect() };
}

describe('pooled unit of work: connection-acquire deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acquireDeadline.milliseconds = 1_000;
    transactionMock.mockReset();
    resetOrganizationRlsCheckoutCountForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 503 with Retry-After when no connection arrives before the deadline', async () => {
    coldPool();
    const unitOfWork = withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      vi.fn(),
    );
    const outcome = expect(unitOfWork).rejects.toMatchObject({
      statusCode: 503,
      retryAfterSeconds: DATABASE_ACQUIRE_RETRY_AFTER_SECONDS,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await outcome;
  });

  it('rolls back without running the unit of work when the connection arrives after the deadline', async () => {
    const pool = coldPool();
    const work = vi.fn().mockResolvedValue('written');
    const unitOfWork = withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      work,
    );
    const outcome = expect(unitOfWork).rejects.toMatchObject({ statusCode: 503 });
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;

    // The database comes back: the queued transaction finally starts.
    await expect(pool.connect()).rejects.toThrow(/abandoned/);
    expect(work).not.toHaveBeenCalled();
  });

  it('keeps an abandoned wait in the in-flight gauge until the pool lets it go', async () => {
    const pool = coldPool();
    const unitOfWork = withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      vi.fn(),
    );
    const outcome = expect(unitOfWork).rejects.toMatchObject({ statusCode: 503 });
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    // Still queued in the pool: the overload guard must keep seeing it.
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);

    await pool.connect().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });

  it('releases the in-flight gauge when opening the transaction throws synchronously', async () => {
    transactionMock.mockImplementation(() => {
      throw new Error('pool exploded');
    });

    await expect(
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, vi.fn()),
    ).rejects.toThrow('pool exploded');
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });

  it('applies no deadline once the transaction has started', async () => {
    const pool = coldPool();
    const work = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve('slow but fine'), 5_000)),
    );
    const unitOfWork = withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      work,
    );

    await vi.advanceTimersByTimeAsync(500);
    void pool.connect();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(unitOfWork).resolves.toBe('slow but fine');
  });

  it('never times out when DATABASE_POOL_ACQUIRE_TIMEOUT_MS is 0', async () => {
    acquireDeadline.milliseconds = 0;
    const pool = coldPool();
    const unitOfWork = withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      vi.fn().mockResolvedValue('eventually'),
    );
    let settled = false;
    void unitOfWork.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    void pool.connect();
    await expect(unitOfWork).resolves.toBe('eventually');
  });
});
