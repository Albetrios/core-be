/**
 * k6 Scenario: Realistic Per-VU User Journey
 *
 * Every VU authenticates as a DISTINCT user from the credential pool, so
 * 100 VUs = 100 independent user sessions — not 100 copies of the same token.
 *
 * Prerequisites:
 *   pnpm db:seed:loadtest          — seeds 12 organizations × 10 users with full domain data
 *                                    and writes src/tests/load/k6/data/credential-pool.json
 *   RATE_LIMIT_MAX=10000 pnpm dev  — raise the rate limit for load testing
 *
 * Run:
 *   pnpm load:user-journey
 *
 * Domains exercised per iteration (reads + writes):
 *   user      — GET /users/me, GET /users/me/settings, PATCH /users/me/settings,
 *               GET /users/me/notification-preferences
 *   auth      — GET /auth/me/sessions
 *   tenancy   — GET /tenancy/organizations, GET /tenancy/organization,
 *               GET …/organization/settings, PATCH …/organization/settings,
 *               GET …/organization/memberships, GET …/organization/roles,
 *               GET …/organization/api-keys
 *   billing   — GET /billing/plans, GET /billing/subscriptions
 *   notify    — GET /notify/notifications, GET …/unread-count,
 *               POST …/mark-all-read (write),
 *               GET /notify/webhooks,
 *               POST + DELETE one webhook per iteration (write + cleanup)
 *   upload    — POST /uploads (presigned URL request only — no actual S3 upload)
 *
 * Not included (destructive / requires special state):
 *   DELETE /users/me, POST /auth/logout (would break the VU's subsequent iterations),
 *   billing mutations (require live Stripe), MFA/WebAuthn (require device state),
 *   admin-only routes (super_admin role)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { API_PREFIX, SCENARIOS, STRICT_THRESHOLDS } from '../helpers/config.js';
import { checkOk, checkResponseTime } from '../helpers/checks.js';
import { authHeaders, switchToOrganization } from '../helpers/auth.js';
import { credentialPool, mintTokenPool, vuToken } from '../helpers/pool.js';

// ---------------------------------------------------------------------------
// Scenario options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    user_journey: {
      ...SCENARIOS.load,
      exec: 'userJourney',
    },
  },
  thresholds: {
    ...STRICT_THRESHOLDS,
    // Profile reads
    'http_req_duration{name:get-me}': ['p(95)<300', 'p(99)<600'],
    'http_req_duration{name:get-me-settings}': ['p(95)<300', 'p(99)<600'],
    'http_req_duration{name:patch-me-settings}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:get-sessions}': ['p(95)<400', 'p(99)<800'],
    'http_req_duration{name:get-notif-prefs}': ['p(95)<300', 'p(99)<600'],
    // Org reads + writes
    'http_req_duration{name:list-organizations}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:get-organization}': ['p(95)<400', 'p(99)<800'],
    'http_req_duration{name:get-organization-settings}': ['p(95)<400', 'p(99)<800'],
    'http_req_duration{name:patch-organization-settings}': ['p(95)<600', 'p(99)<1200'],
    'http_req_duration{name:list-members}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:list-roles}': ['p(95)<400', 'p(99)<800'],
    'http_req_duration{name:list-api-keys}': ['p(95)<400', 'p(99)<800'],
    // Billing
    'http_req_duration{name:list-plans}': ['p(95)<300', 'p(99)<600'],
    'http_req_duration{name:list-subscriptions}': ['p(95)<500', 'p(99)<1000'],
    // Notifications
    'http_req_duration{name:list-notifications}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:unread-count}': ['p(95)<200', 'p(99)<400'],
    'http_req_duration{name:mark-all-read}': ['p(95)<400', 'p(99)<800'],
    // Webhooks
    'http_req_duration{name:list-webhooks}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{name:create-webhook}': ['p(95)<600', 'p(99)<1200'],
    'http_req_duration{name:delete-webhook}': ['p(95)<400', 'p(99)<800'],
    // Upload
    'http_req_duration{name:request-upload}': ['p(95)<600', 'p(99)<1200'],
  },
};

// ---------------------------------------------------------------------------
// setup() — runs ONCE before any VU starts
// ---------------------------------------------------------------------------

/**
 * Logs in every user in the credential pool (sequentially, once total) and
 * returns the token array that VUs index into. Argon2id is exercised N times
 * total — not N × iterations — so server CPU is not the bottleneck.
 *
 * @returns {Array<{token: string, organizationPublicId: string, userPublicId: string}>}
 */
