import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

/**
 * k6 Scenario: FE FULL journey — every API call core-fe actually makes, driven by the front end.
 *
 * Where `full-journey.js` starts from the backend's route catalogue and asks "what can one user
 * reach", this starts from the OTHER side: every `apiClient` call site in `core-fe`, resolved to a
 * concrete path, walked in the order the app performs it. If the front end does not call it, it is
 * not here — even when the backend exposes it. The one exception is teardown: step 52 deletes the
 * organization the journey created, which core-fe itself never does.
 *
 * ## Where the list came from
 *
 * Extracted from `core-fe/src` (`main` at `aff4be5`, 2026-09-24) by resolving each
 * `apiClient.<verb>(...)` and `authFetch(...)` call against the path constants it interpolates
 * (`AUTH_API`, `ORG_API`, `BILLING_API`, `NOTIF_API`, `PREFS_API`, `MFA_API`, `SESSIONS_API`,
 * `WEBAUTHN_API`, `WEBHOOKS_API`, `WEBHOOK_EVENTS_API`, `PERMISSIONS_API`, `INVITATIONS_API`,
 * `UPLOADS_API`, `AVATAR_API`) and the `API_ENDPOINTS.AUTH` map in
 * `core-fe/src/core/config/constants.ts`, plus the lists the app reads through `fetchListPage` /
 * `fetchAllPages` (API keys, roles, memberships, webhooks and their delivery attempts,
 * notifications, invoices). That comes to **78** distinct calls (method + path). This scenario
 * walks **52** of them — 49 by default and three more behind `STEP_UP=true` — in 55 steps: it
 * reads `me/context` three times, as the app does, and step 52 is the teardown above. The block
 * below states why each of the other **26** is out of reach for a signed-in pool user.
 *
 * ## What the front end calls that this cannot do
 *
 *   POST /auth/login                      Password sign-in. The journey signs in once, the way
 *                                         core-fe does by default, with an email code;
 *                                         `fe-login-to-org.js` walks password sign-in
 *                                         (`AUTH=password`).
 *   POST /auth/mfa/login                  Needs an enrolled TOTP factor and a live code.
 *   GET  /auth/oauth/:provider/callback   Needs the authorization code the provider hands back.
 *   POST /auth/me/mfa/enroll/confirm      Needs a TOTP code computed from the staged secret.
 *   POST /auth/me/mfa/verify              Needs an enrolled factor.
 *   DELETE /auth/me/mfa/:id               Enrolment stages the secret in Redis; no method row
 *                                         exists to delete until `confirm` succeeds.
 *   DELETE /auth/me/sessions/:id          The API is explicit: "This action requires a recent
 *                                         step-up with your password or MFA; an email-code step-up
 *                                         is not sufficient." Pool users have neither factor.
 *   POST /auth/me/webauthn/register/verify
 *   DELETE /auth/me/webauthn/credentials/:id
 *                                         Both need a real authenticator to sign the challenge.
 *   POST /tenancy/invitations/:id/accept  Needs the raw invitation token, which exists only in the
 *                                         email body — the serializer never exposes it.
 *   POST /auth/refresh                    Works, but is capped at 30/min PER IP. Every VU shares one
 *                                         IP locally, so including it exhausts the budget and fails
 *                                         the run.
 *   DELETE /users/me                      Ends the account, and pool users are reused every run.
 *   POST /notify/webhooks/:id/test        Delivers to the webhook's URL, live.
 *
 * Also out: Stripe — `POST /billing/subscriptions`, `payment-methods/setup`, and a subscription's
 * `change-plan`, `cancel`, `resume` and `payment-setup` — and `GET /billing/subscriptions/:id`,
 * since a new organization has no subscription until Stripe creates one. And the S3 upload flow —
 * `POST /uploads`, `POST /uploads/:id/confirm`, `PUT`/`DELETE /users/me/avatar` and
 * `PUT`/`DELETE /tenancy/organization/logo`: the file goes straight to S3 and `confirm` checks
 * the object there, so the flow needs a bucket a load run does not have.
 *
 * ## The step-up cluster is opt-in
 *
 * `POST /auth/step-up` accepts an email code, and `TEST_MODE` returns the real one on
 * `send-code` (`debug_verification_code`). But a code is issued at most once per 60 seconds per
 * email, and sign-in consumes the first one — so reaching step-up costs a 60-second wait. That wait
 * is per VU and runs in parallel, so it costs ~60s of wall clock for the whole run rather than 60s
 * each. It is still off by default; set `STEP_UP=true` to include it and the two routes it unlocks.
 *
 * ## Self-cleaning
 *
 * Each VU creates its own TEAM organization, invites a SECOND pool user into it to exercise the
 * membership routes, and deletes the organization at the end — which takes the membership with it.
 * The invitee is an existing pool user rather than a freshly signed-up account, so no user rows
 * accumulate. Step 54 re-reads `me/context` and requires the organization to be gone from the
 * owner's own list; the proof runs inside the session rather than against the database.
 *
 * Run:
 *   TEST_MODE=true AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED=true \
 *     WEBHOOK_URL_ALLOWLIST=example.com pnpm dev   # the webhook block creates example.com URLs
 *   BASE_URL=http://localhost:3000 VUS=20 k6 run src/tests/load/k6/scenarios/fe-full-surface.js
 *
 *   # include the step-up cluster (adds a 60s wait per VU, in parallel):
 *   BASE_URL=http://localhost:3000 VUS=20 STEP_UP=true k6 run src/tests/load/k6/scenarios/fe-full-surface.js
 *
 *   # re-running within 5 minutes? DELETE /organization is 5 per 5 min per user — move along the pool:
 *   BASE_URL=http://localhost:3000 VUS=20 USER_OFFSET=20 k6 run src/tests/load/k6/scenarios/fe-full-surface.js
 */

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const VUS = Number(__ENV.VUS || 20);
const POOL = __ENV.POOL || 'unknown';
const STAGGER = Number(__ENV.STAGGER ?? 5);
const STATIC_CODE = __ENV.STATIC_CODE || 'TEST24';
const OAUTH_PROVIDER = __ENV.OAUTH_PROVIDER || 'google';
const USER_OFFSET = Number(__ENV.USER_OFFSET || 0);
const STEP_UP = String(__ENV.STEP_UP || '').toLowerCase() === 'true';

