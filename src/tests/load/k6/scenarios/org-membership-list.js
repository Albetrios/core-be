import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'membershipListOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-memberships}': ['p(95)<600', 'p(99)<1200'],
  },
};

export function membershipListOps() {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  if (!(token && organizationPublicId)) return;

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.

  const response = http.get(`${API_PREFIX}/tenancy/organization/memberships`, {
    ...authHeaders(token),
    tags: { name: 'list-memberships' },
  });
  checkOk(response, 'list-memberships');
  checkResponseTime(response, 600, 'list-memberships');

  const memberships = response.status === 200 ? (JSON.parse(response.body).data ?? []) : [];
  const membershipId = memberships[0]?.id;
  if (membershipId) {
    const membershipResponse = http.get(
      `${API_PREFIX}/tenancy/organization/memberships/${membershipId}`,
      { ...authHeaders(token), tags: { name: 'get-membership' } },
    );
    checkOk(membershipResponse, 'get-membership');
    const permissionsResponse = http.get(
      `${API_PREFIX}/tenancy/organization/memberships/${membershipId}/permissions`,
      { ...authHeaders(token), tags: { name: 'list-membership-permissions' } },
    );
    checkOk(permissionsResponse, 'list-membership-permissions');
  }
  sleep(0.5);
}

export default membershipListOps;
