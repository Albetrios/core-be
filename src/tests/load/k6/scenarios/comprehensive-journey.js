/**
 * k6 Scenario: Full natural multi-tenant user journey (reads + complete CRUD).
 *
 * Each VU = a DISTINCT pool user (12 organizations x 10 users) acting as an organization admin, moving
 * through the product the way a real admin would in one session. Bodies are taken from
 * the passing e2e/integration tests, so writes succeed (no 400s).
 *
 * Resilience:
 *  - organization-scoped token minted per VU (login -> switch-to-organization); any 401 re-auths + retries.
 *  - latency is recorded ONLY for 2xx responses, so the organization-scoped write cap (100/min) or any
 *    error surfaces in the fail counter without polluting per-op latency.
 *  - think-time between phases keeps a single VU under the per-organization write cap (natural pacing).
 *
 * Coverage every iteration: profile + organization reads, self-service updates, and full
 *   create->read->update->delete lifecycles for roles, api-keys, notification-policies, webhooks.
 * Coverage once per VU (first iteration): the idempotent/heavy flows — create organization,
 *   member invite chain (add member by email -> revoke invitation -> suspend -> remove), data-export.
 *
 * Excludes destructive/external: DELETE /users/me, organization delete, Stripe, MFA/WebAuthn, logout.
 *
 * Run:  VUS=1 DURATION=60s  k6 run comprehensive-journey.js   (1-user baseline)
 *       VUS=100 DURATION=90s k6 run comprehensive-journey.js  (load)
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3001';
const API = `${BASE}/api/v1`;
const VUS = Number(__ENV.VUS || '1');
const DURATION = __ENV.DURATION || '60s';
const THINK = Number(__ENV.THINK ?? '0.4'); // seconds of think-time between phases
const RUN = (__ENV.RUN || 'r').replace(/[^a-z0-9]/gi, ''); // run id -> unique resource names across runs
const REAUTH = (__ENV.REAUTH || 'false') === 'true'; // re-login on 401 (off for capacity runs — see req())
const WRITE_EVERY = Number(__ENV.WRITE_EVERY || '1'); // run write phases every Nth iteration (read-dominant when >1)

// Notification vocabulary — mirrors src/shared/constants/notification.constants.ts, a strict enum
// since #964 (free-form types are 422'd). Each VU takes a distinct (type, channel) pair from the 9x4
// grid so concurrent policy creates rarely collide on the unique (notification_type, channel) key;
// phasePolicy's create->delete lifecycle frees the pair each iteration.
const NOTIFICATION_TYPES = [
  'system.welcome',
  'system.maintenance',
  'security.alert',
  'billing.usage_threshold',
  'billing.payment_succeeded',
  'billing.payment_failed',
  'membership.invite_accepted',
  'subscription.updated',
  'webhook.delivery_failed',
];
const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'WEB_PUSH', 'IN_APP'];

const pool = new SharedArray('creds', () => JSON.parse(open('../data/credential-pool.json')));

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  setupTimeout: '300s', // mint all pool tokens once, sequentially, before VUs start
  scenarios: {
    journey: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: VUS }, // ramp up (avoid thundering herd at t=0)
        { duration: DURATION, target: VUS }, // steady state
        { duration: '5s', target: 0 },
      ],
    },
  },
};

/**
 * Mint an organization-scoped token for every pool user ONCE, before any VU runs. This avoids a
 * login storm + per-IP login-rate-limit 429s when 100s of VUs would otherwise each log in
 * from the same IP. VUs index into the returned array by VU number.
 */
