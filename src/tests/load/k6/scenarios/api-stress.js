import http from 'k6/http';
import { check } from 'k6';
import { API_PREFIX, SCENARIOS } from '../helpers/config.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: API stress — key authenticated routes under high concurrency.
 *
 * Ramps to 20 → 50 → 100 VUs. Use for full-confidence load testing of the API.
 * Requires: TEST_TOKEN (required). TEST_TOKEN must be minted already scoped to
 * TEST_ORG_ID — the active organization rides the token's `org` claim, so the flat
 * memberships route carries no organization path segment (set TEST_ORG_ID to enable it).
 * Get credentials: pnpm tool:load-test-credentials (server + full seed).
 *
 * Routes loaded:
 * - GET /api/v1/users/me
 * - GET /api/v1/users/me/organizations
 * - GET /api/v1/notify/notifications
 * - GET /api/v1/notify/notifications/unread-count
 * - GET /api/v1/tenancy/organization/memberships
 */
export const options = {
  scenarios: {
    api_stress: {
      ...SCENARIOS.stress,
      exec: 'apiStress',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_reqs: ['rate>5'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:users-me}': ['p(95)<500'],
    'http_req_duration{name:my-organizations}': ['p(95)<500'],
    'http_req_duration{name:notify-notifications}': ['p(95)<500'],
    'http_req_duration{name:notify-unread-count}': ['p(95)<500'],
    'http_req_duration{name:tenancy-memberships}': ['p(95)<500'],
  },
};

export function apiStress() {
  const token = __ENV.TEST_TOKEN;
  const organizationId = __ENV.TEST_ORG_ID || '';

  if (!token) {
    return;
  }

  const opts = (name) => ({ ...authHeaders(token), tags: { name } });

  const meRes = http.get(`${API_PREFIX}/users/me`, opts('users-me'));
  check(meRes, {
    'users/me 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  const orgsRes = http.get(`${API_PREFIX}/users/me/organizations`, opts('my-organizations'));
  check(orgsRes, {
    'users/me/organizations 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  const notifRes = http.get(`${API_PREFIX}/notify/notifications`, opts('notify-notifications'));
  check(notifRes, {
    'notify/notifications 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  const unreadRes = http.get(
    `${API_PREFIX}/notify/notifications/unread-count`,
    opts('notify-unread-count'),
  );
  check(unreadRes, {
    'notify/unread-count 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  if (organizationId) {
    const membersRes = http.get(
      `${API_PREFIX}/tenancy/organization/memberships`,
      opts('tenancy-memberships'),
    );
    check(membersRes, {
      'tenancy/memberships 2xx or 403': (r) => r.status === 200 || r.status === 403,
    });
  }
}

export default apiStress;
