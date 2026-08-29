import { getActiveOrganizationRlsCheckoutCount } from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import { isWorkerRuntime } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { getWorkerPostgresPoolDemandContext } from '@/infrastructure/queue/worker-runtime/worker-pool-demand-context.js';
import { env } from '@/shared/config/env.config.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Pool-pressure severity returned by {@link evaluatePoolExhaustionAndAlert}.
 *
 * @remarks
 * - **Algorithm:** `critical` and `warn` thresholds come from
 *   `DATABASE_POOL_{ACTIVE,CLUSTER}_{WARN,CRITICAL}_RATIO`; the overall level is
 *   the max of the active-checkout signal and the cluster `pg_stat_activity` signal.
 * - **Failure modes:** none — it's a pure label.
 * - **Side effects:** none.
 * - **Notes:** Sentry alerts fire only after `DATABASE_POOL_ALERT_CONSECUTIVE_POLLS`
 *   consecutive samples at the same level to avoid one-off spikes.
 */
export type PoolPressureLevel = 'ok' | 'warn' | 'critical';

/**
 * One-shot snapshot returned by {@link evaluatePoolExhaustionAndAlert} — overall
 * level plus the raw signals (in-process organization-RLS checkouts and cluster active
 * connection counts) the decision was based on.
 *
 * @remarks
 * - **Algorithm:** populated after the active + cluster evaluations and after
 *   any consecutive-poll alerts have been emitted.
 * - **Failure modes:** sample is still returned even when one signal is
 *   unavailable (`allowedApplicationConnections === 0` short-circuits cluster
 *   evaluation to `ok`).
 * - **Side effects:** none from the type itself.
 * - **Notes:** consumed by the metrics polling loop for gauge updates.
 */
export type PoolPressureSample = {
  readonly level: PoolPressureLevel;
  readonly activeOrganizationRlsCheckouts: number;
  readonly poolMaxConnections: number;
  readonly clusterActiveConnections: number;
  readonly allowedApplicationConnections: number;
};

let consecutiveActiveWarnPolls = 0;
let consecutiveActiveCriticalPolls = 0;
let consecutiveClusterWarnPolls = 0;
let consecutiveClusterCriticalPolls = 0;

function resolvePoolMaxConnections(): number {
  return env.DATABASE_POOL_MAX;
}

/**
 * Test-only helper that clears the module-level consecutive-poll counters so a
 * fresh Vitest case can assert alert behaviour from a clean baseline.
 *
 * @remarks
 * - **Algorithm:** zeroes the four `consecutive*Polls` variables.
 * - **Failure modes:** none — pure assignment.
 * - **Side effects:** mutates module state; only call from test setup/teardown.
 * - **Notes:** invoked by `resetPostgresPoolMonitoringForTests` in
 *   {@link "@/infrastructure/observability/metrics/db-pool-metrics"}.
 */
export function resetPoolExhaustionAlertStateForTests(): void {
  consecutiveActiveWarnPolls = 0;
  consecutiveActiveCriticalPolls = 0;
  consecutiveClusterWarnPolls = 0;
  consecutiveClusterCriticalPolls = 0;
}

function evaluateActiveCheckoutPressure(
  activeCheckouts: number,
  poolMaxConnections: number,
): PoolPressureLevel {
  const criticalThreshold = Math.ceil(poolMaxConnections * env.DATABASE_POOL_ACTIVE_CRITICAL_RATIO);
  const warnThreshold = Math.ceil(poolMaxConnections * env.DATABASE_POOL_ACTIVE_WARN_RATIO);

  if (activeCheckouts >= criticalThreshold) {
    return 'critical';
  }
  if (activeCheckouts >= warnThreshold) {
    return 'warn';
  }
  return 'ok';
}

function evaluateClusterPressure(
  clusterActiveConnections: number,
  allowedApplicationConnections: number,
): PoolPressureLevel {
  if (allowedApplicationConnections < 1) {
    return 'ok';
  }

  const criticalThreshold = Math.ceil(
    allowedApplicationConnections * env.DATABASE_POOL_CLUSTER_CRITICAL_RATIO,
  );
  const warnThreshold = Math.ceil(
    allowedApplicationConnections * env.DATABASE_POOL_CLUSTER_WARN_RATIO,
  );

  if (clusterActiveConnections >= criticalThreshold) {
    return 'critical';
  }
  if (clusterActiveConnections >= warnThreshold) {
    return 'warn';
  }
  return 'ok';
}