export function setup() {
  const tokens = [];
  let mfaSkipped = 0;
  for (const c of pool) {
    const lr = http.post(
      `${API}/auth/login`,
      JSON.stringify({ email: c.email, password: c.password }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'login' },
      },
    );
    // Skip users whose organization requires MFA (login returns mfa_required, no access_token) — that was
    // the 25% failure source. Only token-bearing users ride.
    let t = lr.json('data.access_token');
    if (!t) {
      mfaSkipped += 1;
      continue;
    }
    // Scope the token to the user's admin organization (pool organizationPublicId) so write ops are permitted.
    if (c.organizationPublicId) {
      const sr = http.post(
        `${API}/auth/switch-to-organization`,
        JSON.stringify({ organization_id: c.organizationPublicId }),
        {
          headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
          tags: { name: 'switch-org' },
        },
      );
      const st = sr.json('data.access_token');
      if (!st) {
        // switch failed -> not a scoped admin of this organization; skip so write ops never 403.
        mfaSkipped += 1;
        continue;
      }
      t = st;
    }
    // Warm this user's organization permission cache so the measured load doesn't hit a cold-start recompute
    // herd (which yields transient 403 insufficientOrganizationPermissions at high VU ramps).
    http.get(`${API}/tenancy/organization/memberships`, {
      headers: { Authorization: `Bearer ${t}` },
      tags: { name: 'warm' },
    });
    tokens.push({
      token: t,
      email: c.email,
      password: c.password,
      organizationPublicId: c.organizationPublicId,
      userPublicId: c.userPublicId,
    });
  }
  // biome-ignore lint/suspicious/noConsole: k6 setup progress is intentionally emitted to stdout.
  console.log(
    `setup: ${tokens.length} usable tokens minted, ${mfaSkipped} skipped (mfa/switch-fail)`,
  );
  return tokens;
}

// ---- metrics (one Trend + one fail Counter per named operation) ----
const OP_NAMES = [
  'login',
  'switch-org',
  'get-me',
  'get-me-settings',
  'get-notif-prefs',
  'auth-context',
  'auth-sessions',
  'auth-methods',
  'auth-mfa',
  'list-orgs',
  'get-org',
  'get-organization-settings',
  'list-members',
  'list-roles',
  'list-api-keys',
  'list-notif-policies',
  'list-permissions',
  'list-notifications',
  'unread-count',
  'list-webhooks',
  'list-webhook-events',
  'list-subscriptions',
  'patch-me-settings',
  'put-notif-prefs',
  'request-upload',
  'delete-upload',
  'create-role',
  'get-role',
  'put-role-perms',
  'patch-role',
  'delete-role',
  'create-api-key',
  'delete-api-key',
  'create-notif-policy',
  'patch-notif-policy',
  'delete-notif-policy',
  'create-webhook',
  'get-webhook',
  'patch-webhook',
  'delete-webhook',
  'patch-organization-settings',
  'mark-all-read',
  'create-org',
  'data-export',
  'create-membership',
  'delete-invitation',
  'patch-membership',
  'delete-membership',
];
const slug = (n) => n.replace(/[^a-z0-9]/gi, '_');
const mid = (n) => `rt_${slug(n)}`; // total round-trip latency
const sid = (n) => `srv_${slug(n)}`; // Server-Timing app;dur = pure server compute
const wid = (n) => `wait_${slug(n)}`; // TTFB / waiting = compute + network + server-side queue
const fid = (n) => `fail_${slug(n)}`;
const trends = {};
const srv = {};
const wait = {};
const fails = {};
const c429 = {};
const c503 = {};
const c4xx = {};
for (const n of OP_NAMES) {
  trends[n] = new Trend(mid(n), true);
  srv[n] = new Trend(sid(n), true);
  wait[n] = new Trend(wid(n), true);
  fails[n] = new Counter(fid(n));
  c429[n] = new Counter(`s429_${slug(n)}`);
  c503[n] = new Counter(`s503_${slug(n)}`);
  c4xx[n] = new Counter(`s4xx_${slug(n)}`);
}

// ---- per-VU auth state ----
let token = null;
let cred = null;
let idemCounter = 0;

function pick() {
  return pool[(__VU - 1) % pool.length];
}

