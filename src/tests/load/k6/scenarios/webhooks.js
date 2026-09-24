import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkResponseTime, checkStatus } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';
import { idempotencyKey } from '../helpers/idempotency.js';

/**
 * k6 Scenario: Webhook Operations
 *
 * Simulates webhook management operations:
 * - List webhooks
 * - List webhook events
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.pacedWrites, exec: 'webhookOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-webhooks}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:list-webhook-events}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:create-webhook}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{name:get-webhook}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:update-webhook}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{name:list-webhook-delivery-attempts}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:delete-webhook}': ['p(95)<800', 'p(99)<1500'],
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

  // The lifecycle: create → read → update → delivery attempts → delete. Each VU holds at most one
  // webhook at a time, far under WEBHOOK_MAX_PER_ORG (25). POST /webhooks/:id/test is left out on
  // purpose: it makes a live signed request to the webhook URL, and a load test must not hammer an
  // outside host. The target host must be on WEBHOOK_URL_ALLOWLIST (the SSRF guard).
  const createResponse = http.post(
    `${API_PREFIX}/notify/webhooks`,
    JSON.stringify({ url: 'https://example.com/k6-load-test', events: ['subscription.updated'] }),
    {
      headers: { ...headers, 'X-Idempotency-Key': idempotencyKey('webhook') },
      tags: { name: 'create-webhook' },
    },
  );
  checkStatus(createResponse, 200, 'create-webhook');
  if (createResponse.status !== 200) {
    sleep(1);
    return;
  }
  const webhookId = JSON.parse(createResponse.body).data.id;

  const getResponse = http.get(`${API_PREFIX}/notify/webhooks/${webhookId}`, {
    headers,
    tags: { name: 'get-webhook' },
  });
  checkStatus(getResponse, 200, 'get-webhook');

  const updateResponse = http.patch(
    `${API_PREFIX}/notify/webhooks/${webhookId}`,
    JSON.stringify({ is_enabled: false }),
    { headers, tags: { name: 'update-webhook' } },
  );
  checkStatus(updateResponse, 200, 'update-webhook');

  const attemptsResponse = http.get(
    `${API_PREFIX}/notify/webhooks/${webhookId}/delivery-attempts`,
    { headers, tags: { name: 'list-webhook-delivery-attempts' } },
  );
  checkStatus(attemptsResponse, 200, 'list-webhook-delivery-attempts');

  const deleteResponse = http.del(`${API_PREFIX}/notify/webhooks/${webhookId}`, null, {
    headers,
    tags: { name: 'delete-webhook' },
  });
  checkStatus(deleteResponse, 204, 'delete-webhook');

  sleep(1);
}

export default webhookOps;
