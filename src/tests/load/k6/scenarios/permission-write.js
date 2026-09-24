import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: Permission write paths
 *
 * Exercises role permission resolution writes:
 * - GET roles for organization
 * - GET current role permissions
 * - PUT same permission set back (idempotent)
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'permissionWriteOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-roles}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:get-role-permissions}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:put-role-permissions}': ['p(95)<700', 'p(99)<1400'],
  },
};

export function permissionWriteOps() {
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

  const rolesResponse = http.get(`${API_PREFIX}/tenancy/organization/roles`, {
    headers,
    tags: { name: 'list-roles' },
  });
  checkOk(rolesResponse, 'list-roles');
  checkResponseTime(rolesResponse, 500, 'list-roles');

  if (rolesResponse.status !== 200) {
    sleep(1);
    return;
  }

  const rolesBody = JSON.parse(rolesResponse.body);
  const roles = rolesBody.data ?? [];
  const firstRole = roles[0];
  if (!firstRole?.id) {
    sleep(1);
    return;
  }

  sleep(0.3);

  const permissionsResponse = http.get(
    `${API_PREFIX}/tenancy/organization/roles/${firstRole.id}/permissions`,
    {
      headers,
      tags: { name: 'get-role-permissions' },
    },
  );
  checkOk(permissionsResponse, 'get-role-permissions');
  checkResponseTime(permissionsResponse, 500, 'get-role-permissions');

  if (permissionsResponse.status !== 200) {
    sleep(1);
    return;
  }

  const permissionsBody = JSON.parse(permissionsResponse.body);
  const permissionCodes = (permissionsBody.data ?? [])
    .map((permission) => permission.permission_code)
    .filter(Boolean);

  sleep(0.3);

  const putResponse = http.put(
    `${API_PREFIX}/tenancy/organization/roles/${firstRole.id}/permissions`,
    JSON.stringify({ permission_codes: permissionCodes }),
    {
      headers: jsonHeaders,
      tags: { name: 'put-role-permissions' },
    },
  );
  checkOk(putResponse, 'put-role-permissions');
  checkResponseTime(putResponse, 700, 'put-role-permissions');

  sleep(1);
}

export default permissionWriteOps;
