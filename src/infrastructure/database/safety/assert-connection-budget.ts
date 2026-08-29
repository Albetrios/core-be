import { sql } from '@/infrastructure/database/connection.js';
import { computeWorkerPostgresPoolDemand } from '@/infrastructure/queue/worker-runtime/worker-connection-budget.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/** Local docker-compose default: one API + one worker process. */
const LOCAL_DEFAULT_API_PROCESS_COUNT = 1;
const LOCAL_DEFAULT_WORKER_PROCESS_COUNT = 1;

/** Options for {@link assertPostgresConnectionBudget}. */
export type AssertConnectionBudgetOptions = {
  /** When true, validates per-queue Postgres demand for the selected WORKER_QUEUE_FAMILIES. */
  readonly assertWorkerConcurrency?: boolean;
};

type ResolvedDeploymentCounts =
  | {
      readonly kind: 'split';
      readonly apiProcessCount: number;
      readonly workerProcessCount: number;
      readonly usedInferredLocalDefaults: boolean;
    }
  | {
      readonly kind: 'total';
      readonly totalProcessCount: number;
    };

function resolvePoolMaxConnections(): number {
  return env.DATABASE_POOL_MAX;
}

/**
 * Returns the cluster `max_connections` setting — honours `POSTGRES_MAX_CONNECTIONS` when set,
 * otherwise queries `pg_settings` for the live value. Used to size the deployment connection budget.
 */
export async function resolvePostgresMaxConnections(): Promise<number> {
  if (env.POSTGRES_MAX_CONNECTIONS !== undefined) {
    return env.POSTGRES_MAX_CONNECTIONS;
  }

  const rows = await sql<{ setting: string }[]>`
    SELECT setting
    FROM pg_settings
    WHERE name = 'max_connections'
  `;
  const setting = rows[0]?.setting;
  if (!setting) {
    throw new Error('database.connection_budget.max_connections_query_empty');
  }

  const parsed = Number.parseInt(setting, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`database.connection_budget.invalid_max_connections:${setting}`);
  }
  return parsed;
}

function resolveDeploymentCounts(): ResolvedDeploymentCounts | undefined {
  const apiExplicit = env.DEPLOYMENT_API_REPLICA_COUNT;
  const workerExplicit = env.DEPLOYMENT_WORKER_REPLICA_COUNT;
  const hasPartialSplit =
    (apiExplicit !== undefined && workerExplicit === undefined) ||
    (apiExplicit === undefined && workerExplicit !== undefined);

  if (hasPartialSplit) {
    throw new Error(
      'DEPLOYMENT_API_REPLICA_COUNT and DEPLOYMENT_WORKER_REPLICA_COUNT must both be set when using either',
    );
  }

  if (apiExplicit !== undefined && workerExplicit !== undefined) {
    return {
      kind: 'split',
      apiProcessCount: apiExplicit,
      workerProcessCount: workerExplicit,
      usedInferredLocalDefaults: false,
    };
  }

  const total = env.DEPLOYMENT_TOTAL_REPLICA_COUNT;
  if (total !== undefined) {
    return { kind: 'total', totalProcessCount: total };
  }

  if (env.DATABASE_CONNECTION_BUDGET_ENFORCED) {
    return undefined;
  }

  return {
    kind: 'split',
    apiProcessCount: LOCAL_DEFAULT_API_PROCESS_COUNT,
    workerProcessCount: LOCAL_DEFAULT_WORKER_PROCESS_COUNT,
    usedInferredLocalDefaults: true,
  };
}

function resolveProcessCount(counts: ResolvedDeploymentCounts): number {
  if (counts.kind === 'total') {
    return counts.totalProcessCount;
  }

  return counts.apiProcessCount + counts.workerProcessCount;
}

function computeRequiredPoolConnections(
  counts: ResolvedDeploymentCounts,
  poolMaxConnections: number,
): number {
  return resolveProcessCount(counts) * poolMaxConnections;
}

/** Column width that keeps the rule and the worked example vertically aligned. */
const BUDGET_MESSAGE_COLUMN = 30;

/**
 * Boot-fatal, so it is written to be actioned straight from the deploy log: the rule that was
 * broken, the same rule with real numbers, then the exact variable and value that fixes it.
 * States that DATABASE_POOL_MAX is per process, which is the misreading that causes this.
 */
