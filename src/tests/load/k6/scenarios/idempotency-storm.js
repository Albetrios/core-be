import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, SMOKE_THRESHOLDS } from '../helpers/config.js';
import { checkStatus } from '../helpers/checks.js';

/**
 * Hammer an idempotency-protected route with the same key (expect 409 or 422 on duplicates).
 */
export const options = {
  scenarios: {
    idempotencyStorm: {
      // 20 requests shared by 5 VUs. `constant-vus` (the smoke profile) takes no `iterations`,
      // and k6 2 refuses to load a scenario with an unknown field.
      executor: 'shared-iterations',
      exec: 'idempotencyStorm',
      vus: 5,
      iterations: 20,
      maxDuration: '30s',
    },
  },
  thresholds: {
    ...SMOKE_THRESHOLDS,
    'http_req_duration{name:idempotency-storm}': ['p(95)<1200', 'p(99)<2000'],
  },
};

export function idempotencyStorm() {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  if (!(token && organizationPublicId)) {
    sleep(1);
    return;
  }

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.

  const idempotencyKey = `k6-storm-${organizationPublicId}`;
  const response = http.post(
    `${API_PREFIX}/billing/subscriptions`,
    JSON.stringify({ plan_public_id: 'plan_free', billing_cycle: 'monthly' }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      tags: { name: 'idempotency-storm' },
      responseCallback: http.expectedStatuses(200, 200, 409, 422),
    },
  );

  checkStatus(response, [200, 200, 409, 422], 'idempotency-storm');
  sleep(0.1);
}

export default idempotencyStorm;
