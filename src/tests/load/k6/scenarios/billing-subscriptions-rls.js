import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'billingSubscriptionsRlsOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-subscriptions-rls}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:get-subscription-rls}': ['p(95)<500', 'p(99)<1000'],
  },
};

export function billingSubscriptionsRlsOps() {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  const subscriptionPublicId = __ENV.TEST_SUBSCRIPTION_ID;
  if (!(token && organizationPublicId)) return;

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.
  const headers = authHeaders(token).headers;

  const listResponse = http.get(`${API_PREFIX}/billing/subscriptions`, {
    headers,
    tags: { name: 'list-subscriptions-rls' },
  });
  checkOk(listResponse, 'list-subscriptions-rls');
  checkResponseTime(listResponse, 500, 'list-subscriptions-rls');

  sleep(0.3);

  if (subscriptionPublicId) {
    const getResponse = http.get(`${API_PREFIX}/billing/subscriptions/${subscriptionPublicId}`, {
      headers,
      tags: { name: 'get-subscription-rls' },
    });
    if (getResponse.status === 200 || getResponse.status === 404) {
      checkResponseTime(getResponse, 500, 'get-subscription-rls');
    }
  }

  sleep(0.5);
}

export default billingSubscriptionsRlsOps;
