import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { OrganizationRlsCheckoutPath } from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import {
  getMetricsRegistry,
  isMetricsEnabled,
} from '@/infrastructure/observability/metrics/metrics-registry.js';

/** Default latency histogram buckets (seconds) for fast HTTP / DB-checkout operations. */
const DEFAULT_LATENCY_BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** Coarser histogram buckets (seconds) for slower BullMQ job durations. */
const JOB_DURATION_BUCKETS_SECONDS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

let registeredMetricsRegistry: Registry | null = null;

type HttpRequestMetricLabel = 'method' | 'route' | 'status_code';
let httpRequestsTotal: Counter<HttpRequestMetricLabel> | null = null;
let httpRequestDurationSeconds: Histogram<HttpRequestMetricLabel> | null = null;
let bullmqQueueWaiting: Gauge<'queue'> | null = null;
let bullmqQueueActive: Gauge<'queue'> | null = null;
let bullmqQueueDelayed: Gauge<'queue'> | null = null;
let bullmqQueueFailed: Gauge<'queue'> | null = null;
let bullmqJobDurationSeconds: Histogram<'queue' | 'job_name'> | null = null;
let postgresPoolMaxConnections: Gauge | null = null;
let postgresPoolMetricsAvailable: Gauge | null = null;
let dbPoolConnections: Gauge<'state'> | null = null;
let pgPoolActive: Gauge | null = null;
let pgPoolIdle: Gauge | null = null;
let pgPoolWaiting: Gauge | null = null;
let bullmqJobsWaiting: Gauge<'queue'> | null = null;
let eventLoopLagMilliseconds: Gauge | null = null;
let stripeWebhookEventsFailed: Gauge | null = null;
let mailOutboxPending: Gauge | null = null;
let dlqDepthTotal: Gauge | null = null;
let databaseRlsActiveCheckouts: Gauge | null = null;
let databaseRlsCheckoutHoldSeconds: Histogram<'path'> | null = null;
let processUnhandledRejectionsTotal: Counter<'process'> | null = null;
let eventBusHandlerFailuresTotal: Counter<'event_type'> | null = null;
let commitDispatchDurabilityFallbacksTotal: Counter | null = null;
let readCacheRequestsTotal: Counter<'cache' | 'result'> | null = null;
let databaseUnscopedQueriesTotal: Counter | null = null;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: single registration site for all Prometheus instruments — boilerplate, intentionally long
function registerOn(registry: Registry): void {
  httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: DEFAULT_LATENCY_BUCKETS_SECONDS,
    registers: [registry],
  });

  bullmqQueueWaiting = new Gauge({
    name: 'bullmq_queue_waiting',
    help: 'BullMQ jobs waiting in queue',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqQueueActive = new Gauge({
    name: 'bullmq_queue_active',
    help: 'BullMQ jobs currently active',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqQueueDelayed = new Gauge({
    name: 'bullmq_queue_delayed',
    help: 'BullMQ jobs delayed',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqQueueFailed = new Gauge({
    name: 'bullmq_queue_failed',
    help: 'BullMQ jobs in failed state',
    labelNames: ['queue'],
    registers: [registry],
  });

  bullmqJobDurationSeconds = new Histogram({
    name: 'bullmq_job_duration_seconds',
    help: 'BullMQ job processing duration in seconds',
    labelNames: ['queue', 'job_name'],
    buckets: JOB_DURATION_BUCKETS_SECONDS,
    registers: [registry],
  });

  postgresPoolMaxConnections = new Gauge({
    name: 'postgres_pool_max_connections',
    help: 'Configured postgres.js pool max connections (DATABASE_POOL_MAX)',
    registers: [registry],
  });

  postgresPoolMetricsAvailable = new Gauge({
    name: 'postgres_pool_metrics_available',
    help: '1 when live pool utilization metrics are exported; 0 when only config gauge is available (postgres.js limitation)',
    registers: [registry],
  });

  dbPoolConnections = new Gauge({
    name: 'db_pool_connections',
    help: 'Postgres connections for the current database user sampled from pg_stat_activity',
    labelNames: ['state'],
    registers: [registry],
  });

  pgPoolActive = new Gauge({
    name: 'pg_pool_active',
    help: 'Postgres connections in active state (alias of db_pool_connections{state="active"})',
    registers: [registry],
  });

  pgPoolIdle = new Gauge({
    name: 'pg_pool_idle',
    help: 'Postgres connections in idle state (alias of db_pool_connections{state="idle"})',
    registers: [registry],
  });

  pgPoolWaiting = new Gauge({
    name: 'pg_pool_waiting',
    help: 'Postgres connections waiting (alias of db_pool_connections{state="waiting"})',
    registers: [registry],
  });

  bullmqJobsWaiting = new Gauge({
    name: 'bullmq_jobs_waiting',
    help: 'BullMQ jobs waiting in queue (alias of bullmq_queue_waiting)',
    labelNames: ['queue'],
    registers: [registry],
  });

  eventLoopLagMilliseconds = new Gauge({
    name: 'event_loop_lag_ms',
    help: 'Node.js event loop delay p99 in milliseconds (perf_hooks.monitorEventLoopDelay)',
    registers: [registry],
  });

  stripeWebhookEventsFailed = new Gauge({
    name: 'stripe_webhook_events_failed',
    help: 'Stripe webhook ledger rows in failed processing_status (alert when >0 for >10m)',
    registers: [registry],
  });

  mailOutboxPending = new Gauge({
    name: 'mail_outbox_pending',
    help: 'Pending rows in auth.mail_outbox awaiting BullMQ dispatch',
    registers: [registry],
  });

  dlqDepthTotal = new Gauge({
    name: 'dlq_depth',
    help: 'Total BullMQ dead-letter jobs (waiting + failed) across monitored source queues',
    registers: [registry],
  });

  databaseRlsActiveCheckouts = new Gauge({
    name: 'database_rls_active_checkouts',
    help: 'In-process organization-scoped RLS transaction checkouts currently held (early pool-saturation signal; alert near DATABASE_POOL_MAX)',
    registers: [registry],
  });

  databaseRlsCheckoutHoldSeconds = new Histogram({
    name: 'database_rls_checkout_hold_seconds',
    help: 'Wall-clock seconds an organization-scoped RLS transaction held a pooled connection, by path (scoped_context | request_transaction)',
    labelNames: ['path'],
    buckets: DEFAULT_LATENCY_BUCKETS_SECONDS,
    registers: [registry],
  });

  databaseUnscopedQueriesTotal = new Counter({
    name: 'database_unscoped_query_total',
    help: 'Queries issued on the bare pool with no database context active (possible RLS bypass)',
    registers: [registry],
  });

  processUnhandledRejectionsTotal = new Counter({
    name: 'process_unhandled_rejections_total',
    help: 'Non-fatal unhandledRejection events tolerated by the burst handler, by process (api | worker). Alert on a sustained sub-threshold rate — it hides a persistent failing path that never trips the fatal burst exit',
    labelNames: ['process'],
    registers: [registry],
  });

  eventBusHandlerFailuresTotal = new Counter({
    name: 'event_bus_handler_failures_total',
    help: 'Domain-event handler failures swallowed by eventBus.emit (best-effort side effects), by event_type. A sustained rate hides a persistently failing handler (email/webhook/audit enqueue) that never fails the originating request',
    labelNames: ['event_type'],
    registers: [registry],
  });

  commitDispatchDurabilityFallbacksTotal = new Counter({
    name: 'commit_dispatch_durability_fallbacks_total',
    help: 'Post-commit dispatch tasks that fell back from durable Redis persistence to the lossy in-memory onCommit path because the Redis RPUSH failed. Any non-zero value is a durability-degradation signal — the side effect is lost if the process dies before flush',
    registers: [registry],
  });

  readCacheRequestsTotal = new Counter({
    name: 'read_cache_requests_total',
    help: 'Read-through cache lookups by cache name and result (hit | miss). A cache whose hit ratio sits near zero is pure overhead — it is paying a Redis round trip to still ask Postgres — and one whose ratio collapses after a deploy usually means an invalidation became too broad. Alert on a sustained drop, not on an absolute value: the right ratio differs per cache',
    labelNames: ['cache', 'result'],
    registers: [registry],
  });
}

function bindMetricHandlesFromRegistry(registry: Registry): void {
  httpRequestsTotal = registry.getSingleMetric('http_requests_total') as Counter<
    'method' | 'route' | 'status_code'
  >;
  httpRequestDurationSeconds = registry.getSingleMetric(
    'http_request_duration_seconds',
  ) as Histogram<'method' | 'route' | 'status_code'>;
  bullmqQueueWaiting = registry.getSingleMetric('bullmq_queue_waiting') as Gauge<'queue'>;
  bullmqQueueActive = registry.getSingleMetric('bullmq_queue_active') as Gauge<'queue'>;
  bullmqQueueDelayed = registry.getSingleMetric('bullmq_queue_delayed') as Gauge<'queue'>;
  bullmqQueueFailed = registry.getSingleMetric('bullmq_queue_failed') as Gauge<'queue'>;
  bullmqJobDurationSeconds = registry.getSingleMetric('bullmq_job_duration_seconds') as Histogram<
    'queue' | 'job_name'
  >;
  postgresPoolMaxConnections = registry.getSingleMetric('postgres_pool_max_connections') as Gauge;
  postgresPoolMetricsAvailable = registry.getSingleMetric(
    'postgres_pool_metrics_available',
  ) as Gauge;
  dbPoolConnections = registry.getSingleMetric('db_pool_connections') as Gauge<'state'>;
  pgPoolActive = registry.getSingleMetric('pg_pool_active') as Gauge;
  pgPoolIdle = registry.getSingleMetric('pg_pool_idle') as Gauge;
  pgPoolWaiting = registry.getSingleMetric('pg_pool_waiting') as Gauge;
  bullmqJobsWaiting = registry.getSingleMetric('bullmq_jobs_waiting') as Gauge<'queue'>;
  eventLoopLagMilliseconds = registry.getSingleMetric('event_loop_lag_ms') as Gauge;
  stripeWebhookEventsFailed = registry.getSingleMetric('stripe_webhook_events_failed') as Gauge;
  mailOutboxPending = registry.getSingleMetric('mail_outbox_pending') as Gauge;
  dlqDepthTotal = registry.getSingleMetric('dlq_depth') as Gauge;
  databaseRlsActiveCheckouts = registry.getSingleMetric('database_rls_active_checkouts') as Gauge;
  databaseRlsCheckoutHoldSeconds = registry.getSingleMetric(
    'database_rls_checkout_hold_seconds',
  ) as Histogram<'path'>;
  processUnhandledRejectionsTotal = registry.getSingleMetric(
    'process_unhandled_rejections_total',
  ) as Counter<'process'>;
  eventBusHandlerFailuresTotal = registry.getSingleMetric(
    'event_bus_handler_failures_total',
  ) as Counter<'event_type'>;
  commitDispatchDurabilityFallbacksTotal = registry.getSingleMetric(
    'commit_dispatch_durability_fallbacks_total',
  ) as Counter;
  readCacheRequestsTotal = registry.getSingleMetric('read_cache_requests_total') as Counter<
    'cache' | 'result'
  >;
  registeredMetricsRegistry = registry;
}

/**
 * Registers custom Prometheus metrics on the given registry.
 * Safe to call from scrape refresh and per-request recording (no circular import with metrics.ts).
 */
export function ensurePrometheusMetricsRegistered(registry: Registry): void {
  if (!isMetricsEnabled()) {
    return;
  }
  if (httpRequestsTotal && httpRequestDurationSeconds) {
    return;
  }
  if (registry.getSingleMetric('http_requests_total')) {
    bindMetricHandlesFromRegistry(registry);
    return;
  }
  registerOn(registry);
  registeredMetricsRegistry = registry;
}

/**
 * Records one HTTP request into `http_requests_total` (counter) and
 * `http_request_duration_seconds` (histogram) keyed by method/route/status.
 * No-op when metrics are disabled or registration has not yet happened.
 */
export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number,
): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!(httpRequestsTotal && httpRequestDurationSeconds)) return;

  const labels = {
    method: method.toUpperCase(),
    route,
    status_code: String(statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, durationSeconds);
}

/**
 * Updates the `bullmq_queue_{waiting,active,delayed,failed}` gauges (plus the
 * legacy `bullmq_jobs_waiting` alias) for a single queue from a freshly read
 * `getJobCounts` payload. Called by {@link refreshBullMQQueueGauges}.
 */
export function setBullMQQueueCounts(
  queueName: string,
  counts: { waiting: number; active: number; delayed: number; failed: number },
): void {
  if (!isMetricsEnabled()) return;
  if (!(bullmqQueueWaiting && bullmqQueueActive && bullmqQueueDelayed && bullmqQueueFailed)) {
    return;
  }
  const label = { queue: queueName };
  bullmqQueueWaiting.set(label, counts.waiting);
  bullmqJobsWaiting?.set(label, counts.waiting);
  bullmqQueueActive.set(label, counts.active);
  bullmqQueueDelayed.set(label, counts.delayed);
  bullmqQueueFailed.set(label, counts.failed);
}

/**
 * Observes one BullMQ job's processing duration on the
 * `bullmq_job_duration_seconds` histogram, labelled by queue + job name. Wired
 * to worker `completed` events via `attachBullMQJobMetrics`.
 */
export function recordBullMQJobDuration(
  queueName: string,
  jobName: string,
  durationSeconds: number,
): void {
  if (!isMetricsEnabled()) return;
  const histogram =
    bullmqJobDurationSeconds ??
    (registeredMetricsRegistry?.getSingleMetric('bullmq_job_duration_seconds') as
      | Histogram<'queue' | 'job_name'>
      | undefined);
  if (!histogram) return;
  histogram.observe({ queue: queueName, job_name: jobName }, durationSeconds);
}

/**
 * Sets the static pool-configuration gauges: `postgres_pool_max_connections`
 * and `postgres_pool_metrics_available` (1 when `pg_stat_activity` sampling
 * succeeded, 0 when only the configured ceiling is known).
 */
export function setPostgresPoolConfigMetrics(options: {
  maxConnections: number;
  liveMetricsAvailable: boolean;
}): void {
  if (!isMetricsEnabled()) return;
  if (!(postgresPoolMaxConnections && postgresPoolMetricsAvailable)) return;
  postgresPoolMaxConnections.set(options.maxConnections);
  postgresPoolMetricsAvailable.set(options.liveMetricsAvailable ? 1 : 0);
}

/**
 * Sets the `db_pool_connections{state=...}` gauge plus the legacy
 * `pg_pool_{active,idle,waiting}` aliases from a fresh `pg_stat_activity` sample.
 * Missing states default to 0 so dashboards see a stable schema.
 */
export function setPostgresPoolConnectionCounts(
  samples: ReadonlyArray<{ state: 'active' | 'idle' | 'waiting'; count: number }>,
): void {
  if (!isMetricsEnabled()) return;
  if (!dbPoolConnections) return;

  const countsByState: Record<'active' | 'idle' | 'waiting', number> = {
    active: 0,
    idle: 0,
    waiting: 0,
  };

  for (const sample of samples) {
    dbPoolConnections.set({ state: sample.state }, sample.count);
    countsByState[sample.state] = sample.count;
  }

  pgPoolActive?.set(countsByState.active);
  pgPoolIdle?.set(countsByState.idle);
  pgPoolWaiting?.set(countsByState.waiting);
}

/**
 * Updates the `event_loop_lag_ms` gauge from the perf-hooks p99 sample.
 * Lazily registers metrics so the event-loop refresh path can run before the
 * scrape endpoint has been hit.
 */
export function setEventLoopLagMilliseconds(lagMilliseconds: number): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!eventLoopLagMilliseconds) return;
  eventLoopLagMilliseconds.set(lagMilliseconds);
}

/**
 * Sets the `stripe_webhook_events_failed` gauge — fed by the Stripe ledger
 * reclaim worker so dashboards alert when failed rows linger more than 10
 * minutes (Sentry rule, see help text on the metric).
 */
export function setStripeWebhookEventsFailedCount(count: number): void {
  if (!isMetricsEnabled()) return;
  if (!stripeWebhookEventsFailed) return;
  stripeWebhookEventsFailed.set(count);
}

/**
 * Sets business-level backlog gauges refreshed on each Prometheus scrape.
 */
export function setBusinessMetricCounts(options: {
  mailOutboxPending: number;
  dlqDepth: number;
}): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  mailOutboxPending?.set(options.mailOutboxPending);
  dlqDepthTotal?.set(options.dlqDepth);
}

