import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: Billing Operations
 *
 * Simulates billing-related operations:
 * - List plans (authenticated)
 * - List subscriptions
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'billingOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-plans}': ['p(95)<300', 'p(99)<600'],
    'http_req_duration{name:list-subscriptions}': ['p(95)<500', 'p(99)<1000'],
  },
};

export function billingOps() {
  const token = __ENV.TEST_TOKEN;
  if (!token) return;

  const headers = authHeaders(token).headers;

  const plansResponse = http.get(`${API_PREFIX}/billing/plans`, {
    headers,
    tags: { name: 'list-plans' },
  });
  checkOk(plansResponse, 'list-plans');
  checkResponseTime(plansResponse, 300, 'list-plans');

  sleep(0.3);

  // TEST_TOKEN must be minted scoped to TEST_ORG_ID — the active organization rides the
  // token's `org` claim, so the flat subscriptions route carries no organization path segment.
  const subsResponse = http.get(`${API_PREFIX}/billing/subscriptions`, {
    headers,
    tags: { name: 'list-subscriptions' },
  });
  checkResponseTime(subsResponse, 500, 'list-subscriptions');

  sleep(1);
}

export default billingOps;