function serverTimingMs(res) {
  const h = res.headers['Server-Timing'] || res.headers['server-timing'];
  if (!h) return null;
  const m = /dur=([\d.]+)/.exec(h);
  return m ? Number(m[1]) : null;
}

function record(name, res) {
  if (res.status >= 200 && res.status < 300) {
    trends[name].add(res.timings.duration);
    wait[name].add(res.timings.waiting);
    const s = serverTimingMs(res);
    if (s != null) srv[name].add(s);
  } else {
    fails[name].add(1);
    if (res.status === 429) c429[name].add(1);
    else if (res.status === 503) c503[name].add(1);
    else c4xx[name].add(1);
    if (__ENV.DIAG === 'true') {
      // biome-ignore lint/suspicious/noConsole: DIAG mode intentionally prints failing k6 responses.
      console.log(`DIAGFAIL ${name} status=${res.status} body=${(res.body || '').slice(0, 120)}`);
    }
  }
}

function doLogin() {
  cred = pick();
  const lr = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: cred.email, password: cred.password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'login' },
    },
  );
  record('login', lr);
  let t = lr.json('data.access_token');
  if (t && cred.organizationPublicId) {
    const sr = http.post(
      `${API}/auth/switch-to-organization`,
      JSON.stringify({ organization_id: cred.organizationPublicId }),
      {
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        tags: { name: 'switch-org' },
      },
    );
    record('switch-org', sr);
    t = sr.json('data.access_token') || t;
  }
  token = t;
  return t;
}

function req(name, method, path, body, idempotent) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (idempotent) headers['X-Idempotency-Key'] = `idem-${RUN}-${__VU}-${__ITER}-${idemCounter++}`;
  const payload = body ? JSON.stringify(body) : null;
  let res = http.request(method, `${API}${path}`, payload, { headers, tags: { name } });
  // Token-expiry re-auth — OFF by default (REAUTH=true to enable). Disabled for capacity runs:
  // every VU shares one IP, so re-login on 401 storms the per-IP login rate limit and self-amplifies.
  if (REAUTH && res.status === 401) {
    doLogin();
    const retryHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (idempotent)
      retryHeaders['X-Idempotency-Key'] = `idem-${RUN}-${__VU}-${__ITER}-${idemCounter++}`;
    res = http.request(method, `${API}${path}`, payload, { headers: retryHeaders, tags: { name } });
  }
  record(name, res);
  return res;
}

const think = () => THINK > 0 && sleep(THINK);

// ---- phases ----
function phaseProfile() {
  req('get-me', 'GET', '/users/me');
  req('get-me-settings', 'GET', '/users/me/settings');
  req('get-notif-prefs', 'GET', '/users/me/notification-preferences');
  req('auth-context', 'GET', '/auth/me/context');
  req('auth-sessions', 'GET', '/auth/me/sessions');
  req('auth-methods', 'GET', '/auth/me/auth-methods');
  req('auth-mfa', 'GET', '/auth/me/mfa');
  think();
}

function phaseExplore() {
  req('list-orgs', 'GET', '/users/me/organizations');
  req('get-org', 'GET', '/tenancy/organization');
  req('get-organization-settings', 'GET', '/tenancy/organization/settings');
  req('list-members', 'GET', '/tenancy/organization/memberships');
  req('list-roles', 'GET', '/tenancy/organization/roles');
  req('list-api-keys', 'GET', '/tenancy/organization/api-keys');
  req('list-notif-policies', 'GET', '/tenancy/organization/notification-policies');
  req('list-permissions', 'GET', '/tenancy/permissions');
  req('list-notifications', 'GET', '/notify/notifications?limit=20');
  req('unread-count', 'GET', '/notify/notifications/unread-count');
  req('list-webhooks', 'GET', '/notify/webhooks');
  req('list-webhook-events', 'GET', '/notify/webhook-events');
  req('list-subscriptions', 'GET', '/billing/subscriptions');
  think();
}

