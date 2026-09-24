import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * k6 Scenario: Daily Operations
 *
 * Simulates typical daily user operations:
 * - Fetch notifications
 * - List organization members
 * - Check unread notification count
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'dailyOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:list-notifications}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:unread-count}': ['p(95)<200', 'p(99)<400'],
    'http_req_duration{name:list-members}': ['p(95)<500', 'p(99)<1000'],
  },
};

export function dailyOps() {
  const token = __ENV.TEST_TOKEN;
  if (!token) {
    console.error('TEST_TOKEN env var required');
    return;
  }

  // TEST_TOKEN must be minted scoped to TEST_ORG_ID — the active organization rides the
  // token's `org` claim, so the flat memberships route carries no organization path segment.
  const headers = authHeaders(token).headers;

  // Notifications
  const notifResponse = http.get(`${API_PREFIX}/notify/notifications`, {
    headers,
    tags: { name: 'list-notifications' },
  });
  checkOk(notifResponse, 'list-notifications');
  checkResponseTime(notifResponse, 500, 'list-notifications');

  sleep(0.3);

  // Unread count
  const unreadResponse = http.get(`${API_PREFIX}/notify/notifications/unread-count`, {
    headers,
    tags: { name: 'unread-count' },
  });
  checkOk(unreadResponse, 'unread-count');
  checkResponseTime(unreadResponse, 200, 'unread-count');

  // Mark the newest notification read — idempotent, so repeating it leaves the data as it was.
  const notifications =
    notifResponse.status === 200 ? (JSON.parse(notifResponse.body).data ?? []) : [];
  if (notifications[0]?.id) {
    const readResponse = http.patch(
      `${API_PREFIX}/notify/notifications/${notifications[0].id}/read`,
      JSON.stringify({}),
      { headers, tags: { name: 'mark-notification-read' } },
    );
    checkOk(readResponse, 'mark-notification-read');
  }

  // The organization's audit log, as a member with audit-log:read opens it.
  const auditResponse = http.get(`${API_PREFIX}/tenancy/organization/audit-logs`, {
    headers,
    tags: { name: 'list-organization-audit-logs' },
  });
  checkOk(auditResponse, 'list-organization-audit-logs');

  sleep(0.3);

  // Organization memberships
  const membersResponse = http.get(`${API_PREFIX}/tenancy/organization/memberships`, {
    headers,
    tags: { name: 'list-members' },
  });
  // May get 403 if no permission — that's expected in load test
  checkResponseTime(membersResponse, 500, 'list-members');

  sleep(1);
}

export default dailyOps;
