/**
 * k6 shared configuration for load tests.
 */
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const API_PREFIX = `${BASE_URL}/api/v1`;

export const THRESHOLDS = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'], // Less than 1% failure rate
  // No shared throughput floor: in a closed-loop scenario with think time, the request rate just
  // restates the pacing (webhooks and billing-subscriptions-rls failed a rate>10 floor at 9–10/s on
  // healthy runs). Latency and failure rate catch a slow server; a scenario that measures
  // throughput (api-stress) sets its own http_reqs threshold.
};

export const SMOKE_THRESHOLDS = {
  http_req_duration: ['p(95)<1000'],
  http_req_failed: ['rate<0.05'],
};

/** Stricter global preset for scenarios that define per-route thresholds. */
export const STRICT_THRESHOLDS = {
  http_req_duration: ['p(95)<400', 'p(99)<800'],
  http_req_failed: ['rate<0.01'],
};

/**
 * Capacity / breakpoint preset. `abortOnFail` stops the ramp at the first
 * breach so the run terminates at the system's breaking point instead of
 * hammering a saturated server. Pair with `SCENARIOS.breakpoint`.
 */
export const BREAKPOINT_THRESHOLDS = {
  http_req_duration: [{ threshold: 'p(95)<800', abortOnFail: true, delayAbortEval: '10s' }],
  http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '10s' }],
};

/**
 * Standard scenario presets for reuse.
 */
export const SCENARIOS = {
  /**
   * Organization writes, paced: one iteration per second across all VUs. Every organization write
   * route carries a 100-per-minute cap per (organization, actor) that RATE_LIMIT_RELAXED_CAPS does not
   * lift, and a k6 run is ONE actor (the demo user) — faster, and the scenario measures the rate
   * limiter (429) instead of the route.
   */
  pacedWrites: {
    executor: 'constant-arrival-rate',
    rate: 1,
    timeUnit: '1s',
    duration: '2m',
    preAllocatedVUs: 4,
    maxVUs: 10,
  },
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '30s',
  },
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 10 },
      { duration: '1m', target: 10 },
      { duration: '30s', target: 0 },
    ],
  },
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 20 },
      { duration: '1m', target: 50 },
      { duration: '30s', target: 100 },
      { duration: '30s', target: 0 },
    ],
  },
  spike: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '10s', target: 100 },
      { duration: '30s', target: 100 },
      { duration: '10s', target: 0 },
    ],
  },
  soak: {
    executor: 'constant-vus',
    vus: 10,
    duration: '10m',
  },
  /**
   * Capacity / breakpoint profile: ramps the *arrival rate* (requests/second,
   * decoupled from VU count) until the system saturates. Pair with
   * {@link BREAKPOINT_THRESHOLDS} (abortOnFail) so the run stops at the first
   * breach — the throughput at that point is the measured breaking point.
   */
  breakpoint: {
    executor: 'ramping-arrival-rate',
    startRate: 10,
    timeUnit: '1s',
    preAllocatedVUs: 50,
    maxVUs: 500,
    stages: [
      { duration: '30s', target: 50 },
      { duration: '2m', target: 300 },
    ],
  },
};