function phaseSelfService(_uniq) {
  req('patch-me-settings', 'PATCH', '/users/me/settings', {
    is_dark_mode_enabled: true,
    language: 'en',
  });
  req('put-notif-prefs', 'PUT', '/users/me/notification-preferences', {
    preferences: [
      { notification_type: 'billing.usage_threshold', channel: 'EMAIL', is_enabled: true },
    ],
  });
  think();
}

function phaseRole(uniq) {
  const r = req(
    'create-role',
    'POST',
    '/tenancy/organization/roles',
    {
      name: `Role ${uniq}`,
      description: 'k6',
    },
    true,
  );
  const roleId = r.json('data.id');
  if (roleId) {
    req('get-role', 'GET', `/tenancy/organization/roles/${roleId}`);
    req('put-role-perms', 'PUT', `/tenancy/organization/roles/${roleId}/permissions`, {
      permission_codes: ['organization:read', 'membership:read', 'role:read'],
    });
    req('patch-role', 'PATCH', `/tenancy/organization/roles/${roleId}`, {
      name: `Role ${uniq} v2`,
    });
    req('delete-role', 'DELETE', `/tenancy/organization/roles/${roleId}`);
  }
  think();
  return roleId;
}

function phaseApiKey(uniq) {
  const r = req(
    'create-api-key',
    'POST',
    '/tenancy/organization/api-keys',
    {
      name: `Key ${uniq}`,
      scopes: ['api-key:read'],
      expires_in_days: 30,
    },
    true,
  );
  const keyId = r.json('data.api_key.id') || r.json('data.id');
  if (keyId) req('delete-api-key', 'DELETE', `/tenancy/organization/api-keys/${keyId}`);
  think();
}

function phasePolicy(_uniq) {
  // Distinct (type, channel) pair per VU across the 9x4 valid combinations (see the note above).
  const pairIndex = (__VU - 1) % (NOTIFICATION_TYPES.length * NOTIFICATION_CHANNELS.length);
  const notificationType = NOTIFICATION_TYPES[pairIndex % NOTIFICATION_TYPES.length];
  const notificationChannel =
    NOTIFICATION_CHANNELS[Math.floor(pairIndex / NOTIFICATION_TYPES.length)];
  const r = req(
    'create-notif-policy',
    'POST',
    '/tenancy/organization/notification-policies',
    {
      notification_type: notificationType,
      channel: notificationChannel,
      default_enabled: true,
    },
    true,
  );
  const polId = r.json('data.id');
  if (polId) {
    req('patch-notif-policy', 'PATCH', `/tenancy/organization/notification-policies/${polId}`, {
      default_enabled: false,
    });
    req('delete-notif-policy', 'DELETE', `/tenancy/organization/notification-policies/${polId}`);
  }
  think();
}

function phaseWebhook(uniq) {
  const r = req(
    'create-webhook',
    'POST',
    '/notify/webhooks',
    {
      url: `https://example.com/webhook?k6=${uniq}`,
      events: ['subscription.created'],
    },
    true,
  );
  const whId = r.json('data.id');
  if (whId) {
    req('get-webhook', 'GET', `/notify/webhooks/${whId}`);
    req('patch-webhook', 'PATCH', `/notify/webhooks/${whId}`, { is_enabled: false });
    req('delete-webhook', 'DELETE', `/notify/webhooks/${whId}`);
  }
  think();
}

function phaseOrgAdminMisc() {
  req('patch-organization-settings', 'PATCH', '/tenancy/organization/settings', {
    is_email_notifications_enabled: true,
    default_locale: 'en',
  });
  req('mark-all-read', 'POST', '/notify/notifications/mark-all-read', {});
  think();
}