function buildDeploymentBudgetErrorMessage(parameters: {
  poolMaxConnections: number;
  postgresMaxConnections: number;
  reservedConnections: number;
  allowedApplicationConnections: number;
  requiredConnections: number;
  processCount: number;
  deploymentSummary: string;
}): string {
  const fittingPoolMax = Math.floor(
    parameters.allowedApplicationConnections / parameters.processCount,
  );
  const neededMaxConnections = parameters.requiredConnections + parameters.reservedConnections;

  const wanted = `${parameters.processCount} × ${parameters.poolMaxConnections} = ${parameters.requiredConnections}`;
  const available = `${parameters.postgresMaxConnections} − ${parameters.reservedConnections} = ${parameters.allowedApplicationConnections}`;

  const poolLabel = `DATABASE_POOL_MAX=${fittingPoolMax}`.padEnd(BUDGET_MESSAGE_COLUMN);
  const clusterLabel = `POSTGRES_MAX_CONNECTIONS=${neededMaxConnections}`.padEnd(
    BUDGET_MESSAGE_COLUMN,
  );
  const noFitLabel = 'Raise the database'.padEnd(BUDGET_MESSAGE_COLUMN);

  // A pool of 0 is not usable advice; when nothing fits, raising the server is the only fix.
  const fixLine =
    fittingPoolMax >= 1
      ? `  Fix   ${poolLabel}fits now, no database change needed\n`
      : `  Fix   ${noFitLabel}no pool size fits ${parameters.processCount} processes\n`;

  return (
    'Server cannot start: DATABASE_POOL_MAX is too high for this database.\n' +
    '\n' +
    `  ${'The rule'.padEnd(14)}${'processes × DATABASE_POOL_MAX'.padEnd(BUDGET_MESSAGE_COLUMN)}` +
    `${'must be ≤'.padEnd(14)}max_connections − reserved\n` +
    `  ${'Your numbers'.padEnd(14)}${wanted.padEnd(BUDGET_MESSAGE_COLUMN)}` +
    `${'is more than'.padEnd(14)}${available}\n` +
    '\n' +
    `  DATABASE_POOL_MAX ${parameters.poolMaxConnections} is PER PROCESS, not a total. ` +
    `You run ${parameters.deploymentSummary},\n` +
    `  so the app asks for ${parameters.requiredConnections} connections but only ` +
    `${parameters.allowedApplicationConnections} are free.\n` +
    '\n' +
    fixLine +
    `  Or    ${clusterLabel}ONLY after raising max_connections to ${neededMaxConnections}\n` +
    `        ${''.padEnd(BUDGET_MESSAGE_COLUMN)}on the Postgres server itself. This variable\n` +
    `        ${''.padEnd(BUDGET_MESSAGE_COLUMN)}does not change the server, it only tells\n` +
    `        ${''.padEnd(BUDGET_MESSAGE_COLUMN)}the app what the server already allows.\n` +
    '\n' +
    '  Docs  docs/deployment/runbooks/resource-limits.md'
  );
}

function formatDeploymentSummary(counts: ResolvedDeploymentCounts): string {
  const processCount = resolveProcessCount(counts);

  if (counts.kind === 'total') {
    return `${processCount} processes`;
  }

  return `${processCount} processes (${counts.apiProcessCount} API + ${counts.workerProcessCount} worker)`;
}

/** Application connection headroom: max_connections minus reserved admin/migration slots. */
export async function resolvePostgresAllowedApplicationConnections(): Promise<number> {
  const postgresMaxConnections = await resolvePostgresMaxConnections();
  return postgresMaxConnections - env.POSTGRES_RESERVED_CONNECTIONS;
}

/**
 * Validates postgres.js pool sizing against Postgres max_connections and deployment process count.
 * Call once at API and worker process startup.
 */
