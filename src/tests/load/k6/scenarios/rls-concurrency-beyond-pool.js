import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * RLS concurrency-beyond-pool scenario.
 *
 * Validates production-readiness audit item #5 (per-request RLS transaction pinning):
 * with DATABASE_RLS_SCOPED_CONTEXTS=true, an organization-scoped (RLS) endpoint must sustain
 * concurrency well above DATABASE_POOL_MAX without failures. Under the legacy
 * request-pinned model each in-flight organization request held a pooled checkout for its whole
 * lifetime, so the API saturated at ~DATABASE_POOL_MAX concurrent requests. With scoped
 * contexts the checkout is only held for the actual unit-of-work, so the same pool should
 * absorb several multiples of concurrent requests.
 *
 * Env:
 *   TEST_TOKEN, TEST_ORG_ID  (required — scenario is a no-op without them)
 *   DATABASE_POOL_MAX        (default 20) — pool size to exceed
 *   BEYOND_POOL_FACTOR       (default 4)  — target VUs = DATABASE_POOL_MAX * factor
 *   BEYOND_POOL_VUS          (optional)   — explicit target VU override
 */
const poolMax = Number.parseInt(__ENV.DATABASE_POOL_MAX || '20', 10);
const beyondPoolFactor = Number.parseInt(__ENV.BEYOND_POOL_FACTOR || '4', 10);
const targetVus = Number.parseInt(
  __ENV.BEYOND_POOL_VUS || String(Math.max(poolMax * beyondPoolFactor, poolMax + 1)),
  10,
);

export const options = {
  scenarios: {
    rlsBeyondPool: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: targetVus },
        { duration: '1m', target: targetVus },
        { duration: '15s', target: 0 },
      ],
      exec: 'rlsConcurrencyBeyondPool',
    },
  },
  thresholds: {
    // The audit ceiling: requests must not fail when concurrency exceeds the pool.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:rls-beyond-pool}': ['p(95)<800', 'p(99)<1500'],
  },
};

export function rlsConcurrencyBeyondPool() {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  if (!(token && organizationPublicId)) return;

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.

  const response = http.get(`${API_PREFIX}/tenancy/organization/memberships`, {
    ...authHeaders(token),
    tags: { name: 'rls-beyond-pool' },
  });
  checkOk(response, 'rls-beyond-pool');
  checkResponseTime(response, 800, 'rls-beyond-pool');

  // Keep requests in flight to maximize concurrent in-process checkouts.
  sleep(0.1);
}

export default rlsConcurrencyBeyondPool;