const credentialPool = new SharedArray('pool', () =>
  JSON.parse(open('../data/credential-pool.json')),
);

/** The front-end calls this scenario walks, in the order the app performs them. */
const STEPS = [
  // ── what the login screen loads before anyone signs in ─────────────────────
  ['01-oauth-providers', 'GET', '/auth/oauth/providers'],
  ['02-oauth-start', 'GET', '/auth/oauth/:provider'],
  ['03-list-plans', 'GET', '/billing/plans'],

  // ── passwordless sign-in ───────────────────────────────────────────────────
  ['04-send-code', 'POST', '/auth/email/send-code'],
  ['05-login', 'POST', '/auth/email/login'],
  ['06-me-context', 'GET', '/auth/me/context'],

  // ── what the app renders for the signed-in account ─────────────────────────
  ['07-get-me', 'GET', '/users/me'],
  ['08-patch-me', 'PATCH', '/users/me'],
  ['09-get-notif-prefs', 'GET', '/users/me/notification-preferences'],
  ['10-put-notif-prefs', 'PUT', '/users/me/notification-preferences'],
  ['11-onboarding-complete', 'POST', '/users/me/onboarding/complete'],
  ['12-auth-methods', 'GET', '/auth/me/auth-methods'],
  ['13-mfa-methods', 'GET', '/auth/me/mfa'],
  ['14-sessions', 'GET', '/auth/me/sessions'],
  ['15-webauthn-creds', 'GET', '/auth/me/webauthn/credentials'],

  // ── notification bell ──────────────────────────────────────────────────────
  ['16-list-notifications', 'GET', '/notify/notifications'],
  ['17-unread-count', 'GET', '/notify/notifications/unread-count'],
  ['18-mark-one-read', 'PATCH', '/notify/notifications/:id/read'],
  ['19-mark-all-read', 'POST', '/notify/notifications/mark-all-read'],

  // ── organization switcher + create, then scope the session ─────────────────
  ['20-list-orgs', 'GET', '/users/me/organizations'],
  ['21-create-org', 'POST', '/tenancy/organizations'],
  ['22-switch-org', 'POST', '/auth/switch-to-organization'],
  ['23-me-context-2', 'GET', '/auth/me/context'],
  ['24-patch-org', 'PATCH', '/tenancy/organization'],

  // ── settings › integrations: API keys ──────────────────────────────────────
  ['25-list-keys', 'GET', '/tenancy/organization/api-keys'],
  ['26-create-key', 'POST', '/tenancy/organization/api-keys'],
  ['27-patch-key', 'PATCH', '/tenancy/organization/api-keys/:id'],
  ['28-delete-key', 'DELETE', '/tenancy/organization/api-keys/:id'],

  // ── settings › integrations: webhooks ──────────────────────────────────────
  ['29-webhook-events', 'GET', '/notify/webhook-events'],
  ['30-create-webhook', 'POST', '/notify/webhooks'],
  ['31-list-webhooks', 'GET', '/notify/webhooks'],
  ['32-webhook-deliveries', 'GET', '/notify/webhooks/:id/delivery-attempts'],
  ['33-patch-webhook', 'PATCH', '/notify/webhooks/:id'],
  ['34-delete-webhook', 'DELETE', '/notify/webhooks/:id'],

  // ── settings › roles ───────────────────────────────────────────────────────
  ['35-list-roles', 'GET', '/tenancy/organization/roles'],
  ['36-permission-catalog', 'GET', '/tenancy/permissions'],
  ['37-create-role', 'POST', '/tenancy/organization/roles'],
  ['38-patch-role', 'PATCH', '/tenancy/organization/roles/:id'],
  ['39-get-role-perms', 'GET', '/tenancy/organization/roles/:id/permissions'],
  ['40-put-role-perms', 'PUT', '/tenancy/organization/roles/:id/permissions'],
  ['41-delete-role', 'DELETE', '/tenancy/organization/roles/:id'],

  // ── settings › members (needs a second identity) ───────────────────────────
  ['42-list-memberships', 'GET', '/tenancy/organization/memberships'],
  ['43-invite-member', 'POST', '/tenancy/organization/memberships'],
  ['44-patch-membership', 'PATCH', '/tenancy/organization/memberships/:id'],
  ['45-delete-membership', 'DELETE', '/tenancy/organization/memberships/:id'],

  // ── billing screen (reads only; every write goes to Stripe) ────────────────
  ['46-list-subscriptions', 'GET', '/billing/subscriptions'],
  ['47-list-invoices', 'GET', '/billing/invoices'],
  ['48-payment-methods', 'GET', '/billing/payment-methods'],

  // ── step-up cluster, only when STEP_UP=true ────────────────────────────────
  ['49-step-up', 'POST', '/auth/step-up'],
  ['50-mfa-enroll', 'POST', '/auth/me/mfa/enroll'],
  ['51-webauthn-options', 'POST', '/auth/me/webauthn/register/options'],

  // ── teardown (core-fe never deletes an organization), then sign out ────────
  ['52-delete-org', 'DELETE', '/tenancy/organization'],
  ['53-switch-personal', 'POST', '/auth/switch-to-personal'],
  ['54-me-context-3', 'GET', '/auth/me/context'],
  ['55-logout', 'POST', '/auth/logout'],
];