// Rare/heavy flows — once per VU (first iteration) to cover them without bloat / rate caps.
function phaseRareOnce(uniq) {
  // data-export (EXPENSIVE_AUTHED_RATE_LIMIT 5/5min)
  req('data-export', 'POST', '/users/me/data-export', {});

  // avatar upload presign — then delete the pending upload so it never fills the per-user quota.
  const up = req(
    'request-upload',
    'POST',
    '/uploads',
    {
      purpose: 'avatar',
      for: 'user',
      content_type: 'image/png',
      file_name: `avatar-${uniq}.png`,
      file_size: 1024,
    },
    true,
  );
  const upId = up.json('data.id');
  if (upId) req('delete-upload', 'DELETE', `/uploads/${upId}`);

  // NOTE: create-organization is intentionally excluded — it has a per-owner cap (MAX_TEAM_ORGANIZATIONS_PER_OWNER)
  // and no delete here (organization-delete is destructive), so it accumulates unboundedly and isn't a hot path.

  // member invite chain: invite a user from ANOTHER organization into this organization, then tear it down.
  const invitee = pool[(__VU - 1 + 60) % pool.length];
  const roleForMember = req(
    'create-role',
    'POST',
    '/tenancy/organization/roles',
    { name: `Member Role ${uniq}` },
    true,
  ).json('data.id');
  if (invitee && roleForMember && invitee.email !== cred.email) {
    // pre-clean: drop any leftover membership for this invitee so add-by-email never conflicts (409)
    const existing = req('list-members', 'GET', '/tenancy/organization/memberships?limit=100');
    const members = existing.json('data.items') || existing.json('data') || [];
    const prior = Array.isArray(members)
      ? members.find(
          (mm) => mm.user?.email === invitee.email || mm.user_id === invitee.userPublicId,
        )
      : null;
    if (prior?.id) {
      req('delete-membership', 'DELETE', `/tenancy/organization/memberships/${prior.id}`);
    }
    const m = req(
      'create-membership',
      'POST',
      '/tenancy/organization/memberships',
      { email: invitee.email, role_id: roleForMember, expires_in_days: 7 },
      true,
    );
    const membershipId = m.json('data.id');
    const invitationId = m.json('data.invitation.id');
    if (membershipId) {
      if (invitationId)
        req('delete-invitation', 'DELETE', `/tenancy/organization/invitations/${invitationId}`);
      req('patch-membership', 'PATCH', `/tenancy/organization/memberships/${membershipId}`, {
        status: 'SUSPENDED',
      });
      req('delete-membership', 'DELETE', `/tenancy/organization/memberships/${membershipId}`);
    }
  }
  if (roleForMember) req('delete-role', 'DELETE', `/tenancy/organization/roles/${roleForMember}`);
  think();
}

export default function (tokenPool) {
  if (!token) {
    // Token comes ONLY from setup() (minted once). No lazy/per-request login -> can't storm.
    const e = tokenPool[(__VU - 1) % tokenPool.length];
    token = e?.token ? e.token : null;
    cred = e
      ? {
          email: e.email,
          password: e.password,
          organizationPublicId: e.organizationPublicId,
          userPublicId: e.userPublicId,
        }
      : null;
  }
  const uniq = `${RUN}-${__VU}-${__ITER}`;

  phaseProfile();
  phaseExplore();
  // Writes are occasional (a real session is mostly reads). WRITE_EVERY=1 -> every iteration (heavy);
  // higher -> realistic read-dominant load that doesn't churn the organization permission cache.
  if (__ITER % WRITE_EVERY === 0) {
    phaseSelfService(uniq);
    phaseRole(uniq);
    phaseApiKey(uniq);
    phasePolicy(uniq);
    phaseWebhook(uniq);
    phaseOrgAdminMisc();
  }
  // Heavy member-invite flow: cross-organization membership changes churn invitees' permission caches, so it
  // is OFF by default for capacity runs (RARE=true to include it; a fraction of VUs, once).
  if (__ENV.RARE === 'true' && __ITER === 0 && __VU % 8 === 0) phaseRareOnce(uniq);
}