/**
 * Sets the `database_rls_active_checkouts` gauge from the in-process organization-RLS checkout
 * counter. Fed by the pool-metrics scrape refresh so dashboards see how many organization-scoped
 * RLS checkouts are held against `DATABASE_POOL_MAX` before postgres.js starts queuing.
 */
export function setOrganizationRlsActiveCheckouts(count: number): void {
  if (!isMetricsEnabled()) return;
  if (!databaseRlsActiveCheckouts) return;
  databaseRlsActiveCheckouts.set(count);
}

/**
 * Observes one completed organization-RLS checkout hold on the `database_rls_checkout_hold_seconds`
 * histogram, labelled by `path` (`scoped_context` unit of work vs legacy full-request
 * `request_transaction`). Wired via `registerOrganizationRlsCheckoutHoldObserver` so the hot
 * database-checkout paths stay free of a prom-client import. No-op when metrics are disabled.
 */
export function recordOrganizationRlsCheckoutHold(options: {
  path: OrganizationRlsCheckoutPath;
  durationSeconds: number;
}): void {
  if (!isMetricsEnabled()) return;
  if (!databaseRlsCheckoutHoldSeconds) return;
  databaseRlsCheckoutHoldSeconds.observe({ path: options.path }, options.durationSeconds);
}

/** Process whose `unhandledRejection` handler fired — distinguishes API from worker series. */
export type UnhandledRejectionProcess = 'api' | 'worker';