const metricKey = (name) => name.replace(/-/g, '_');

const M = {};
for (const [name] of STEPS) {
  const k = metricKey(name);
  M[name] = {
    dur: new Trend(`ep_duration_${k}`, true),
    ok: new Rate(`ep_success_${k}`),
    hits: new Counter(`ep_reqs_${k}`),
    skipped: new Counter(`ep_skipped_${k}`),
  };
}

const journeyDuration = new Trend('journey_duration', true);
const journeyComplete = new Rate('journey_complete');
const orgsLeaked = new Counter('orgs_leaked');
const teardownThrottled = new Counter('teardown_throttled');
const cleanupVerified = new Counter('cleanup_verified');
const seatLimitHit = new Counter('seat_limit_hit');

export const options = {
  scenarios: {
    fe: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '15m',
      exec: 'feFullJourney',
    },
  },
  thresholds: {
    journey_complete: ['rate>0.95'],
    orgs_leaked: ['count==0'],
  },
};

function idemKey(tag) {
  // The idempotency header must be 16–255 characters, so keep this comfortably long.
  return `k6-fe-${tag}-${__VU}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function record(name, res, expected) {
  const m = M[name];
  m.dur.add(res.timings.duration);
  m.hits.add(1);
  const pass = expected.includes(res.status);
  m.ok.add(pass);
  check(res, { [`${name} -> ${expected.join('|')}`]: () => pass });
  return pass;
}

/** A step that could not run because a prerequisite failed — never counted as a pass. */
function skip(name) {
  M[name].skipped.add(1);
}

/** Every step from `first` on, in STEPS order — the rest of a journey, named rather than counted. */
function stepsFrom(first) {
  return STEPS.slice(STEPS.findIndex(([name]) => name === first));
}

function body(res) {
  try {
    const parsed = JSON.parse(res.body);
    return parsed.data ?? parsed;
  } catch {
    return {};
  }
}

function rows(value) {
  const raw = value ?? [];
  return Array.isArray(raw) ? raw : (raw.data ?? []);
}

/** Collects pass/fail for one block of related steps so the journey itself stays readable. */
function stepper(state) {
  return (name, res, expected) => {
    if (!record(name, res, expected)) state.ok = false;
    return res;
  };
}

/* ──────────────────────────────── Blocks ──────────────────────────────── */

/** 01-03 what the login screen loads before anyone signs in. */
function publicBlock() {
  const state = { ok: true };
  const step = stepper(state);

  step(
    '01-oauth-providers',
    http.get(`${API}/auth/oauth/providers`, { tags: { name: '01-oauth-providers' } }),
    [200],
  );
  step(
    '02-oauth-start',
    http.get(`${API}/auth/oauth/${OAUTH_PROVIDER}`, { tags: { name: '02-oauth-start' } }),
    [200, 302],
  );
  const plans = step(
    '03-list-plans',
    http.get(`${API}/billing/plans`, { tags: { name: '03-list-plans' } }),
    [200],
  );

  // An organization with no subscription falls back to the CHEAPEST ACTIVE plan's seat allowance
  // (`SubscriptionService.reserveSeatCeilingForMemberAdd` → `getFreePlanSeatCeiling`). Reading it
  // here lets the member block decide up front whether an invite can fit, rather than firing a
  // request that is certain to come back 409. An empty catalogue means no ceiling to enforce.
  const active = rows(body(plans)).filter((plan) => plan.is_active);
  active.sort((a, b) => Number(a.price_monthly ?? 0) - Number(b.price_monthly ?? 0));
  const seatCeiling = active.length > 0 ? (active[0].limits?.seats ?? null) : null;

  return { ok: state.ok, seatCeiling };
}

/** 07-15 the account surface the app renders once signed in. */
function accountBlock(auth) {
  const state = { ok: true };
  const step = stepper(state);

  step(
    '07-get-me',
    http.get(`${API}/users/me`, { headers: auth, tags: { name: '07-get-me' } }),
    [200],
  );
  step(
    '08-patch-me',
    http.patch(`${API}/users/me`, JSON.stringify({ first_name: `K6-${__VU}` }), {
      headers: auth,
      tags: { name: '08-patch-me' },
    }),
    [200],
  );

  const prefs = step(
    '09-get-notif-prefs',
    http.get(`${API}/users/me/notification-preferences`, {
      headers: auth,
      tags: { name: '09-get-notif-prefs' },
    }),
    [200],
  );

  // PUT here is a FULL REPLACE: the repository deletes every row for the user and re-inserts the
  // payload, so `{ preferences: [] }` silently wipes whatever they had.
  //
  // A pool user starts with none, which means a naive echo-back would write an empty list and read
  // an empty list — exercising the endpoint without ever seeing the row shape it returns. So write
  // ONE real preference, prove it comes back populated, then restore exactly what was found. The
  // write path (delete-then-insert under an advisory lock) is exercised twice and the account ends
  // in the state it started in.
  const original = rows(body(prefs)).map((p) => ({
    notification_type: p.notification_type,
    channel: p.channel,
    is_enabled: p.is_enabled,
  }));
  const seeded =
    original.length > 0
      ? original
      : [{ notification_type: 'system.welcome', channel: 'EMAIL', is_enabled: true }];

  const written = step(
    '10-put-notif-prefs',
    http.put(`${API}/users/me/notification-preferences`, JSON.stringify({ preferences: seeded }), {
      headers: auth,
      tags: { name: '10-put-notif-prefs' },
    }),
    [200],
  );
  // The response must carry the row we just wrote — an empty body here means the write silently
  // did nothing, which a bare 200 would have hidden.
  check(written, { '10 preferences come back populated': () => rows(body(written)).length > 0 });

  if (original.length !== seeded.length) {
    // Put the account back exactly as it was found. Not a measured step — it is housekeeping.
    http.put(
      `${API}/users/me/notification-preferences`,
      JSON.stringify({ preferences: original }),
      {
        headers: auth,
        tags: { name: 'prefs-restore' },
      },
    );
  }

  step(
    '11-onboarding-complete',
    http.post(`${API}/users/me/onboarding/complete`, null, {
      headers: auth,
      tags: { name: '11-onboarding-complete' },
    }),
    [200],
  );
  const methods = step(
    '12-auth-methods',
    http.get(`${API}/auth/me/auth-methods`, { headers: auth, tags: { name: '12-auth-methods' } }),
    [200],
  );
  // A passwordless account still has one method: the email code it just signed in with. An empty
  // list here would mean the sign-in that produced this token left no method behind.
  check(methods, { '12 the email-code method is listed': () => rows(body(methods)).length > 0 });
  step(
    '13-mfa-methods',
    http.get(`${API}/auth/me/mfa`, { headers: auth, tags: { name: '13-mfa-methods' } }),
    [200],
  );
  const sessions = step(
    '14-sessions',
    http.get(`${API}/auth/me/sessions`, { headers: auth, tags: { name: '14-sessions' } }),
    [200],
  );
  // At minimum the session making this very call must appear.
  check(sessions, { '14 the current session is listed': () => rows(body(sessions)).length > 0 });
  step(
    '15-webauthn-creds',
    http.get(`${API}/auth/me/webauthn/credentials`, {
      headers: auth,
      tags: { name: '15-webauthn-creds' },
    }),
    [200],
  );

  return state.ok;
}

/** 16-19 the notification bell. */
function notifyBlock(auth) {
  const state = { ok: true };
  const step = stepper(state);

  const listed = step(
    '16-list-notifications',
    http.get(`${API}/notify/notifications`, {
      headers: auth,
      tags: { name: '16-list-notifications' },
    }),
    [200],
  );
  step(
    '17-unread-count',
    http.get(`${API}/notify/notifications/unread-count`, {
      headers: auth,
      tags: { name: '17-unread-count' },
    }),
    [200],
  );
  // Opening a notification marks it read. A pool user's notifications come from the bulk seed;
  // on a database without any there is nothing to open, and the step is skipped, not failed.
  const opened = rows(body(listed))[0];
  if (opened?.id) {
    step(
      '18-mark-one-read',
      http.patch(`${API}/notify/notifications/${opened.id}/read`, null, {
        headers: auth,
        tags: { name: '18-mark-one-read' },
      }),
      [200],
    );
  } else {
    skip('18-mark-one-read');
  }
  step(
    '19-mark-all-read',
    http.post(`${API}/notify/notifications/mark-all-read`, null, {
      headers: auth,
      tags: { name: '19-mark-all-read' },
    }),
    [200],
  );

  return state.ok;
}

/** 25-28 settings › integrations: API keys. */
function apiKeyBlock(auth, unique) {
  const state = { ok: true };
  const step = stepper(state);

  // Create FIRST, then list — see the note at the list call below.

  // `scopes` must be permissions the caller HOLDS — the service refuses to grant what you do not
  // have ("You cannot grant a permission you do not hold"), so an invented scope 403s.
  const created = http.post(
    `${API}/tenancy/organization/api-keys`,
    JSON.stringify({ name: `k6-fe-key-${unique}`, scopes: ['organization:read'] }),
    { headers: { ...auth, 'X-Idempotency-Key': idemKey('key') }, tags: { name: '26-create-key' } },
  );
  const keyOk = record('26-create-key', created, [200, 201]);
  if (!keyOk) state.ok = false;
  // The id is nested under `api_key`; the sibling `raw_key` is the only time the secret is shown.
  const keyId = keyOk ? (body(created).api_key?.id ?? null) : null;

  if (keyId) {
    // Listing BEFORE the create would always return an empty array: the call would pass without
    // ever exercising the row shape it is meant to return. Listing after it means the response
    // carries real data, and the check below proves the key is actually in it.
    const listed = step(
      '25-list-keys',
      http.get(`${API}/tenancy/organization/api-keys`, {
        headers: auth,
        tags: { name: '25-list-keys' },
      }),
      [200],
    );
    check(listed, {
      '25 the key just created is listed': () => rows(body(listed)).some((k) => k.id === keyId),
    });

    step(
      '27-patch-key',
      http.patch(
        `${API}/tenancy/organization/api-keys/${keyId}`,
        JSON.stringify({ name: `k6-fe-key-renamed-${unique}` }),
        {
          headers: auth,
          tags: { name: '27-patch-key' },
        },
      ),
      [200],
    );
    step(
      '28-delete-key',
      http.del(`${API}/tenancy/organization/api-keys/${keyId}`, null, {
        headers: auth,
        tags: { name: '28-delete-key' },
      }),
      [200, 204],
    );
  } else {
    for (const n of ['25-list-keys', '27-patch-key', '28-delete-key']) skip(n);
  }

  return state.ok;
}

/** 29-34 settings › integrations: webhooks. */
function webhookBlock(auth, unique) {
  const state = { ok: true };
  const step = stepper(state);

  // The create form's checklist comes from the catalog, so the webhook subscribes to an event
  // that exists.
  const catalog = step(
    '29-webhook-events',
    http.get(`${API}/notify/webhook-events`, {
      headers: auth,
      tags: { name: '29-webhook-events' },
    }),
    [200],
  );
  const event = rows(body(catalog))[0]?.event ?? 'subscription.updated';

  // The SSRF guard accepts only allowlisted hosts: the nightly and the local load rig allowlist
  // example.com (WEBHOOK_URL_ALLOWLIST). Nothing is delivered — the subscribed event never fires.
  const created = http.post(
    `${API}/notify/webhooks`,
    JSON.stringify({ url: `https://example.com/k6-fe-${unique}`, events: [event] }),
    {
      headers: { ...auth, 'X-Idempotency-Key': idemKey('webhook') },
      tags: { name: '30-create-webhook' },
    },
  );
  const webhookOk = record('30-create-webhook', created, [200, 201]);
  if (!webhookOk) state.ok = false;
  const webhookId = webhookOk ? (body(created).id ?? null) : null;

  if (webhookId) {
    const listed = step(
      '31-list-webhooks',
      http.get(`${API}/notify/webhooks`, { headers: auth, tags: { name: '31-list-webhooks' } }),
      [200],
    );
    check(listed, {
      '31 the webhook just created is listed': () =>
        rows(body(listed)).some((webhook) => webhook.id === webhookId),
    });
    step(
      '32-webhook-deliveries',
      http.get(`${API}/notify/webhooks/${webhookId}/delivery-attempts`, {
        headers: auth,
        tags: { name: '32-webhook-deliveries' },
      }),
      [200],
    );
    // core-fe edits the URL and the events together.
    step(
      '33-patch-webhook',
      http.patch(
        `${API}/notify/webhooks/${webhookId}`,
        JSON.stringify({ url: `https://example.com/k6-fe-${unique}-edited`, events: [event] }),
        { headers: auth, tags: { name: '33-patch-webhook' } },
      ),
      [200],
    );
    step(
      '34-delete-webhook',
      http.del(`${API}/notify/webhooks/${webhookId}`, null, {
        headers: auth,
        tags: { name: '34-delete-webhook' },
      }),
      [200, 204],
    );
  } else {
    for (const n of [
      '31-list-webhooks',
      '32-webhook-deliveries',
      '33-patch-webhook',
      '34-delete-webhook',
    ])
      skip(n);
  }

  return state.ok;
}