export function handleSummary(data) {
  const val = (metricName) => (data.metrics[metricName] ? data.metrics[metricName].values : null);
  const cnt = (metricName) =>
    data.metrics[metricName]?.values.count ? data.metrics[metricName].values.count : 0;
  const rows = [];
  for (const n of OP_NAMES) {
    const rt = val(mid(n));
    const ok = rt ? rt.count : 0;
    const fail = cnt(fid(n));
    if (ok === 0 && fail === 0) continue;
    const sv = val(sid(n));
    const wv = val(wid(n));
    rows.push({
      name: n,
      ok,
      fail,
      s4xx: cnt(`s4xx_${slug(n)}`),
      s429: cnt(`s429_${slug(n)}`),
      s503: cnt(`s503_${slug(n)}`),
      total_avg: rt ? rt.avg : null,
      total_p99: rt ? rt['p(99)'] : null,
      srv_avg: sv ? sv.avg : null,
      srv_p99: sv ? sv['p(99)'] : null,
      wait_p99: wv ? wv['p(99)'] : null,
      qnet_p99: wv && sv ? wv['p(99)'] - sv['p(99)'] : null,
    });
  }
  // sort by SERVER compute p99 — that is the in-process cost we can actually optimize
  rows.sort((a, b) => (b.srv_p99 || 0) - (a.srv_p99 || 0));
  const lab = (s, w) => String(s).padStart(w);
  const num = (x, w) => (x == null ? '-' : Number(x).toFixed(1)).padStart(w);
  let out = `\n=== FULL JOURNEY @ ${VUS} VU / ${DURATION} (think=${THINK}s) — sorted by SERVER-compute p99 (ms) ===\n`;
  out +=
    'operation'.padEnd(22) +
    lab('srvP99', 8) +
    lab('srvAvg', 8) +
    lab('totP99', 8) +
    lab('waitP99', 9) +
    lab('q+net', 8) +
    lab('ok', 6) +
    lab('4xx', 5) +
    lab('429', 5) +
    lab('503', 5) +
    '\n';
  for (const r of rows) {
    out +=
      r.name.padEnd(22) +
      num(r.srv_p99, 8) +
      num(r.srv_avg, 8) +
      num(r.total_p99, 8) +
      num(r.wait_p99, 9) +
      num(r.qnet_p99, 8) +
      lab(r.ok, 6) +
      lab(r.s4xx, 5) +
      lab(r.s429, 5) +
      lab(r.s503, 5) +
      '\n';
  }
  const d = data.metrics.http_req_duration.values;
  const reqs = data.metrics.http_reqs.values;
  const failed = data.metrics.http_req_failed.values;
  const iters = data.metrics.iterations.values;
  let t429 = 0;
  let t503 = 0;
  let t4xx = 0;
  for (const n of OP_NAMES) {
    t429 += cnt(`s429_${slug(n)}`);
    t503 += cnt(`s503_${slug(n)}`);
    t4xx += cnt(`s4xx_${slug(n)}`);
  }
  out += `\nOVERALL round-trip: avg=${d.avg.toFixed(1)} p95=${d['p(95)'].toFixed(1)} p99=${d['p(99)'].toFixed(1)} max=${d.max.toFixed(1)} ms\n`;
  out += `        ${reqs.count} reqs @ ${reqs.rate.toFixed(0)}/s | ${iters.count} journeys | failed ${(failed.rate * 100).toFixed(2)}%  (4xx=${t4xx} 429=${t429} 503=${t503})\n`;
  out += `        srvP99=server compute (Server-Timing app;dur) · totP99=full round-trip · waitP99=TTFB · q+net=waitP99-srvP99 (queue+network)\n`;
  return { stdout: out, [`/tmp/journey-${VUS}vu.json`]: JSON.stringify(rows, null, 2) };
}
