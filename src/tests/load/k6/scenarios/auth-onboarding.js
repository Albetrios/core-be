import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkStatus, checkResponseTime } from '../helpers/checks.js';

/**
 * k6 Scenario: Auth + Onboarding Flow
 *
 * Simulates user login, profile fetch, and organization creation.
 * Tests the complete onboarding user journey.
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'authOnboarding' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:auth-login}': ['p(95)<800', 'p(99)<1200'],
    'http_req_duration{name:auth-users-me}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:auth-list-organizations}': ['p(95)<500', 'p(99)<1000'],
  },
};

export function authOnboarding() {
  const headers = { 'Content-Type': 'application/json' };

  // Step 1: Attempt login
  const loginResponse = http.post(
    `${API_PREFIX}/auth/login`,
    JSON.stringify({
      email: __ENV.DEMO_EMAIL || 'demo@example.com',
      password: __ENV.DEMO_PASSWORD || 'DemoPassword123!',
    }),
    { headers, tags: { name: 'auth-login' } },
  );
  checkOk(loginResponse, 'login');
  checkResponseTime(loginResponse, 800, 'login');

  if (loginResponse.status < 200 || loginResponse.status >= 300) {
    sleep(1);
    return;
  }

  const body = JSON.parse(loginResponse.body);
  const token = body.data?.access_token || body.data?.token;
  if (!token) {
    sleep(1);
    return;
  }

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Step 2: Fetch user profile
  const meResponse = http.get(`${API_PREFIX}/users/me`, {
    headers: authHeaders,
    tags: { name: 'auth-users-me' },
  });
  checkStatus(meResponse, 200, 'get-me');
  checkResponseTime(meResponse, 500, 'get-me');

  sleep(0.5);

  // Step 3: List organizations
  const orgsResponse = http.get(`${API_PREFIX}/tenancy/organizations`, {
    headers: authHeaders,
    tags: { name: 'auth-list-orgs' },
  });
  checkStatus(orgsResponse, 200, 'list-orgs');
  checkResponseTime(orgsResponse, 500, 'list-orgs');

  sleep(1);
}

export default authOnboarding;