/**
 * Increments `process_unhandled_rejections_total{process}` for one non-fatal
 * `unhandledRejection`. Lazily registers metrics so the very first rejection (which can occur
 * before any scrape) is still counted. No-op when metrics are disabled — the rejection is still
 * logged + captured by the caller, so observability never depends on `METRICS_ENABLED`.
 */
export function recordUnhandledRejection(process: UnhandledRejectionProcess): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!processUnhandledRejectionsTotal) return;
  processUnhandledRejectionsTotal.inc({ process });
}

/**
 * Increments `event_bus_handler_failures_total{event_type}` for one best-effort domain-event
 * handler that threw inside {@link eventBus.emit}. No-op when metrics are disabled — the failure is
 * still logged and captured by the caller, so observability never depends on `METRICS_ENABLED`.
 */
export function recordEventBusHandlerFailure(eventType: string): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!eventBusHandlerFailuresTotal) return;
  eventBusHandlerFailuresTotal.inc({ event_type: eventType });
}

/**
 * Increments `commit_dispatch_durability_fallbacks_total` when a post-commit dispatch task could not
 * be persisted to Redis and fell back to the lossy in-memory path. No-op when metrics are disabled —
 * the fallback is still logged and captured to Sentry by the caller.
 */
export function recordCommitDispatchDurabilityFallback(): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!commitDispatchDurabilityFallbacksTotal) return;
  commitDispatchDurabilityFallbacksTotal.inc();
}

