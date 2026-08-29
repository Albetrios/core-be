import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();
const getEnvMock = vi.fn();
const computeWorkerPostgresPoolDemandMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock('@/infrastructure/database/connection.js', () => ({
  sql: (...arguments_: unknown[]) => sqlMock(...arguments_),
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: new Proxy(
    {},
    {
      get(_target, property) {
        return getEnvMock()[property as string];
      },
    },
  ),
  getEnv: () => getEnvMock(),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: loggerWarnMock, error: vi.fn() },
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-connection-budget.js', () => ({
  computeWorkerPostgresPoolDemand: (...arguments_: unknown[]) =>
    computeWorkerPostgresPoolDemandMock(...arguments_),
}));

/**
 * The message's opening line, asserted verbatim so a reword cannot land unnoticed. Passed as a
 * string rather than a regex: vitest substring-matches it, and the em dash and full stop would
 * otherwise need escaping.
 */
const BUDGET_EXCEEDED_HEADLINE =
  'Postgres connection budget exceeded — DATABASE_POOL_MAX is too high for this database.';

describe('assertPostgresConnectionBudget', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    getEnvMock.mockReset();
    computeWorkerPostgresPoolDemandMock.mockReset();
    loggerWarnMock.mockReset();
    vi.resetModules();
    getEnvMock.mockReturnValue({
      LOG_LEVEL: 'silent',
      POSTGRES_RESERVED_CONNECTIONS: 10,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });
  });

  it('throws when deployment process count exceeds allowed connections', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 50,
      DEPLOYMENT_TOTAL_REPLICA_COUNT: 5,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget()).rejects.toThrow(BUDGET_EXCEEDED_HEADLINE);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('passes when deployment process count fits the budget', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DEPLOYMENT_TOTAL_REPLICA_COUNT: 2,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget()).resolves.toBeUndefined();
  });

  it('requires deployment process count when DATABASE_CONNECTION_BUDGET_ENFORCED', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DATABASE_CONNECTION_BUDGET_ENFORCED: true,
      NODE_ENV: 'production',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget()).rejects.toThrow(
      /DEPLOYMENT_TOTAL_REPLICA_COUNT/i,
    );
  });

  it('throws when split worker families exceed DATABASE_POOL_MAX', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 8,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DEPLOYMENT_TOTAL_REPLICA_COUNT: 1,
      NODE_ENV: 'development',
    });
    computeWorkerPostgresPoolDemandMock.mockReturnValue({
      selectedFamilies: ['webhook'],
      monolithicWorker: false,
      peakPostgresConcurrency: 10,
      queues: [],
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget({ assertWorkerConcurrency: true })).rejects.toThrow(
      /Worker Postgres pool demand/i,
    );
  });

  it('throws when monolithic worker demand exceeds DATABASE_POOL_MAX', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 8,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DEPLOYMENT_TOTAL_REPLICA_COUNT: 1,
      NODE_ENV: 'development',
    });
    computeWorkerPostgresPoolDemandMock.mockReturnValue({
      selectedFamilies: ['mail', 'notify', 'webhook', 'stripe', 'retention', 'observability'],
      monolithicWorker: true,
      peakPostgresConcurrency: 24,
      queues: [],
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget({ assertWorkerConcurrency: true })).rejects.toThrow(
      /Worker Postgres pool demand/i,
    );
  });

  // EX-22: actual demand fits the pool, but the 1.25x burst-margin does not — warn, do not fail boot.
  it('warns (without throwing) when worker demand fits but lacks burst headroom', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 20,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DEPLOYMENT_TOTAL_REPLICA_COUNT: 1,
      NODE_ENV: 'development',
    });
    computeWorkerPostgresPoolDemandMock.mockReturnValue({
      selectedFamilies: ['mail', 'notify', 'webhook', 'stripe', 'retention', 'observability'],
      monolithicWorker: true,
      peakPostgresConcurrency: 18, // <= 20, so no hard failure
      peakPostgresConcurrencyWithSafetyMargin: 23, // ceil(18 * 1.25) > 20, so headroom warning
      queues: [],
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(
      assertPostgresConnectionBudget({ assertWorkerConcurrency: true }),
    ).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        poolMaxConnections: 20,
        peakPostgresConcurrency: 18,
        peakPostgresConcurrencyWithSafetyMargin: 23,
      }),
      'database.connection_budget.worker_demand_no_burst_headroom',
    );
  });

  it('passes when split API and worker counts fit the budget', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DEPLOYMENT_API_REPLICA_COUNT: 1,
      DEPLOYMENT_WORKER_REPLICA_COUNT: 1,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget()).resolves.toBeUndefined();
  });

  it('throws when split API and worker counts exceed the budget', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 50,
      DEPLOYMENT_API_REPLICA_COUNT: 4,
      DEPLOYMENT_WORKER_REPLICA_COUNT: 1,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget()).rejects.toThrow(BUDGET_EXCEEDED_HEADLINE);
  });

  it('names the largest fitting pool and the cluster size the current pool needs', async () => {
    const poolMax = 50;
    const maxConnections = 100;
    const reserved = 10;
    const apiReplicas = 1;
    const workerReplicas = 1;

    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: poolMax,
      POSTGRES_RESERVED_CONNECTIONS: reserved,
      POSTGRES_MAX_CONNECTIONS: maxConnections,
      DEPLOYMENT_API_REPLICA_COUNT: apiReplicas,
      DEPLOYMENT_WORKER_REPLICA_COUNT: workerReplicas,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    const processes = apiReplicas + workerReplicas;
    const available = maxConnections - reserved;
    const largestFittingPool = Math.floor(available / processes);
    const clusterNeededForCurrentPool = processes * poolMax + reserved;

    // 2 x 50 = 100 wanted against 100 - 10 = 90 available: 45 fits, or grow the cluster to 110.
    await expect(assertPostgresConnectionBudget()).rejects.toThrow(
      new RegExp(`DATABASE_POOL_MAX=${largestFittingPool}\\b`),
    );
    await expect(assertPostgresConnectionBudget()).rejects.toThrow(
      new RegExp(`POSTGRES_MAX_CONNECTIONS=${clusterNeededForCurrentPool}\\b`),
    );
    await expect(assertPostgresConnectionBudget()).rejects.toThrow(/PER PROCESS/);
  });

  it('omits the pool suggestion when no pool size fits the process count', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 15,
      DEPLOYMENT_TOTAL_REPLICA_COUNT: 10,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    // floor(5 available / 10 processes) is 0, which is not usable advice.
    await expect(assertPostgresConnectionBudget()).rejects.toThrow(/Raise the database/);

    const caught = await assertPostgresConnectionBudget().catch((error: unknown) => error);
    expect(String(caught)).not.toContain('DATABASE_POOL_MAX=0');
  });

  it('requires both split counts when using either one', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DEPLOYMENT_API_REPLICA_COUNT: 2,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget()).rejects.toThrow(/must both be set/i);
  });

  it('asserts local docker default of one API and one worker when counts are unset', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 15,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    await expect(assertPostgresConnectionBudget()).rejects.toThrow(BUDGET_EXCEEDED_HEADLINE);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('uses local process defaults when DATABASE_CONNECTION_BUDGET_ENFORCED is false', async () => {
    getEnvMock.mockReturnValue({
      DATABASE_POOL_MAX: 10,
      POSTGRES_RESERVED_CONNECTIONS: 10,
      POSTGRES_MAX_CONNECTIONS: 100,
      DATABASE_CONNECTION_BUDGET_ENFORCED: false,
      NODE_ENV: 'development',
      WORKER_CONCURRENCY: 4,
    });

    const { assertPostgresConnectionBudget } = await import(
      '@/infrastructure/database/safety/assert-connection-budget.js'
    );

    // 1 API + 1 worker × pool 10 = 20 required ≤ (100 − 10) allowed → passes on local defaults.
    await expect(assertPostgresConnectionBudget()).resolves.toBeUndefined();
  });
});