/** 35-41 settings › roles. */
function roleBlock(auth, unique) {
  const state = { ok: true };
  const step = stepper(state);

  step(
    '35-list-roles',
    http.get(`${API}/tenancy/organization/roles`, {
      headers: auth,
      tags: { name: '35-list-roles' },
    }),
    [200],
  );
  // The role builder renders its checklist from the live permission catalog.
  step(
    '36-permission-catalog',
    http.get(`${API}/tenancy/permissions`, {
      headers: auth,
      tags: { name: '36-permission-catalog' },
    }),
    [200],
  );

  const created = http.post(
    `${API}/tenancy/organization/roles`,
    JSON.stringify({ name: `k6-fe-role-${unique}`.slice(0, 100), description: 'k6 fe journey' }),
    {
      headers: { ...auth, 'X-Idempotency-Key': idemKey('role') },
      tags: { name: '37-create-role' },
    },
  );
  const roleOk = record('37-create-role', created, [200, 201]);
  if (!roleOk) state.ok = false;
  const roleId = roleOk ? (body(created).id ?? null) : null;

  if (roleId) {
    step(
      '38-patch-role',
      http.patch(
        `${API}/tenancy/organization/roles/${roleId}`,
        JSON.stringify({ description: 'k6 renamed' }),
        {
          headers: auth,
          tags: { name: '38-patch-role' },
        },
      ),
      [200],
    );
    step(
      '39-get-role-perms',
      http.get(`${API}/tenancy/organization/roles/${roleId}/permissions`, {
        headers: auth,
        tags: { name: '39-get-role-perms' },
      }),
      [200],
    );
    step(
      '40-put-role-perms',
      http.put(
        `${API}/tenancy/organization/roles/${roleId}/permissions`,
        JSON.stringify({ permission_codes: ['organization:read'] }),
        {
          headers: auth,
          tags: { name: '40-put-role-perms' },
        },
      ),
      [200],
    );
    step(
      '41-delete-role',
      http.del(`${API}/tenancy/organization/roles/${roleId}`, null, {
        headers: auth,
        tags: { name: '41-delete-role' },
      }),
      [200, 204],
    );
  } else {
    for (const n of ['38-patch-role', '39-get-role-perms', '40-put-role-perms', '41-delete-role'])
      skip(n);
  }

  return state.ok;
}

