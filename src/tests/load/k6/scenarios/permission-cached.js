import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, SCENARIOS, SMOKE_THRESHOLDS } from '../helpers/config.js';
import { checkStatus, checkResponseTime } from '../helpers/checks.js';

/**
 * Warm permission cache then list organizations repeatedly.
 * Requires TEST_TOKEN and TEST_ORG_ID from tool:load-test-credentials.
 */
export const options = {
  scenarios: {
    permissionCached: { ...SCENARIOS.smoke, exec: 'permissionCachedList' },
  },
  thresholds: {
    ...SMOKE_THRESHOLDS,
    'http_req_duration{name:permission-cached-organizations}': ['p(95)<600', 'p(99)<1200'],
  },
};

export function permissionCachedList() {
  const token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  if (!(token && organizationPublicId)) {
    sleep(1);
    return;
  }

  // TEST_TOKEN arrives already scoped to TEST_ORG_ID (tool:load-test-credentials). Never switch it
  // here: a switch re-binds the shared session to the new token, which revokes TEST_TOKEN for every
  // other VU and every later scenario.

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  http.get(`${API_PREFIX}/users/me/organizations`, {
    headers,
    tags: { name: 'permission-cached-orgs' },
  });

  const response = http.get(`${API_PREFIX}/users/me/organizations`, {
    headers,
    tags: { name: 'permission-cached-orgs' },
  });
  checkStatus(response, 200, 'organizations-list');
  checkResponseTime(response, 600, 'organizations-list');

  sleep(0.3);
}

export default permissionCachedList;
