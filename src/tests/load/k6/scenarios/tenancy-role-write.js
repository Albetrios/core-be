import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime, checkStatus } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';
import { idempotencyKey } from '../helpers/idempotency.js';

/**
 * k6 Scenario: Tenancy role write paths — one role's whole lifecycle per iteration:
 * - POST create role (a unique name; the route requires an X-Idempotency-Key)
 * - PATCH role description
 * - DELETE role, so roles never pile up against MEMBER_ROLE_MAX_PER_ORG
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.pacedWrites, exec: 'tenancyRoleWriteOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:create-role}': ['p(95)<700', 'p(99)<1400'],
    'http_req_duration{name:patch-role}': ['p(95)<600', 'p(99)<1200'],
    'http_req_duration{name:delete-role}': ['p(95)<700', 'p(99)<1400'],
  },
};

export function tenancyRoleWriteOps() {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  if (!(token && organizationPublicId)) {
    return;
  }

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.
  const headers = authHeaders(token).headers;

  const createResponse = http.post(
    `${API_PREFIX}/tenancy/organization/roles`,
    JSON.stringify({
      name: `Load Test Role ${__VU}-${__ITER}-${Date.now()}`,
      description: 'k6 load test role',
    }),
    {
      headers: { ...headers, 'X-Idempotency-Key': idempotencyKey('role') },
      tags: { name: 'create-role' },
    },
  );
  checkStatus(createResponse, 200, 'create-role');
  checkResponseTime(createResponse, 700, 'create-role');
  const roleId = createResponse.status === 200 ? JSON.parse(createResponse.body).data?.id : null;
  if (!roleId) {
    sleep(1);
    return;
  }

  sleep(0.3);

  const patchResponse = http.patch(
    `${API_PREFIX}/tenancy/organization/roles/${roleId}`,
    JSON.stringify({ description: 'k6 load test role (updated)' }),
    { headers, tags: { name: 'patch-role' } },
  );
  checkOk(patchResponse, 'patch-role');
  checkResponseTime(patchResponse, 600, 'patch-role');

  const deleteResponse = http.del(`${API_PREFIX}/tenancy/organization/roles/${roleId}`, null, {
    headers,
    tags: { name: 'delete-role' },
  });
  checkStatus(deleteResponse, 204, 'delete-role');

  sleep(1);
}

export default tenancyRoleWriteOps;