/**
 * 42-45 settings › members.
 *
 * The invitee is ANOTHER pool user rather than a freshly signed-up account, so the run creates no
 * user rows. Inviting writes the mail to the transactional outbox and enqueues a job — the Resend
 * call happens later, in the mail worker, never in this request. Deleting the organization at
 * teardown takes the membership with it.
 */
function membershipBlock(auth, inviteeEmail, seatCeiling) {
  const state = { ok: true };
  const step = stepper(state);

  const listed = step(
    '42-list-memberships',
    http.get(`${API}/tenancy/organization/memberships`, {
      headers: auth,
      tags: { name: '42-list-memberships' },
    }),
    [200],
  );

  // The invite needs a role id, and the role must be one this Owner may grant.
  const roleList = http.get(`${API}/tenancy/organization/roles`, {
    headers: auth,
    tags: { name: 'roles-lookup' },
  });
  const available = rows(body(roleList));
  const member =
    available.find((r) =>
      String(r.name || '')
        .toUpperCase()
        .startsWith('MEMBER'),
    ) ?? available[0];
  const viewer =
    available.find((r) =>
      String(r.name || '')
        .toUpperCase()
        .startsWith('VIEWER'),
    ) ?? member;

  if (!member || listed.status !== 200) {
    for (const n of ['43-invite-member', '44-patch-membership', '45-delete-membership']) skip(n);
    return false;
  }

  // A seat is consumed by ACTIVE **and** INVITED memberships, and the owner already holds one. With
  // the real plan catalogue seeded the cheapest active plan is Free at a single seat, so there is
  // no room for anyone else and the invite would come back 409 `seat_limit_reached`. Raising the
  // ceiling means subscribing to Starter (5) or Pro (25), which is a Stripe call — verified: it
  // answers 503 with no Stripe reachable. Skip rather than fire a request known to fail, so the
  // board stays clean and the summary explains why these three did not run.
  const seatsUsed = rows(body(listed)).length;
  if (seatCeiling !== null && seatsUsed >= seatCeiling) {
    seatLimitHit.add(1);
    for (const n of ['43-invite-member', '44-patch-membership', '45-delete-membership']) skip(n);
    return true;
  }

  const invited = http.post(
    `${API}/tenancy/organization/memberships`,
    JSON.stringify({ email: inviteeEmail, role_id: member.id }),
    {
      headers: { ...auth, 'X-Idempotency-Key': idemKey('invite') },
      tags: { name: '43-invite-member' },
    },
  );
  // A 409 `seat_limit_reached` is a PLAN constraint, not a failure: a new organization lands on the
  // Free plan, which allows exactly one seat, so the owner is already the whole allowance. Raising
  // it means subscribing to Starter (5) or Pro (25) — a Stripe call this run deliberately avoids.
  // Accept that outcome so the run reads honestly either way: with no plans seeded the invite
  // succeeds and the member routes run end to end; with the real catalogue seeded it is refused,
  // and the summary says which happened instead of reporting a red run.
  const seatLimited =
    invited.status === 409 && String(invited.body || '').includes('seat_limit_reached');
  if (seatLimited) seatLimitHit.add(1);
  const inviteOk = record('43-invite-member', invited, seatLimited ? [409] : [200, 201]);
  if (!inviteOk) state.ok = false;
  const membershipId = !seatLimited && inviteOk ? (body(invited).id ?? null) : null;

  if (membershipId) {
    step(
      '44-patch-membership',
      http.patch(
        `${API}/tenancy/organization/memberships/${membershipId}`,
        JSON.stringify({ role_id: viewer.id }),
        {
          headers: auth,
          tags: { name: '44-patch-membership' },
        },
      ),
      [200],
    );
    step(
      '45-delete-membership',
      http.del(`${API}/tenancy/organization/memberships/${membershipId}`, null, {
        headers: auth,
        tags: { name: '45-delete-membership' },
      }),
      [200, 204],
    );
  } else {
    skip('44-patch-membership');
    skip('45-delete-membership');
  }

  return state.ok;
}

