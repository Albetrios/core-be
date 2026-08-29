import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders, switchToOrganization } from '../helpers/auth.js';

export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'memberRolePermissionListOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-role-permissions}': ['p(95)<600', 'p(99)<1200'],
  },
};

export function memberRolePermissionListOps() {
  let token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  const rolePublicId = __ENV.TEST_ROLE_ID;
  if (!(token && organizationPublicId && rolePublicId)) return;

  // The active organization rides the token's `org` claim — scope the token to TEST_ORG_ID
  // so the flat route resolves the right organization.
  token = switchToOrganization(token, organizationPublicId) || token;

  const response = http.get(
    `${API_PREFIX}/tenancy/organization/roles/${rolePublicId}/permissions`,
    { ...authHeaders(token), tags: { name: 'list-role-permissions' } },
  );
  checkOk(response, 'list-role-permissions');
  checkResponseTime(response, 600, 'list-role-permissions');
  sleep(0.5);
}

export default memberRolePermissionListOps;
