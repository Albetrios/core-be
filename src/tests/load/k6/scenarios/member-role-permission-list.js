import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'memberRolePermissionListOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-role-permissions}': ['p(95)<600', 'p(99)<1200'],
  },
};

/**
 * The permissions list needs a role: TEST_ROLE_ID when given, otherwise the organization's first role,
 * read once for every VU.
 */
export function setup() {
  const token = __ENV.TEST_TOKEN;
  if (__ENV.TEST_ROLE_ID || !token) {
    return { rolePublicId: __ENV.TEST_ROLE_ID || null };
  }
  const response = http.get(`${API_PREFIX}/tenancy/organization/roles`, {
    ...authHeaders(token),
    tags: { name: 'list-roles' },
  });
  const roles = response.status === 200 ? (JSON.parse(response.body).data ?? []) : [];
  return { rolePublicId: roles[0]?.id ?? null };
}

export function memberRolePermissionListOps(data) {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  const rolePublicId = data?.rolePublicId;
  if (!(token && organizationPublicId && rolePublicId)) return;

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.

  const roleResponse = http.get(`${API_PREFIX}/tenancy/organization/roles/${rolePublicId}`, {
    ...authHeaders(token),
    tags: { name: 'get-role' },
  });
  checkOk(roleResponse, 'get-role');

  const response = http.get(
    `${API_PREFIX}/tenancy/organization/roles/${rolePublicId}/permissions`,
    { ...authHeaders(token), tags: { name: 'list-role-permissions' } },
  );
  checkOk(response, 'list-role-permissions');
  checkResponseTime(response, 600, 'list-role-permissions');
  sleep(0.5);
}

export default memberRolePermissionListOps;
