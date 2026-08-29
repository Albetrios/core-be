import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: Webhook Operations
 *
 * Simulates webhook management operations:
 * - List webhooks
 * - List webhook events
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'webhookOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-webhooks}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:list-webhook-events}': ['p(95)<500', 'p(99)<1000'],
  },
};

export function webhookOps() {
  const token = __ENV.TEST_TOKEN;
  if (!token) {
    console.error('TEST_TOKEN env var required');
    return;
  }

  // TEST_TOKEN must be minted scoped to TEST_ORG_ID — the active organization rides the
  // token's `org` claim, so the flat webhook routes carry no organization path segment.
  const headers = authHeaders(token).headers;

  // List webhooks
  const webhooksResponse = http.get(`${API_PREFIX}/notify/webhooks`, {
    headers,
    tags: { name: 'list-webhooks' },
  });
  checkResponseTime(webhooksResponse, 500, 'list-webhooks');

  sleep(0.5);

  // List webhook events
  const eventsResponse = http.get(`${API_PREFIX}/notify/webhook-events`, {
    headers,
    tags: { name: 'list-webhook-events' },
  });
  checkResponseTime(eventsResponse, 500, 'list-webhook-events');

  sleep(1);
}

export default webhookOps;
