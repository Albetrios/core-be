import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders, switchToOrganization } from '../helpers/auth.js';

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
  let token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  const subscriptionPublicId = __ENV.TEST_SUBSCRIPTION_ID;
  if (!(token && organizationPublicId)) return;

  // The active organization rides the token's `org` claim — scope the token to TEST_ORG_ID
  // so the flat RLS route resolves the right organization.
  token = switchToOrganization(token, organizationPublicId) || token;
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
