import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime, checkStatus } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';
import { idempotencyKey } from '../helpers/idempotency.js';

/**
 * Organization notification policies, the whole lifecycle: list, create, read, update, delete.
 *
 * A policy is unique per (notification type, channel) in an organization, so each VU owns one pair
 * and runs create → delete in sequence without colliding with another VU. A 409 on create means
 * the pair already has a policy (seeded, or left by an interrupted run): that iteration only lists.
 */
const NOTIFICATION_TYPES = [
  'system.welcome',
  'system.maintenance',
  'security.alert',
  'billing.usage_threshold',
  'billing.payment_succeeded',
  'billing.payment_failed',
  'membership.invite_accepted',
  'subscription.updated',
  'webhook.delivery_failed',
];
const CHANNELS = ['EMAIL', 'SMS', 'WEB_PUSH', 'IN_APP'];

export const options = {
  scenarios: {
    load: { ...SCENARIOS.pacedWrites, exec: 'notificationPolicyCrudOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-notification-policies}': ['p(95)<600', 'p(99)<1200'],
    'http_req_duration{name:create-notification-policy}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{name:get-notification-policy}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:update-notification-policy}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{name:delete-notification-policy}': ['p(95)<800', 'p(99)<1500'],
  },
};

export function notificationPolicyCrudOps() {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  if (!(token && organizationPublicId)) return;

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.
  const { headers } = authHeaders(token);

  const listResponse = http.get(`${API_PREFIX}/tenancy/organization/notification-policies`, {
    headers,
    tags: { name: 'list-notification-policies' },
  });
  checkOk(listResponse, 'list-notification-policies');
  checkResponseTime(listResponse, 600, 'list-notification-policies');

  const pair = (__VU - 1) % (NOTIFICATION_TYPES.length * CHANNELS.length);
  const createResponse = http.post(
    `${API_PREFIX}/tenancy/organization/notification-policies`,
    JSON.stringify({
      notification_type: NOTIFICATION_TYPES[pair % NOTIFICATION_TYPES.length],
      channel: CHANNELS[Math.floor(pair / NOTIFICATION_TYPES.length)],
      default_enabled: true,
    }),
    {
      headers: { ...headers, 'X-Idempotency-Key': idempotencyKey('policy') },
      tags: { name: 'create-notification-policy' },
      responseCallback: http.expectedStatuses(200, 409),
    },
  );
  if (createResponse.status !== 200) {
    sleep(1);
    return;
  }
  const policyId = JSON.parse(createResponse.body).data.id;

  const getResponse = http.get(
    `${API_PREFIX}/tenancy/organization/notification-policies/${policyId}`,
    { headers, tags: { name: 'get-notification-policy' } },
  );
  checkStatus(getResponse, 200, 'get-notification-policy');

  const updateResponse = http.patch(
    `${API_PREFIX}/tenancy/organization/notification-policies/${policyId}`,
    JSON.stringify({ default_enabled: false }),
    { headers, tags: { name: 'update-notification-policy' } },
  );
  checkStatus(updateResponse, 200, 'update-notification-policy');

  const deleteResponse = http.del(
    `${API_PREFIX}/tenancy/organization/notification-policies/${policyId}`,
    null,
    { headers, tags: { name: 'delete-notification-policy' } },
  );
  checkStatus(deleteResponse, 204, 'delete-notification-policy');

  sleep(1);
}

export default notificationPolicyCrudOps;