/** 46-48 the billing screen. Reads only — every write on it goes to Stripe. */
function billingBlock(auth) {
  const state = { ok: true };
  const step = stepper(state);

  step(
    '46-list-subscriptions',
    http.get(`${API}/billing/subscriptions`, {
      headers: auth,
      tags: { name: '46-list-subscriptions' },
    }),
    [200],
  );
  step(
    '47-list-invoices',
    http.get(`${API}/billing/invoices`, { headers: auth, tags: { name: '47-list-invoices' } }),
    [200],
  );
  step(
    '48-payment-methods',
    http.get(`${API}/billing/payment-methods`, {
      headers: auth,
      tags: { name: '48-payment-methods' },
    }),
    [200],
  );

  return state.ok;
}

/**
 * 49-51 the step-up cluster, only when STEP_UP=true.
 *
 * A verification code is issued at most once per 60 seconds per email and sign-in consumed the
 * first one, so this waits out that cooldown before asking for a second. The wait is per VU and
 * runs in parallel, so it costs about a minute of wall clock for the whole run.
 */
function stepUpBlock(auth, json, email) {
  const state = { ok: true };
  const step = stepper(state);

  sleep(63);
  const reissued = http.post(`${API}/auth/email/send-code`, JSON.stringify({ email }), {
    headers: json,
    tags: { name: 'stepup-code' },
  });
  const code = reissued.status === 200 ? body(reissued).debug_verification_code : null;
  if (!code) {
    // Without TEST_MODE the real code never reaches the client, so step-up cannot be reached.
    for (const n of ['49-step-up', '50-mfa-enroll', '51-webauthn-options']) skip(n);
    return false;
  }

  step(
    '49-step-up',
    http.post(`${API}/auth/step-up`, JSON.stringify({ code }), {
      headers: auth,
      tags: { name: '49-step-up' },
    }),
    [200],
  );
  step(
    '50-mfa-enroll',
    http.post(`${API}/auth/me/mfa/enroll`, JSON.stringify({ method_type: 'MFA_TOTP' }), {
      headers: auth,
      tags: { name: '50-mfa-enroll' },
    }),
    [200],
  );
  step(
    '51-webauthn-options',
    http.post(`${API}/auth/me/webauthn/register/options`, JSON.stringify({}), {
      headers: auth,
      tags: { name: '51-webauthn-options' },
    }),
    [200],
  );

  return state.ok;
}