function bumpConsecutivePolls(current: number, isOverThreshold: boolean): number {
  if (!isOverThreshold) {
    return 0;
  }
  return current + 1;
}

function shouldEmitAlert(consecutivePolls: number): boolean {
  return consecutivePolls >= env.DATABASE_POOL_ALERT_CONSECUTIVE_POLLS;
}

function buildWorkerPoolDemandAlertExtra(
  demand: ReturnType<typeof getWorkerPostgresPoolDemandContext>,
  poolMaxConnections: number,
): Record<string, number | string> {
  if (demand === undefined) {
    return {};
  }

  return {
    workerQueueFamilies: demand.selectedFamilies.join(','),
    workerPeakPostgresConcurrency: demand.peakPostgresConcurrency,
    workerPeakPostgresConcurrencyHoldingExternalIo: demand.peakPostgresConcurrencyHoldingExternalIo,
    workerConfiguredPoolMax: poolMaxConnections,
    workerMonolithic: demand.monolithicWorker ? 'true' : 'false',
  };
}

function emitPoolExhaustionAlert(parameters: {
  level: 'warning' | 'error';
  message: string;
  extra: Record<string, number | string>;
}): void {
  if (parameters.level === 'error') {
    logger.error(parameters.extra, parameters.message);
  } else {
    logger.warn(parameters.extra, parameters.message);
  }
  captureMessage(parameters.message, {
    level: parameters.level,
    extra: parameters.extra,
  });
}

function emitActiveCheckoutAlertIfNeeded(parameters: {
  activeOrganizationRlsCheckouts: number;
  poolMaxConnections: number;
  workerPoolDemandExtra: Record<string, number | string>;
}): void {
  if (shouldEmitAlert(consecutiveActiveCriticalPolls)) {
    emitPoolExhaustionAlert({
      level: 'error',
      message: 'database.pool.exhaustion.critical',
      extra: {
        signal: 'active_organization_rls_checkouts',
        activeOrganizationRlsCheckouts: parameters.activeOrganizationRlsCheckouts,
        poolMaxConnections: parameters.poolMaxConnections,
        criticalRatio: env.DATABASE_POOL_ACTIVE_CRITICAL_RATIO,
        ...parameters.workerPoolDemandExtra,
      },
    });
    consecutiveActiveCriticalPolls = 0;
  } else if (shouldEmitAlert(consecutiveActiveWarnPolls)) {
    emitPoolExhaustionAlert({
      level: 'warning',
      message: 'database.pool.exhaustion.high',
      extra: {
        signal: 'active_organization_rls_checkouts',
        activeOrganizationRlsCheckouts: parameters.activeOrganizationRlsCheckouts,
        poolMaxConnections: parameters.poolMaxConnections,
        warnRatio: env.DATABASE_POOL_ACTIVE_WARN_RATIO,
        ...parameters.workerPoolDemandExtra,
      },
    });
    consecutiveActiveWarnPolls = 0;
  }
}

function emitClusterAlertIfNeeded(parameters: {
  clusterActiveConnections: number;
  allowedApplicationConnections: number;
  workerPoolDemandExtra: Record<string, number | string>;
}): void {
  if (shouldEmitAlert(consecutiveClusterCriticalPolls)) {
    emitPoolExhaustionAlert({
      level: 'error',
      message: 'database.pool.exhaustion.critical',
      extra: {
        signal: 'cluster_pg_stat_activity',
        clusterActiveConnections: parameters.clusterActiveConnections,
        allowedApplicationConnections: parameters.allowedApplicationConnections,
        criticalRatio: env.DATABASE_POOL_CLUSTER_CRITICAL_RATIO,
        ...parameters.workerPoolDemandExtra,
      },
    });
    consecutiveClusterCriticalPolls = 0;
  } else if (shouldEmitAlert(consecutiveClusterWarnPolls)) {
    emitPoolExhaustionAlert({
      level: 'warning',
      message: 'database.pool.exhaustion.high',
      extra: {
        signal: 'cluster_pg_stat_activity',
        clusterActiveConnections: parameters.clusterActiveConnections,
        allowedApplicationConnections: parameters.allowedApplicationConnections,
        warnRatio: env.DATABASE_POOL_CLUSTER_WARN_RATIO,
        ...parameters.workerPoolDemandExtra,
      },
    });
    consecutiveClusterWarnPolls = 0;
  }
}

