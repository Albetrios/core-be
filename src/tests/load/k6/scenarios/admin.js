import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: Admin Operations
 *
 * Simulates admin user operations:
 * - List users (admin)
 * - List audit logs (admin)
 * - List permissions
 */
export const options = {
  scenarios: {
    smoke: { ...SCENARIOS.smoke, exec: 'adminOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-users}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:list-audit-logs}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:list-permissions}': ['p(95)<200', 'p(99)<400'],
  },
};

export function adminOps() {
  const token = __ENV.ADMIN_TOKEN;
  if (!token) {
    console.error('ADMIN_TOKEN env var required');
    return;
  }

  const headers = authHeaders(token).headers;

  // List users
  const usersResponse = http.get(`${API_PREFIX}/users/`, {
    headers,
    tags: { name: 'list-users' },
  });
  checkOk(usersResponse, 'list-users');
  checkResponseTime(usersResponse, 500, 'list-users');

  sleep(0.5);

  // Audit logs
  const auditResponse = http.get(`${API_PREFIX}/audit/logs`, {
    headers,
    tags: { name: 'list-audit-logs' },
  });
  checkOk(auditResponse, 'list-audit-logs');
  checkResponseTime(auditResponse, 500, 'list-audit-logs');

  sleep(0.5);

  // Permission catalog (any signed-in user; it was public once, and this request still sent no token)
  const permResponse = http.get(`${API_PREFIX}/tenancy/permissions`, {
    headers,
    tags: { name: 'list-permissions' },
  });
  checkOk(permResponse, 'list-permissions');
  checkResponseTime(permResponse, 200, 'list-permissions');

  sleep(1);
}

export default adminOps;