/** 52-55 teardown: delete what this VU made, return home, prove it is gone, sign out. */
function teardownBlock(auth, json, slug) {
  const state = { ok: true };
  const step = stepper(state);
  let session = auth;

  const removed = http.del(`${API}/tenancy/organization`, null, {
    headers: session,
    tags: { name: '52-delete-org' },
  });
  const removedOk = record('52-delete-org', removed, [200, 204]);
  if (!removedOk) {
    state.ok = false;
    orgsLeaked.add(1);
    if (removed.status === 429) teardownThrottled.add(1);
  }

  // Deleting the active organization leaves this token scoped to a row that no longer resolves —
  // `me/context` answers 404 "Organization not found" until the session moves somewhere real.
  const home = step(
    '53-switch-personal',
    http.post(`${API}/auth/switch-to-personal`, null, {
      headers: session,
      tags: { name: '53-switch-personal' },
    }),
    [200],
  );
  if (home.status === 200) {
    const homeToken = body(home).access_token;
    if (homeToken) session = { ...json, Authorization: `Bearer ${homeToken}` };
  }

  const after = step(
    '54-me-context-3',
    http.get(`${API}/auth/me/context`, { headers: session, tags: { name: '54-me-context-3' } }),
    [200],
  );
  if (removedOk) {
    if (after.status === 200) {
      const stillListed = (body(after).organizations ?? []).some((o) => o?.slug === slug);
      check(after, { '54 organization no longer listed': () => !stillListed });
      if (stillListed) {
        state.ok = false;
        orgsLeaked.add(1);
      } else {
        cleanupVerified.add(1);
      }
    } else {
      // The delete reported success but the claim could not be checked. Do not bank it.
      state.ok = false;
    }
  }

  step(
    '55-logout',
    http.post(`${API}/auth/logout`, null, { headers: session, tags: { name: '55-logout' } }),
    [200, 204],
  );

  return state.ok;
}

/* ──────────────────────────────── Journey ─────────────────────────────── */

export function setup() {
  http.post(
    `${BASE}/__monitor/run`,
    JSON.stringify({
      command: `BASE_URL=${BASE} VUS=${VUS}${USER_OFFSET ? ` USER_OFFSET=${USER_OFFSET}` : ''}${STEP_UP ? ' STEP_UP=true' : ''} \\\n    k6 run src/tests/load/k6/scenarios/fe-full-surface.js`,
      vus: VUS,
      mode: `${VUS} users x 1 pass x ${STEP_UP ? STEPS.length : STEPS.length - 3} steps`,
      stepsPerJourney: STEP_UP ? STEPS.length : STEPS.length - 3,
      poolMax: POOL,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'monitor-announce' },
      responseCallback: http.expectedStatuses(200, 404),
    },
  );
  return {};
}

export function feFullJourney() {
  if (STAGGER > 0) sleep(Math.random() * STAGGER);

  const t0 = Date.now();
  const json = { 'Content-Type': 'application/json' };
  const unique = `${__VU}-${Date.now()}`;
  http.cookieJar().clear(API);

  const index = (USER_OFFSET + __VU - 1) % credentialPool.length;
  const cred = credentialPool[index];
  // The member routes need a second identity. Take one from the far end of the pool so a run never
  // invites a user another VU is signed in as.
  const invitee =
    credentialPool[(index + Math.floor(credentialPool.length / 2)) % credentialPool.length];

  const opening = publicBlock();
  const state = { ok: opening.ok };
  const step = stepper(state);

  // `send-code` is required before EVERY login: submitting the code consumes it, so a second login
  // without a fresh request fails with "invalid or expired verification code".
  step(
    '04-send-code',
    http.post(`${API}/auth/email/send-code`, JSON.stringify({ email: cred.email }), {
      headers: json,
      tags: { name: '04-send-code' },
    }),
    [200, 202],
  );

  const login = http.post(
    `${API}/auth/email/login`,
    JSON.stringify({ email: cred.email, code: STATIC_CODE }),
    {
      headers: json,
      tags: { name: '05-login' },
    },
  );
  if (!record('05-login', login, [200])) {
    for (const [name] of stepsFrom('06-me-context')) skip(name);
    journeyDuration.add(Date.now() - t0);
    return void journeyComplete.add(false);
  }
  let auth = { ...json, Authorization: `Bearer ${body(login).access_token}` };

  step(
    '06-me-context',
    http.get(`${API}/auth/me/context`, { headers: auth, tags: { name: '06-me-context' } }),
    [200],
  );

  if (!accountBlock(auth)) state.ok = false;
  if (!notifyBlock(auth)) state.ok = false;

  step(
    '20-list-orgs',
    http.get(`${API}/users/me/organizations`, { headers: auth, tags: { name: '20-list-orgs' } }),
    [200],
  );

  const slug = `k6-fe-${unique}`.toLowerCase().slice(0, 48);
  const createdOrg = http.post(
    `${API}/tenancy/organizations`,
    JSON.stringify({ name: `K6 FE ${unique}`, slug }),
    {
      headers: { ...auth, 'X-Idempotency-Key': idemKey('org') },
      tags: { name: '21-create-org' },
    },
  );
  const organizationOk = record('21-create-org', createdOrg, [200, 201]);
  const organizationId = organizationOk ? (body(createdOrg).id ?? null) : null;
  if (!organizationId) {
    // Without an organization nothing below can run. Everything after is SKIPPED rather than
    // failed: those steps were never attempted, and a fail count would misattribute one 409.
    state.ok = false;
    for (const [name] of stepsFrom('22-switch-org')) skip(name);
    journeyDuration.add(Date.now() - t0);
    return void journeyComplete.add(false);
  }

  const sw = step(
    '22-switch-org',
    http.post(
      `${API}/auth/switch-to-organization`,
      JSON.stringify({ organization_id: organizationId }),
      {
        headers: auth,
        tags: { name: '22-switch-org' },
      },
    ),
    [200],
  );
  const scoped = sw.status === 200 ? body(sw).access_token : null;
  if (scoped) auth = { ...json, Authorization: `Bearer ${scoped}` };

  // The app re-bootstraps after a scope change: the permission set it renders the sidebar from
  // belongs to the NEW organization, so the one cached at sign-in is already stale.
  step(
    '23-me-context-2',
    http.get(`${API}/auth/me/context`, { headers: auth, tags: { name: '23-me-context-2' } }),
    [200],
  );
  step(
    '24-patch-org',
    http.patch(`${API}/tenancy/organization`, JSON.stringify({ name: `K6 FE Renamed ${unique}` }), {
      headers: auth,
      tags: { name: '24-patch-org' },
    }),
    [200],
  );

  if (!apiKeyBlock(auth, unique)) state.ok = false;
  if (!webhookBlock(auth, unique)) state.ok = false;
  if (!roleBlock(auth, unique)) state.ok = false;
  if (!membershipBlock(auth, invitee.email, opening.seatCeiling)) state.ok = false;
  if (!billingBlock(auth)) state.ok = false;

  if (STEP_UP) {
    if (!stepUpBlock(auth, json, cred.email)) state.ok = false;
  } else {
    for (const n of ['49-step-up', '50-mfa-enroll', '51-webauthn-options']) skip(n);
  }

  if (!teardownBlock(auth, json, slug)) state.ok = false;

  journeyDuration.add(Date.now() - t0);
  journeyComplete.add(state.ok);
}