function resolveOverallPressureLevel(parameters: {
  activeLevel: PoolPressureLevel;
  clusterLevel: PoolPressureLevel;
}): PoolPressureLevel {
  if (parameters.activeLevel === 'critical' || parameters.clusterLevel === 'critical') {
    return 'critical';
  }
  if (parameters.activeLevel === 'warn' || parameters.clusterLevel === 'warn') {
    return 'warn';
  }
  return 'ok';
}

/**
 * Evaluates Postgres pool pressure from two independent signals and emits Sentry
 * + structured-log alerts when a level holds for N consecutive samples.
 *
 * @remarks
 * - **Algorithm:** computes `warn`/`critical` thresholds from
 *   `poolMaxConnections × DATABASE_POOL_ACTIVE_*_RATIO` (in-process organization RLS
 *   checkouts) and `allowedApplicationConnections × DATABASE_POOL_CLUSTER_*_RATIO`
 *   (cluster `pg_stat_activity`). Counters bump while over-threshold and reset
 *   to zero on `ok` or after an alert fires.
 * - **Failure modes:** never throws — missing cluster info short-circuits to
 *   `ok`; alert emission is fire-and-forget.
 * - **Side effects:** Sentry `captureMessage` and `logger.warn` / `logger.error`
 *   with worker pool-demand context attached when `isWorkerRuntime()`.
 * - **Notes:** call once per polling interval from `refreshPostgresPoolMetrics`;
 *   the returned {@link PoolPressureSample} is used for gauge updates and tests.
 */
export function evaluatePoolExhaustionAndAlert(parameters: {
  clusterActiveConnections: number;
  allowedApplicationConnections: number;
}): PoolPressureSample {
  const poolMaxConnections = resolvePoolMaxConnections();
  const activeOrganizationRlsCheckouts = getActiveOrganizationRlsCheckoutCount();
  const activeLevel = evaluateActiveCheckoutPressure(
    activeOrganizationRlsCheckouts,
    poolMaxConnections,
  );
  const clusterLevel = evaluateClusterPressure(
    parameters.clusterActiveConnections,
    parameters.allowedApplicationConnections,
  );

  consecutiveActiveCriticalPolls = bumpConsecutivePolls(
    consecutiveActiveCriticalPolls,
    activeLevel === 'critical',
  );
  consecutiveActiveWarnPolls = bumpConsecutivePolls(
    consecutiveActiveWarnPolls,
    activeLevel === 'warn',
  );
  consecutiveClusterCriticalPolls = bumpConsecutivePolls(
    consecutiveClusterCriticalPolls,
    clusterLevel === 'critical',
  );
  consecutiveClusterWarnPolls = bumpConsecutivePolls(
    consecutiveClusterWarnPolls,
    clusterLevel === 'warn',
  );

  const workerPoolDemandExtra = isWorkerRuntime()
    ? buildWorkerPoolDemandAlertExtra(getWorkerPostgresPoolDemandContext(), poolMaxConnections)
    : {};

  emitActiveCheckoutAlertIfNeeded({
    activeOrganizationRlsCheckouts,
    poolMaxConnections,
    workerPoolDemandExtra,
  });
  emitClusterAlertIfNeeded({
    clusterActiveConnections: parameters.clusterActiveConnections,
    allowedApplicationConnections: parameters.allowedApplicationConnections,
    workerPoolDemandExtra,
  });

  return {
    level: resolveOverallPressureLevel({ activeLevel, clusterLevel }),
    activeOrganizationRlsCheckouts,
    poolMaxConnections,
    clusterActiveConnections: parameters.clusterActiveConnections,
    allowedApplicationConnections: parameters.allowedApplicationConnections,
  };
}
