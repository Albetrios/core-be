import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkStatus } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: organization API keys, the whole lifecycle — list, create, read, rename, rotate,
 * delete. Each VU holds at most one active key at a time, far under ORGANIZATION_API_KEY_MAX_PER_ORG
 * (25). The key asks only for a scope the demo admin holds (`organization:read`).
 *
 * Requires: TEST_TOKEN, already scoped to TEST_ORG_ID (tool:load-test-credentials).
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'apiKeyLifecycleOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-api-keys}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:create-api-key}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{name:get-api-key}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:update-api-key}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{name:rotate-api-key}': ['p(95)<800', 'p(99)<1500'],
    'http_req_duration{name:delete-api-key}': ['p(95)<800', 'p(99)<1500'],
  },
};

export function apiKeyLifecycleOps() {
  const token = __ENV.TEST_TOKEN;
  if (!token) return;
  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.
  const { headers } = authHeaders(token);

  const listResponse = http.get(`${API_PREFIX}/tenancy/organization/api-keys`, {
    headers,
    tags: { name: 'list-api-keys' },
  });
  checkOk(listResponse, 'list-api-keys');

  const createResponse = http.post(
    `${API_PREFIX}/tenancy/organization/api-keys`,
    JSON.stringify({ name: `k6 key ${__VU}-${__ITER}`, scopes: ['organization:read'] }),
    {
      headers: { ...headers, 'X-Idempotency-Key': `k6-api-key-${__VU}-${__ITER}` },
      tags: { name: 'create-api-key' },
    },
  );
  checkStatus(createResponse, 200, 'create-api-key');
  if (createResponse.status !== 200) {
    sleep(1);
    return;
  }
  const apiKeyId = JSON.parse(createResponse.body).data.id;

  const getResponse = http.get(`${API_PREFIX}/tenancy/organization/api-keys/${apiKeyId}`, {
    headers,
    tags: { name: 'get-api-key' },
  });
  checkStatus(getResponse, 200, 'get-api-key');

  const updateResponse = http.patch(
    `${API_PREFIX}/tenancy/organization/api-keys/${apiKeyId}`,
    JSON.stringify({ name: `k6 key ${__VU}-${__ITER} renamed` }),
    { headers, tags: { name: 'update-api-key' } },
  );
  checkStatus(updateResponse, 200, 'update-api-key');

  const rotateResponse = http.post(
    `${API_PREFIX}/tenancy/organization/api-keys/${apiKeyId}/rotate`,
    JSON.stringify({}),
    { headers, tags: { name: 'rotate-api-key' } },
  );
  checkStatus(rotateResponse, 200, 'rotate-api-key');
  // Rotation may issue the replacement under a new id; delete whichever key is live now.
  const liveKeyId =
    rotateResponse.status === 200
      ? (JSON.parse(rotateResponse.body).data?.id ?? apiKeyId)
      : apiKeyId;

  const deleteResponse = http.del(
    `${API_PREFIX}/tenancy/organization/api-keys/${liveKeyId}`,
    null,
    { headers, tags: { name: 'delete-api-key' } },
  );
  checkStatus(deleteResponse, 204, 'delete-api-key');

  sleep(1);
}

export default apiKeyLifecycleOps;