export function setup() {
  return mintTokenPool(credentialPool);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse `data` from a JSON response, or null on failure. */
function parseData(response) {
  try {
    return JSON.parse(response.body)?.data ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase helpers — keeps each function within Biome's line-count limit
// ---------------------------------------------------------------------------

function phaseProfile(authed) {
  const meRes = http.get(`${API_PREFIX}/users/me`, { headers: authed, tags: { name: 'get-me' } });
  checkOk(meRes, 'get-me');
  checkResponseTime(meRes, 300, 'get-me');
  sleep(0.2);

  const settingsRes = http.get(`${API_PREFIX}/users/me/settings`, {
    headers: authed,
    tags: { name: 'get-me-settings' },
  });
  checkOk(settingsRes, 'get-me-settings');
  checkResponseTime(settingsRes, 300, 'get-me-settings');
  sleep(0.2);

  const sessionsRes = http.get(`${API_PREFIX}/auth/me/sessions`, {
    headers: authed,
    tags: { name: 'get-sessions' },
  });
  checkOk(sessionsRes, 'get-sessions');
  checkResponseTime(sessionsRes, 400, 'get-sessions');
  sleep(0.2);

  const notifPrefsRes = http.get(`${API_PREFIX}/users/me/notification-preferences`, {
    headers: authed,
    tags: { name: 'get-notif-prefs' },
  });
  checkOk(notifPrefsRes, 'get-notif-prefs');
  checkResponseTime(notifPrefsRes, 300, 'get-notif-prefs');
  sleep(0.3);
}

function phaseOrg(authed) {
  const listOrgsRes = http.get(`${API_PREFIX}/tenancy/organizations`, {
    headers: authed,
    tags: { name: 'list-orgs' },
  });
  checkOk(listOrgsRes, 'list-orgs');
  checkResponseTime(listOrgsRes, 500, 'list-orgs');
  sleep(0.2);

  const getOrgRes = http.get(`${API_PREFIX}/tenancy/organization`, {
    headers: authed,
    tags: { name: 'get-org' },
  });
  checkOk(getOrgRes, 'get-org');
  checkResponseTime(getOrgRes, 400, 'get-org');
  sleep(0.2);

  const organizationSettingsRes = http.get(`${API_PREFIX}/tenancy/organization/settings`, {
    headers: authed,
    tags: { name: 'get-organization-settings' },
  });
  checkOk(organizationSettingsRes, 'get-organization-settings');
  checkResponseTime(organizationSettingsRes, 400, 'get-organization-settings');
  sleep(0.2);

  const listMembersRes = http.get(`${API_PREFIX}/tenancy/organization/memberships`, {
    headers: authed,
    tags: { name: 'list-members' },
  });
  checkOk(listMembersRes, 'list-members');
  checkResponseTime(listMembersRes, 500, 'list-members');
  sleep(0.2);

  const listRolesRes = http.get(`${API_PREFIX}/tenancy/organization/roles`, {
    headers: authed,
    tags: { name: 'list-roles' },
  });
  checkOk(listRolesRes, 'list-roles');
  checkResponseTime(listRolesRes, 400, 'list-roles');
  sleep(0.2);

  const listApiKeysRes = http.get(`${API_PREFIX}/tenancy/organization/api-keys`, {
    headers: authed,
    tags: { name: 'list-api-keys' },
  });
  checkOk(listApiKeysRes, 'list-api-keys');
  checkResponseTime(listApiKeysRes, 400, 'list-api-keys');
  sleep(0.3);
}

function phaseBillingAndNotify(authed) {
  const plansRes = http.get(`${API_PREFIX}/billing/plans`, {
    headers: authed,
    tags: { name: 'list-plans' },
  });
  checkOk(plansRes, 'list-plans');
  checkResponseTime(plansRes, 300, 'list-plans');
  sleep(0.2);

  const subsRes = http.get(`${API_PREFIX}/billing/subscriptions`, {
    headers: authed,
    tags: { name: 'list-subscriptions' },
  });
  checkOk(subsRes, 'list-subscriptions');
  checkResponseTime(subsRes, 500, 'list-subscriptions');
  sleep(0.3);

  const notificationsRes = http.get(`${API_PREFIX}/notify/notifications`, {
    headers: authed,
    tags: { name: 'list-notifications' },
  });
  checkOk(notificationsRes, 'list-notifications');
  checkResponseTime(notificationsRes, 500, 'list-notifications');
  sleep(0.2);

  const unreadRes = http.get(`${API_PREFIX}/notify/notifications/unread-count`, {
    headers: authed,
    tags: { name: 'unread-count' },
  });
  checkOk(unreadRes, 'unread-count');
  checkResponseTime(unreadRes, 200, 'unread-count');
  sleep(0.2);

  const markReadRes = http.post(`${API_PREFIX}/notify/notifications/mark-all-read`, null, {
    headers: authed,
    tags: { name: 'mark-all-read' },
  });
  checkOk(markReadRes, 'mark-all-read');
  checkResponseTime(markReadRes, 400, 'mark-all-read');
  sleep(0.3);
}

function phaseWebhooksAndWrites(authed, json) {
  const listWebhooksRes = http.get(`${API_PREFIX}/notify/webhooks`, {
    headers: authed,
    tags: { name: 'list-webhooks' },
  });
  checkOk(listWebhooksRes, 'list-webhooks');
  checkResponseTime(listWebhooksRes, 500, 'list-webhooks');
  sleep(0.2);

  // Create a webhook per VU+iteration then immediately delete it so the DB
  // doesn't accumulate test rows across a long soak run.
  const suffix = `${__VU}-${__ITER}-${randomString(4)}`;
  const createWebhookRes = http.post(
    `${API_PREFIX}/notify/webhooks`,
    JSON.stringify({
      url: `https://httpbin.org/post?k6=${suffix}`,
      events: ['*'],
      description: `k6 journey ${suffix}`,
    }),
    { headers: { ...authed, ...json }, tags: { name: 'create-webhook' } },
  );
  check(createWebhookRes, { 'create-webhook 2xx': (r) => r.status >= 200 && r.status < 300 });
  checkResponseTime(createWebhookRes, 600, 'create-webhook');

  const createdWebhook = parseData(createWebhookRes);
  if (createdWebhook?.id) {
    sleep(0.1);
    const deleteWebhookRes = http.del(`${API_PREFIX}/notify/webhooks/${createdWebhook.id}`, null, {
      headers: authed,
      tags: { name: 'delete-webhook' },
    });
    checkOk(deleteWebhookRes, 'delete-webhook');
    checkResponseTime(deleteWebhookRes, 400, 'delete-webhook');
  }
  sleep(0.3);

  // Upload: request presigned URL only (no actual S3 upload in k6)
  const uploadRes = http.post(
    `${API_PREFIX}/uploads`,
    JSON.stringify({
      file_name: `k6-${randomString(6)}.jpg`,
      content_type: 'image/jpeg',
      purpose: 'avatar',
    }),
    { headers: { ...authed, ...json }, tags: { name: 'request-upload' } },
  );
  check(uploadRes, { 'request-upload 2xx': (r) => r.status >= 200 && r.status < 300 });
  checkResponseTime(uploadRes, 600, 'request-upload');
  sleep(0.3);

  // Patch user settings
  const patchSettingsRes = http.patch(
    `${API_PREFIX}/users/me/settings`,
    JSON.stringify({ marketing_emails_enabled: false }),
    { headers: { ...authed, ...json }, tags: { name: 'patch-me-settings' } },
  );
  checkOk(patchSettingsRes, 'patch-me-settings');
  checkResponseTime(patchSettingsRes, 500, 'patch-me-settings');
  sleep(0.2);

  // Patch organization settings
  const patchOrgSettingsRes = http.patch(
    `${API_PREFIX}/tenancy/organization/settings`,
    JSON.stringify({ is_email_notifications_enabled: true }),
    { headers: { ...authed, ...json }, tags: { name: 'patch-organization-settings' } },
  );
  checkOk(patchOrgSettingsRes, 'patch-organization-settings');
  checkResponseTime(patchOrgSettingsRes, 600, 'patch-organization-settings');
}

// ---------------------------------------------------------------------------
// Main VU function
// ---------------------------------------------------------------------------

/**
 * Per-VU organization-scoped token cache. The active organization rides the token's `org` claim,
 * so we re-mint the pool token scoped to this VU's organization exactly once per VU
 * (not per iteration) — keeping the extra auth cost bounded like setup()'s mint.
 */
let scopedToken = null;

/**
 * One iteration = one realistic authenticated user session spanning all
 * major domains. Each VU uses its own token + organization, so no cross-VU contention.
 *
 * @param {Array<{token: string, organizationPublicId: string, userPublicId: string}>} tokenPool
 */
export function userJourney(tokenPool) {
  const entry = vuToken(tokenPool);
  if (!entry?.token) {
    console.error(`VU ${__VU}: no token in pool — ensure setup() succeeded`);
    return;
  }

  // Scope the token to this VU's organization once — the flat organization-scoped routes carry no
  // organization path segment, so the organization must come from the token's `org` claim.
  if (!scopedToken) {
    scopedToken = switchToOrganization(entry.token, entry.organizationPublicId) || entry.token;
  }
  const authed = authHeaders(scopedToken).headers;
  const json = { 'Content-Type': 'application/json' };

  phaseProfile(authed);
  phaseOrg(authed);
  phaseBillingAndNotify(authed);
  phaseWebhooksAndWrites(authed, json);

  sleep(1);
}

export default userJourney;