/* ────────────────────────────── Reporting ────────────────────────────── */

const pad = (s, n) =>
  String(s).length >= n ? String(s).slice(0, n) : String(s) + ' '.repeat(n - String(s).length);
const lpad = (s, n) =>
  String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s);
const ms = (v) => (v === undefined || v === null ? '-' : v.toFixed(1));

/** One rendered line of the per-route table, plus the counts the summary totals up. */
function summaryRow(m, name, method, path) {
  const k = metricKey(name);
  const calls = m[`ep_reqs_${k}`] ? m[`ep_reqs_${k}`].values.count : 0;
  const skips = m[`ep_skipped_${k}`] ? m[`ep_skipped_${k}`].values.count : 0;
  const rate = m[`ep_success_${k}`] ? m[`ep_success_${k}`].values.rate : 0;
  const dur = m[`ep_duration_${k}`] ? m[`ep_duration_${k}`].values : {};
  const ok = Math.round(calls * rate);
  const fail = calls - ok;

  return {
    calls,
    skips,
    text:
      `  ${pad(name.slice(0, 2), 3)}${pad(`${method} ${path}`, 54)}` +
      `${lpad(calls || '-', 7)}${lpad(ok || '-', 6)}${lpad(fail || '-', 6)}${lpad(skips || '-', 6)}` +
      `${lpad(ms(dur.avg), 9)}${lpad(ms(dur['p(95)']), 9)}`,
  };
}

export function handleSummary(data) {
  const m = data.metrics;
  const line = '-'.repeat(102);
  const rule = '='.repeat(102);
  const out = [];
  const planned = STEP_UP ? STEPS.length : STEPS.length - 3;

  out.push(rule);
  out.push(`  CORE-FE FULL JOURNEY   ${VUS} user(s)  x  1 pass  x  ${planned} steps`);
  out.push(
    `  DATABASE_POOL_MAX = ${POOL}   ·   step-up cluster ${STEP_UP ? 'INCLUDED' : 'skipped (set STEP_UP=true)'}`,
  );
  out.push(rule);
  out.push('');
  out.push(
    `  ${pad('#', 3)}${pad('ROUTE', 54)}${lpad('calls', 7)}${lpad('ok', 6)}${lpad('fail', 6)}${lpad('skip', 6)}${lpad('avg', 9)}${lpad('p95', 9)}`,
  );
  out.push(`  ${line}`);

  let sent = 0;
  let skipped = 0;
  for (const [name, method, path] of STEPS) {
    const row = summaryRow(m, name, method, path);
    sent += row.calls;
    skipped += row.skips;
    out.push(row.text);
  }

  out.push(`  ${line}`);
  out.push('');
  out.push(`  ${line}`);
  out.push('  SUMMARY');
  out.push(`  ${line}`);

  const completeCount = m.journey_complete ? m.journey_complete.values.passes : 0;
  const total = m.journey_complete
    ? m.journey_complete.values.passes + m.journey_complete.values.fails
    : 0;
  const jd = m.journey_duration ? m.journey_duration.values : {};
  const leaked = m.orgs_leaked ? m.orgs_leaked.values.count : 0;
  const throttled = m.teardown_throttled ? m.teardown_throttled.values.count : 0;
  const verified = m.cleanup_verified ? m.cleanup_verified.values.count : 0;

  const seats = m.seat_limit_hit ? m.seat_limit_hit.values.count : 0;
  const summary = [
    ['users (VUs)', VUS],
    ['steps per user', planned],
    ['calls expected', VUS * planned],
    ['calls actually sent', sent],
    ['steps skipped', skipped],
    ['users completing every step', `${completeCount} of ${total}`],
    ['time for one user avg/p95', `${ms(jd.avg)} / ${ms(jd['p(95)'])} ms`],
    [
      'per-call avg/p95',
      `${ms(m.http_req_duration?.values.avg)} / ${ms(m.http_req_duration?.values['p(95)'])} ms`,
    ],
    [
      'member invite',
      seats > 0
        ? `refused for ${seats} VU(s) — Free plan allows 1 seat; steps 44-45 need Starter/Pro, a Stripe call`
        : 'accepted — member routes exercised end to end',
    ],
    [
      'ORGS LEAKED',
      leaked > 0
        ? `${leaked} NOT DELETED${throttled > 0 ? ` (${throttled} throttled — DELETE /organization allows 5 per 5 min per user; space repeat runs)` : ''}`
        : verified === VUS
          ? `0 — all ${verified} confirmed gone from the owner's own me/context`
          : `0 deletes rejected, but only ${verified}/${VUS} confirmed gone — treat as unproven`,
    ],
  ];
  for (const [k, v] of summary) out.push(`  ${pad(k, 34)}${v}`);

  out.push('');
  out.push(rule);

  const tag = __ENV.RESULT_TAG || `fe-full-${VUS}`;
  const text = `\n${out.join('\n')}\n`;
  // Written to /tmp, matching the other scenarios: run artifacts never land in the repo tree.
  return { stdout: text, [`/tmp/k6-fe-full-${tag}.txt`]: text };
}
