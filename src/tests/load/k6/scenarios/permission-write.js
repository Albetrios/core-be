import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';
import { idempotencyKey } from '../helpers/idempotency.js';

/**
 * k6 Scenario: Permission write paths on a role of the scenario's own.
 *
 * The owner's role cannot be edited — 403 by design, transfer ownership first — and the first role
 * an organization lists IS the owner's, so this used to fail every write. setup() now creates a
 * role, every VU reads and replaces its permission set, and teardown() deletes it.
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.pacedWrites, exec: 'permissionWriteOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-roles}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:get-role-permissions}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:put-role-permissions}': ['p(95)<700', 'p(99)<1400'],
  },
};

export function setup() {
  const token = __ENV.TEST_TOKEN;
  if (!token) {
    return { roleId: null };
  }
  const response = http.post(
    `${API_PREFIX}/tenancy/organization/roles`,
    JSON.stringify({ name: `k6 permission-write ${Date.now()}`, description: 'k6 target role' }),
    {
      headers: {
        ...authHeaders(token).headers,
        'X-Idempotency-Key': idempotencyKey('permission-role'),
      },
      tags: { name: 'create-target-role' },
    },
  );
  return { roleId: response.status === 200 ? (JSON.parse(response.body).data?.id ?? null) : null };
}

export function permissionWriteOps(data) {
  const token = __ENV.TEST_TOKEN;
  const roleId = data?.roleId;
  if (!(token && roleId)) {
    sleep(1);
    return;
  }

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.
  const headers = authHeaders(token).headers;

  const rolesResponse = http.get(`${API_PREFIX}/tenancy/organization/roles`, {
    headers,
    tags: { name: 'list-roles' },
  });
  checkOk(rolesResponse, 'list-roles');
  checkResponseTime(rolesResponse, 500, 'list-roles');

  const permissionsResponse = http.get(
    `${API_PREFIX}/tenancy/organization/roles/${roleId}/permissions`,
    { headers, tags: { name: 'get-role-permissions' } },
  );
  checkOk(permissionsResponse, 'get-role-permissions');
  checkResponseTime(permissionsResponse, 500, 'get-role-permissions');

  sleep(0.3);

  const putResponse = http.put(
    `${API_PREFIX}/tenancy/organization/roles/${roleId}/permissions`,
    JSON.stringify({ permission_codes: ['organization:read', 'membership:read'] }),
    { headers, tags: { name: 'put-role-permissions' } },
  );
  checkOk(putResponse, 'put-role-permissions');
  checkResponseTime(putResponse, 700, 'put-role-permissions');

  sleep(1);
}

export function teardown(data) {
  const token = __ENV.TEST_TOKEN;
  if (!(token && data?.roleId)) {
    return;
  }
  http.del(`${API_PREFIX}/tenancy/organization/roles/${data.roleId}`, null, {
    ...authHeaders(token),
    tags: { name: 'delete-target-role' },
  });
}

export default permissionWriteOps;
