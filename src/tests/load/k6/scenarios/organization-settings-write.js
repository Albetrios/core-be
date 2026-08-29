import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders, switchToOrganization } from '../helpers/auth.js';

/**
 * k6 Scenario: Organization settings write path
 *
 * Exercises PATCH organization settings (idempotent toggle).
 */
export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'organizationSettingsWriteOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:patch-organization-settings}': ['p(95)<600', 'p(99)<1200'],
  },
};

export function organizationSettingsWriteOps() {
  let token = __ENV.TEST_TOKEN;
  const organizationPublicId = __ENV.TEST_ORG_ID;
  if (!(token && organizationPublicId)) {
    return;
  }

  // The active organization rides the token's `org` claim — scope the token to TEST_ORG_ID
  // so the flat route resolves the right organization.
  token = switchToOrganization(token, organizationPublicId) || token;

  const headers = {
    ...authHeaders(token).headers,
    'Content-Type': 'application/json',
  };

  const patchResponse = http.patch(
    `${API_PREFIX}/tenancy/organization/settings`,
    JSON.stringify({ is_email_notifications_enabled: true }),
    {
      headers,
      tags: { name: 'patch-organization-settings' },
    },
  );
  checkOk(patchResponse, 'patch-organization-settings');
  checkResponseTime(patchResponse, 600, 'patch-organization-settings');

  sleep(1);
}

export default organizationSettingsWriteOps;