/**
 * Records one read-through cache lookup.
 *
 * @remarks
 * - **Algorithm:** increments `read_cache_requests_total{cache,result}`; a no-op when metrics are
 *   disabled or the registry has not been built.
 * - **Failure modes:** none — never throws into a read path.
 * - **Side effects:** one counter increment.
 * - **Notes:** `cache` is the cache's own name (`notify_unread_count`), not the Redis key, so the
 *   label stays bounded — a per-key label would be unbounded cardinality. Without this, a cache is
 *   unfalsifiable: it either helps or quietly costs a round trip per request and nothing says which.
 */
export function recordReadCacheRequest(cache: string, result: 'hit' | 'miss'): void {
  if (!isMetricsEnabled()) return;
  ensurePrometheusMetricsRegistered(getMetricsRegistry());
  if (!readCacheRequestsTotal) return;
  readCacheRequestsTotal.inc({ cache, result });
}

/**
 * Increments `database_unscoped_query_total`.
 *
 * @remarks
 * A non-zero rate means some path reached Postgres without a database context. Against a
 * FORCE RLS table that silently returns zero rows — how offboarding came to erase nothing —
 * so this is the counter to alert on, not merely graph.
 */
export function recordUnscopedDatabaseQuery(): void {
  databaseUnscopedQueriesTotal?.inc();
}