export async function assertPostgresConnectionBudget(
  options: AssertConnectionBudgetOptions = {},
): Promise<void> {
  const poolMaxConnections = resolvePoolMaxConnections();
  const reservedConnections = env.POSTGRES_RESERVED_CONNECTIONS;
  const postgresMaxConnections = await resolvePostgresMaxConnections();
  const allowedApplicationConnections = postgresMaxConnections - reservedConnections;

  if (allowedApplicationConnections < 1) {
    throw new Error(
      `Postgres reserved connection headroom (${reservedConnections}) exceeds or equals max_connections (${postgresMaxConnections})`,
    );
  }

  const deploymentCounts = resolveDeploymentCounts();

  if (deploymentCounts !== undefined) {
    const requiredConnections = computeRequiredPoolConnections(
      deploymentCounts,
      poolMaxConnections,
    );
    if (requiredConnections > allowedApplicationConnections) {
      throw new Error(
        buildDeploymentBudgetErrorMessage({
          poolMaxConnections,
          postgresMaxConnections,
          reservedConnections,
          allowedApplicationConnections,
          requiredConnections,
          processCount: resolveProcessCount(deploymentCounts),
          deploymentSummary: formatDeploymentSummary(deploymentCounts),
        }),
      );
    }

    const logPayload =
      deploymentCounts.kind === 'split'
        ? {
            apiProcessCount: deploymentCounts.apiProcessCount,
            workerProcessCount: deploymentCounts.workerProcessCount,
            usedInferredLocalDefaults: deploymentCounts.usedInferredLocalDefaults,
          }
        : { deploymentProcessCount: deploymentCounts.totalProcessCount };

    logger.info(
      {
        ...logPayload,
        poolMaxConnections,
        postgresMaxConnections,
        reservedConnections,
        requiredConnections,
        allowedApplicationConnections,
      },
      'database.connection_budget.ok',
    );
  } else if (env.DATABASE_CONNECTION_BUDGET_ENFORCED) {
    throw new Error(
      'DEPLOYMENT_TOTAL_REPLICA_COUNT (or DEPLOYMENT_API_REPLICA_COUNT + DEPLOYMENT_WORKER_REPLICA_COUNT) ' +
        'is required when DATABASE_CONNECTION_BUDGET_ENFORCED is set (default on production) ' +
        'to validate the Postgres connection budget. ' +
        'Set the secret in the GitHub Environment so reusable-railway-deploy.yml forwards it to the service. ' +
        'See docs/deployment/runbooks/resource-limits.md',
    );
  }

  if (options.assertWorkerConcurrency) {
    const poolDemand = computeWorkerPostgresPoolDemand();
    const {
      peakPostgresConcurrency,
      peakPostgresConcurrencyWithSafetyMargin,
      monolithicWorker,
      selectedFamilies,
      queues,
    } = poolDemand;

    logger.info(
      {
        poolMaxConnections,
        peakPostgresConcurrency,
        peakPostgresConcurrencyWithSafetyMargin,
        selectedFamilies,
        monolithicWorker,
        enabledQueues: queues
          .filter((entry) => entry.enabled && entry.postgresConcurrency > 0)
          .map((entry) => ({
            queueName: entry.queueName,
            family: entry.family,
            postgresConcurrency: entry.postgresConcurrency,
          })),
      },
      'database.connection_budget.worker_demand',
    );

    if (peakPostgresConcurrency > poolMaxConnections) {
      throw new Error(
        `Worker Postgres pool demand (${peakPostgresConcurrency}) exceeds DATABASE_POOL_MAX (${poolMaxConnections}) ` +
          `for WORKER_QUEUE_FAMILIES [${selectedFamilies.join(', ')}]${monolithicWorker ? ' (monolithic worker)' : ''}. ` +
          'Raise DATABASE_POOL_MAX on the worker service, lower WORKER_CONCURRENCY_* overrides, ' +
          'or split worker services by queue family. See docs/deployment/runbooks/resource-limits.md',
      );
    }

    // EX-22: the hard cap above is on *actual* demand, but a worker sized with zero burst headroom
    // can still exhaust the pool when several queues spike at once. Warn (never fail boot) when the
    // raw demand fits but the safety-margin-adjusted demand does not, so operators raise
    // DATABASE_POOL_MAX before a burst forces jobs to the DLQ.
    if (peakPostgresConcurrencyWithSafetyMargin > poolMaxConnections) {
      logger.warn(
        {
          poolMaxConnections,
          peakPostgresConcurrency,
          peakPostgresConcurrencyWithSafetyMargin,
          selectedFamilies,
          monolithicWorker,
        },
        'database.connection_budget.worker_demand_no_burst_headroom',
      );
    }
  }
}
