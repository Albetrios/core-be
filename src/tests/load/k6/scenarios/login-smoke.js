import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, SCENARIOS, SMOKE_THRESHOLDS } from '../helpers/config.js';
import { checkStatus, checkResponseTime } from '../helpers/checks.js';

/**
 * k6 Scenario: Login + GET /users/me
 *
 * Minimal auth smoke for throughput checks. Set credentials via env:
 * `DEMO_EMAIL`, `DEMO_PASSWORD`, optional `BASE_URL`.
 */
export const options = {
  scenarios: {
    smoke: { ...SCENARIOS.smoke, exec: 'loginSmoke' },
  },
  thresholds: {
    ...SMOKE_THRESHOLDS,
    'http_req_duration{name:login-smoke-login}': ['p(95)<800', 'p(99)<1200'],
    'http_req_duration{name:login-smoke-me}': ['p(95)<500', 'p(99)<1000'],
  },
};

export function loginSmoke() {
  const email = __ENV.DEMO_EMAIL || 'demo@example.com';
  const password = __ENV.DEMO_PASSWORD || 'DemoPassword123!';

  const loginResponse = http.post(`${API_PREFIX}/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'login-smoke-login' },
  });
  checkStatus(loginResponse, 200, 'login');
  checkResponseTime(loginResponse, 800, 'login');

  if (loginResponse.status !== 200) {
    sleep(1);
    return;
  }

  const body = JSON.parse(loginResponse.body);
  const token = body.data?.access_token || body.data?.token;
  if (!token) {
    sleep(1);
    return;
  }

  const meResponse = http.get(`${API_PREFIX}/users/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    tags: { name: 'login-smoke-me' },
  });
  checkStatus(meResponse, 200, 'users-me');
  checkResponseTime(meResponse, 500, 'users-me');

  // Log out, so repeated logins leave no sessions behind: past MAX_ACTIVE_SESSIONS_PER_USER (30),
  // every login revokes the user's oldest session — the shared TEST_TOKEN's included, which
  // failed every scenario that ran after this one.
  const logoutResponse = http.post(`${API_PREFIX}/auth/logout`, null, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: 'login-smoke-logout' },
  });
  checkStatus(logoutResponse, 200, 'logout');

  sleep(0.5);
}

export default loginSmoke;
