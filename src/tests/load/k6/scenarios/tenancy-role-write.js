import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: Tenancy role write paths
 *
 * Exercises role management writes:
 * - POST create role (unique name per VU/iteration)
 * - PATCH role description (idempotent)
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'tenancyRoleWriteOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:create-role}': ['p(95)<700', 'p(99)<1400'],
    'http_req_duration{name:patch-role}': ['p(95)<600', 'p(99)<1200'],
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
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  const roleName = `Load Test Role ${__VU}-${__ITER}`;
  const createResponse = http.post(
    `${API_PREFIX}/tenancy/organization/roles`,
    JSON.stringify({
      name: roleName,
      description: 'k6 load test role',
    }),
    {
      headers: jsonHeaders,
      tags: { name: 'create-role' },
    },
  );
  checkResponseTime(createResponse, 700, 'create-role');

  if (createResponse.status !== 200 && createResponse.status !== 200) {
    sleep(1);
    return;
  }

  const createBody = JSON.parse(createResponse.body);
  const roleId = createBody.data?.id;
  if (!roleId) {
    sleep(1);
    return;
  }

  sleep(0.3);

  const patchResponse = http.patch(
    `${API_PREFIX}/tenancy/organization/roles/${roleId}`,
    JSON.stringify({ description: 'k6 load test role (updated)' }),
    {
      headers: jsonHeaders,
      tags: { name: 'patch-role' },
    },
  );
  checkOk(patchResponse, 'patch-role');
  checkResponseTime(patchResponse, 600, 'patch-role');

  sleep(1);
}

export default tenancyRoleWriteOps;
