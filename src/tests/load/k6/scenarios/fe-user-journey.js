import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { API_PREFIX } from '../helpers/config.js';
import { credentialPool } from '../helpers/pool.js';

/**
 * k6 Scenario: core-fe FULL signup journey — N users, ONE pass each, 16 routes.
 *
 * **VUS = users, and every user walks all sixteen routes exactly once**, so the call
 * count is always `VUS x 16`. 50 users means 50 signups and 800 calls. Nothing loops.
 *
 * This is the heavy scenario: a brand-new person arriving with no account and leaving
 * with a provisioned organization and a loaded dashboard. Every iteration creates a
 * real user AND a real organization, so the database grows with every run.
 *
 * ## Companion scenario
 *
 * `fe-session.js` covers the same product surface for an EXISTING user — password
 * login from the seeded credential pool, 8 routes, no signup. Reach for that one when
 * you want capacity numbers for the app; reach for this one when you want the cost of
 * onboarding itself.
 *
 * The difference is large and worth knowing before you read a result: signup pays
 * `ANTI_ENUMERATION_MINIMUM_DURATION_MS` (300 ms) TWICE — once in `send-code` and once
 * in `email/login` — a deliberate constant-time floor that stops response timing
 * revealing whether an account exists. ~600 ms of every journey here is that sleep.
 *
 * ## The sixteen routes
 *
 *   Cold boot   1  POST /auth/refresh                        guest — 403/401 is CORRECT
 *   Sign up     2  POST /auth/email/send-code                request a one-time code
 *               3  POST /auth/email/login                    redeem it, account created
 *   Session     4  GET  /auth/me/context                     onboarding_completed = false
 *   Onboarding  5  PATCH /users/me                           profile step
 *               6  POST /tenancy/organizations               create the workspace
 *               7  POST /users/me/onboarding/complete        stamp the flag
 *               8  POST /auth/switch-to-organization         activate it
 *   Workspace  10  GET  /tenancy/organizations               switcher list
 *              11  GET  /tenancy/organizations/by-slug/:slug resolve the URL slug
 *   Dashboard  12  GET  /notify/notifications/unread-count   bell badge
 *              13  GET  /notify/notifications                inbox
 *              14  GET  /tenancy/organization                shell header
 *   Upkeep     15  POST /auth/refresh                        proactive refresh
 *              16  POST /auth/logout                         end the session
 *
 * Two calls need headers that are easy to miss, and both 4xx without them:
 *   - `POST /tenancy/organizations` requires `X-Idempotency-Key` (422 otherwise)
 *   - `POST /auth/refresh` requires `X-CSRF-Token` matching the csrf_token cookie (403)
 *
 * STAGGER spreads VU start times over a window (default 5 s). Real users do not arrive
 * on a starting pistol; without it every VU fires in the same millisecond and you
 * measure a thundering herd. Set STAGGER=0 to measure that burst deliberately.
 *
 * A journey that fails early stops firing its later routes, so a failing run sends
 * FEWER calls than `VUS x 16`, never more.
 *
 * REQUIRES the API with TEST_MODE=true (the OTP echo lets a VU complete its own signup).
 *
 * Usage:
 *   VUS=1  k6 run fe-user-journey.js       # 1 user,  16 calls
 *   VUS=50 k6 run fe-user-journey.js       # 50 users, 800 calls, 50 signups + 50 orgs
 */

const VUS = Number(__ENV.VUS || 1);
const STAGGER = Number(__ENV.STAGGER ?? 5);
/** The API's DATABASE_POOL_MAX for this run, supplied by the runner (see run.sh). */
const POOL = __ENV.POOL || 'unknown';
/**
 * How each VU authenticates.
 *
 *   code (default) — ONE call to `POST /auth/email/login` with the static verification
 *                    code, as a distinct pre-seeded user. No send-code, no argon2.
 *                    Needs the API started with AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED set.
 *   password       — ONE call to `POST /auth/login` with email + password from the pool.
 *                    Real argon2 verification, so it costs more than `code`.
 *   otp            — the real signup flow: `send-code` then `email/login`, creating a
 *                    brand-new account per VU. Reads `debug_verification_code`, which the
 *                    API only echoes under TEST_MODE.
 *
 * Why password is the default for load work, measured on an idle server:
 *
 *   otp       send-code    604 ms   + email/login  724 ms   = 1328 ms over 2 calls
 *   password  login        184 ms                           =  184 ms over 1 call
 *
 * `send-code` ALWAYS pays `ANTI_ENUMERATION_MINIMUM_DURATION_MS` (300 ms) — a
 * constant-time floor so response timing cannot reveal whether an account exists.
 * `POST /auth/login` applies that same floor only on its FAILURE paths (unknown email,
 * wrong password), so a successful login skips it entirely.
 *
 * Use `AUTH=otp` when you specifically want to measure signup cost; use the default
 * when you want the app's capacity without the sign-in ceremony dominating the result.
 */
const AUTH = (__ENV.AUTH || 'code').toLowerCase();
/**
 * The static code accepted by `POST /auth/email/login` when the API runs with a matching
 * `AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED`. Lets a VU authenticate in ONE call with no `send-code`
 * round trip — so no per-email resend cooldown, no send-code rate limit, and none of the
 * 300 ms anti-enumeration floor that call always pays.
 *
 * The API's env schema refuses any value for `AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED` in production,
 * so this path exists on local and development runtimes only.
 */
const STATIC_CODE = __ENV.STATIC_CODE || 'TEST24';

/** The sixteen routes each user walks, in order. */
const STEPS = [
  ['01-refresh-guest', 'POST', '/auth/refresh'],
  ...(AUTH === 'otp'
    ? [
        ['02-send-code', 'POST', '/auth/email/send-code'],
        ['03-email-login', 'POST', '/auth/email/login'],
      ]
    : AUTH === 'password'
      ? [['02-login', 'POST', '/auth/login']]
      : [
          // send-code is measured as its own route because the real app always calls it, even
          // though login below uses AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED and never reads the code this
          // issues. Keeping it in the journey keeps its cost (mail enqueue + the
          // anti-enumeration floor) visible instead of hiding it behind the static-code shortcut.
          ['02-send-code', 'POST', '/auth/email/send-code'],
          ['03-code-login', 'POST', '/auth/email/login'],
        ]),
  ['04-me-context', 'GET', '/auth/me/context'],
  ['05-patch-profile', 'PATCH', '/users/me'],
  ['06-create-org', 'POST', '/tenancy/organizations'],
  ['07-onboarding-complete', 'POST', '/users/me/onboarding/complete'],
  ['08-switch-org', 'POST', '/auth/switch-to-organization'],
  ['09-me-context-2', 'GET', '/auth/me/context'],
  ['10-list-orgs', 'GET', '/tenancy/organizations'],
  ['11-org-by-slug', 'GET', '/tenancy/organizations/by-slug/:slug'],
  ['12-unread-count', 'GET', '/notify/notifications/unread-count'],
  ['13-notifications', 'GET', '/notify/notifications'],
  ['14-org-detail', 'GET', '/tenancy/organization'],
  ['15-refresh-authed', 'POST', '/auth/refresh'],
  ['16-logout', 'POST', '/auth/logout'],
];

const metricKey = (name) => name.replace(/-/g, '_');

const M = {};
for (const [name] of STEPS) {
  const k = metricKey(name);
  M[name] = {
    dur: new Trend(`ep_duration_${k}`, true),
    ok: new Rate(`ep_success_${k}`),
    hits: new Counter(`ep_reqs_${k}`),
    rl: new Counter(`ep_429_${k}`),
  };
}
const journeyDuration = new Trend('journey_duration', true);
const journeyComplete = new Rate('journey_complete');

export const options = {
  scenarios: {
    journey: {
      // One iteration per VU: N users, one pass each. Nothing loops.
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '15m',
      gracefulStop: '60s',
      exec: 'feJourney',
    },
  },
  thresholds: { journey_complete: ['rate>=0'] },
};

/** Announce the run shape to the load-testing monitor (404s harmlessly without it). */
export function setup() {
  if (AUTH !== 'otp' && credentialPool.length === 0) {
    throw new Error('AUTH=password needs a credential pool — run: pnpm db:seed:loadtest');
  }
  http.post(
    `${__ENV.BASE_URL || ''}/__monitor/run`,
    JSON.stringify({
      command: `BASE_URL=${__ENV.BASE_URL || 'http://localhost:3000'} VUS=${VUS} \\\n    k6 run src/tests/load/k6/scenarios/fe-user-journey.js`,
      vus: VUS,
      mode: `${VUS} users x 1 pass x ${STEPS.length} routes (auth: ${AUTH})`,
      stepsPerJourney: STEPS.length,
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

/** Writes that the API rejects with 422 unless an idempotency key is present. */
function idemKey() {
  return `k6-${__VU}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** `/auth/refresh` is CSRF-protected: the csrf_token cookie must be echoed as a header. */
function csrfToken() {
  const c = http.cookieJar().cookiesForURL(`${API_PREFIX}/auth/refresh`).csrf_token;
  return Array.isArray(c) ? c[0] : c;
}

function record(name, res, expected) {
  const m = M[name];
  m.dur.add(res.timings.duration);
  m.hits.add(1);
  if (res.status === 429) m.rl.add(1);
  const pass = expected.includes(res.status);
  m.ok.add(pass);
  check(res, { [`${name} -> ${expected.join('|')}`]: () => pass });
  return pass;
}

/**
 * Runs the journey's authentication leg and returns the bearer token, or `undefined` when the
 * caller should abandon the journey. Extracted from {@link feJourney} so the three auth modes do
 * not push the main walk past the cognitive-complexity budget.
 */
function authenticate(json, email) {
  let token;
  // 02 — authenticate. One call with a password, or the two-call OTP signup.
  if (AUTH === 'otp') {
    const send = http.post(`${API_PREFIX}/auth/email/send-code`, JSON.stringify({ email }), {
      headers: json,
      tags: { name: '02-send-code' },
    });
    if (!record('02-send-code', send, [200, 201])) return undefined;

    const code = JSON.parse(send.body).data?.debug_verification_code;
    if (!code) return undefined; // TEST_MODE off — cannot proceed

    const login = http.post(`${API_PREFIX}/auth/email/login`, JSON.stringify({ email, code }), {
      headers: json,
      tags: { name: '03-email-login' },
    });
    if (!record('03-email-login', login, [200, 201])) return undefined;
    token = JSON.parse(login.body).data?.access_token;
  } else {
    // Wrap so VUS may exceed the pool size; each VU still gets a stable identity.
    const cred = credentialPool[(__VU - 1) % credentialPool.length];

    if (AUTH === 'password') {
      const login = http.post(
        `${API_PREFIX}/auth/login`,
        JSON.stringify({ email: cred.email, password: cred.password }),
        { headers: json, tags: { name: '02-login' } },
      );
      if (!record('02-login', login, [200])) return undefined;
      token = JSON.parse(login.body).data?.access_token;
    } else {
      // The app always asks for a code, so the journey does too — its cost stays measured.
      // A non-200 here is not fatal: login does not depend on this call, because it presents
      // AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED rather than whatever code this issued.
      record(
        '02-send-code',
        http.post(`${API_PREFIX}/auth/email/send-code`, JSON.stringify({ email: cred.email }), {
          headers: json,
          tags: { name: '02-send-code' },
        }),
        [200],
      );

      // Static-code login: a code the API is configured to accept, so nothing is read from
      // `debug_verification_code` and the two calls stay independent.
      const login = http.post(
        `${API_PREFIX}/auth/email/login`,
        JSON.stringify({ email: cred.email, code: STATIC_CODE }),
        { headers: json, tags: { name: '03-code-login' } },
      );
      if (!record('03-code-login', login, [200])) {
        // A 401 here almost always means the API was started without a matching
        // AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED, not that the journey found a real defect.
        return undefined;
      }
      token = JSON.parse(login.body).data?.access_token;
    }
  }
  return token;
}

export function feJourney() {
  // Spread arrivals so the run measures capacity, not a synchronized burst.
  if (STAGGER > 0) sleep(Math.random() * STAGGER);

  const t0 = Date.now();
  const json = { 'Content-Type': 'application/json' };
  const unique = `${__VU}-${Date.now()}`;
  const email = `k6journey+${unique}@loadtest.example.com`;

  // A fresh jar per user, or a previous iteration's refresh cookie leaks in and the
  // "guest" cold boot silently succeeds instead of being rejected.
  http.cookieJar().clear(API_PREFIX);

  // 01 — cold boot. No session and no csrf_token cookie yet, so the CSRF gate answers
  // 403 before the session is even read; a stale cookie pair gives 401. Both mean
  // "guest", which is the CORRECT answer here — not a failure.
  const guest = http.post(`${API_PREFIX}/auth/refresh`, null, {
    headers: json,
    tags: { name: '01-refresh-guest' },
    responseCallback: http.expectedStatuses(200, 401, 403),
  });
  record('01-refresh-guest', guest, [200, 401, 403]);

  // 02 — authenticate (password, static code, or the two-call OTP signup).
  const token = authenticate(json, email);
  if (!token) return void journeyComplete.add(false);
  let auth = { ...json, Authorization: `Bearer ${token}` };

  // 04 — session context; onboarding_completed is false for a fresh account
  record(
    '04-me-context',
    http.get(`${API_PREFIX}/auth/me/context`, { headers: auth, tags: { name: '04-me-context' } }),
    [200],
  );

  // 05 — profile step
  record(
    '05-patch-profile',
    http.patch(
      `${API_PREFIX}/users/me`,
      JSON.stringify({ first_name: 'Load', last_name: `Test${__VU}`, job_title: 'Engineer' }),
      { headers: auth, tags: { name: '05-patch-profile' } },
    ),
    [200],
  );

  // 06 — create the workspace. Requires X-Idempotency-Key or the API answers 422.
  const slug = `k6-org-${unique}`.toLowerCase().slice(0, 48);
  const createOrg = http.post(
    `${API_PREFIX}/tenancy/organizations`,
    JSON.stringify({ name: `K6 Org ${unique}`, slug }),
    { headers: { ...auth, 'X-Idempotency-Key': idemKey() }, tags: { name: '06-create-org' } },
  );
  const orgOk = record('06-create-org', createOrg, [200, 201]);
  const orgId = orgOk ? JSON.parse(createOrg.body).data?.id : null;

  // 07 — stamp the flag BEFORE the context re-read, or the resolver bounces the user
  // straight back into onboarding.
  record(
    '07-onboarding-complete',
    http.post(`${API_PREFIX}/users/me/onboarding/complete`, null, {
      headers: auth,
      tags: { name: '07-onboarding-complete' },
    }),
    [200, 201, 204],
  );

  // 08 — activate the workspace. This re-mints the token with a signed `org` claim and
  // invalidates the previous one, so every later call must carry the NEW token.
  //
  // No `GET /auth/me/context` follows. The switch response already carries the new active
  // organization and permissions inline — the handler resolves them specifically "so the client
  // skips a follow-up GET /auth/me/context" — and core-fe honours that, writing the response
  // straight into its query cache (`setQueryData`) rather than refetching. An earlier revision
  // of this scenario re-read the context here, which measured a request the real app never
  // makes and made me/context the heaviest route in the report purely as an artifact.
  if (orgId) {
    const sw = http.post(
      `${API_PREFIX}/auth/switch-to-organization`,
      JSON.stringify({ organization_id: orgId }),
      { headers: auth, tags: { name: '08-switch-org' } },
    );
    if (record('08-switch-org', sw, [200])) {
      const next = JSON.parse(sw.body).data?.access_token;
      if (next) auth = { ...json, Authorization: `Bearer ${next}` };
    }
  }

  // 09 — context re-read after the switch. NOTE: core-fe does NOT make this call —
  // switch-to-organization already returns the active-org context inline and the client writes it
  // straight into its cache (setQueryData). It is measured here on purpose, as the benchmark for
  // the "repeat /auth/me/context" path: of its four reads only `my_permissions` is Redis-cached
  // today, so this step is what any caching work on the other three has to beat.
  record(
    '09-me-context-2',
    http.get(`${API_PREFIX}/auth/me/context`, { headers: auth, tags: { name: '09-me-context-2' } }),
    [200],
  );

  let allOk = orgOk;

  // 10-14 — workspace and dashboard reads.
  const reads = [
    ['10-list-orgs', '/tenancy/organizations'],
    ['11-org-by-slug', `/tenancy/organizations/by-slug/${slug}`],
    ['12-unread-count', '/notify/notifications/unread-count'],
    ['13-notifications', '/notify/notifications'],
    ['14-org-detail', '/tenancy/organization'],
  ];
  for (const [name, path] of reads) {
    if (!record(name, http.get(`${API_PREFIX}${path}`, { headers: auth, tags: { name } }), [200])) {
      allOk = false;
    }
  }

  // 15 — proactive refresh. Needs the CSRF double-submit header, and it ROTATES the
  // session: the token from step 08 is dead the moment this returns.
  const refresh = http.post(`${API_PREFIX}/auth/refresh`, null, {
    headers: { ...auth, 'X-CSRF-Token': csrfToken() },
    tags: { name: '15-refresh-authed' },
  });
  if (record('15-refresh-authed', refresh, [200])) {
    const rotated = JSON.parse(refresh.body).data?.access_token;
    if (rotated) auth = { ...json, Authorization: `Bearer ${rotated}` };
  } else {
    allOk = false;
  }

  // 16 — end the session
  if (
    !record(
      '16-logout',
      http.post(`${API_PREFIX}/auth/logout`, null, { headers: auth, tags: { name: '16-logout' } }),
      [200, 204],
    )
  ) {
    allOk = false;
  }

  journeyDuration.add(Date.now() - t0);
  journeyComplete.add(allOk);
}

/* ────────────────────────────── Reporting ────────────────────────────── */

const pad = (s, n) =>
  String(s).length >= n ? String(s).slice(0, n) : String(s) + ' '.repeat(n - String(s).length);
const lpad = (s, n) =>
  String(s).length >= n ? String(s) : ' '.repeat(n - String(s).length) + String(s);
const ms = (v) => (v === undefined || v === null ? '-' : v.toFixed(1));

export function handleSummary(data) {
  const m = data.metrics;
  const L = [];
  const W = 104;

  L.push('');
  L.push('='.repeat(W));
  L.push(
    `  core-fe FULL JOURNEY   ${VUS} user(s)  x  1 pass  x  ${STEPS.length} routes  =  ${VUS * STEPS.length} calls expected`,
  );
  L.push(
    `  DATABASE_POOL_MAX = ${POOL}   ·   AUTH = ${AUTH}${
      AUTH === 'otp'
        ? ' (send-code + email/login)'
        : AUTH === 'password'
          ? ' (single /auth/login, argon2)'
          : ` (send-code measured, then /auth/email/login with static code ${STATIC_CODE})`
    }`,
  );
  L.push('='.repeat(W));
  L.push('');

  L.push(
    `  ${pad('#  ROUTE', 46)}${lpad('calls', 7)}${lpad('ok', 7)}${lpad('fail', 7)}${lpad('429', 6)}${lpad('avg', 9)}${lpad('p95', 9)}${lpad('max', 9)}`,
  );
  L.push(`  ${'-'.repeat(W - 2)}`);
  let throttled = 0;
  for (const [name, method, path] of STEPS) {
    const k = metricKey(name);
    const d = m[`ep_duration_${k}`];
    const hits = m[`ep_reqs_${k}`];
    const ok = m[`ep_success_${k}`];
    const rl = m[`ep_429_${k}`];
    const label = `${name.slice(0, 2)} ${method} ${path}`;
    if (!(d?.values && hits?.values?.count)) {
      L.push(
        `  ${pad(label, 46)}${lpad(0, 7)}${lpad(0, 7)}${lpad('-', 7)}${lpad('-', 6)}${lpad('-', 9)}${lpad('-', 9)}${lpad('-', 9)}`,
      );
      continue;
    }
    const v = d.values;
    const n = hits.values.count;
    const good = ok ? ok.values.passes : 0;
    const n429 = rl ? rl.values.count : 0;
    throttled += n429;
    L.push(
      `  ${pad(label, 46)}${lpad(n, 7)}${lpad(good, 7)}${lpad(n - good || '-', 7)}${lpad(n429 || '-', 6)}${lpad(ms(v.avg), 9)}${lpad(ms(v['p(95)']), 9)}${lpad(ms(v.max), 9)}`,
    );
  }
  L.push(`  ${'-'.repeat(W - 2)}`);
  L.push(
    `  ${pad('', 46)}${lpad('', 7)}${lpad('', 7)}${lpad('', 7)}${lpad('', 6)}${lpad('ms', 9)}${lpad('ms', 9)}${lpad('ms', 9)}`,
  );
  L.push('');
  if (throttled > 0) {
    L.push(
      `  NOTE  ${throttled} response(s) were 429. /auth/refresh is capped at 30 req/min PER IP`,
    );
    L.push(
      '        (REFRESH_RATE_LIMIT) and does NOT honour RATE_LIMIT_RELAXED_CAPS, so every VU on',
    );
    L.push('        this host shares one budget. The limiter working, not the endpoint failing.');
    L.push('');
  }

  const reqs = m.http_reqs ? m.http_reqs.values.count : 0;
  const jc = m.journey_complete;
  const jd = m.journey_duration;
  const dur = m.http_req_duration;
  const failed = m.http_req_failed;

  L.push(`  ${'-'.repeat(W - 2)}`);
  L.push('  SUMMARY');
  L.push(`  ${'-'.repeat(W - 2)}`);
  const row = (k, v) => L.push(`  ${pad(k, 34)}${v}`);
  row('DATABASE_POOL_MAX', POOL);
  row('auth mode', AUTH);
  row('users (VUs)', VUS);
  row('routes per user', STEPS.length);
  row('calls expected', VUS * STEPS.length);
  row('calls actually sent', reqs);
  row(
    `users completing all ${STEPS.length}`,
    jc ? `${jc.values.passes} of ${jc.values.passes + jc.values.fails}` : '-',
  );
  row('success rate', jc ? `${(jc.values.rate * 100).toFixed(2)} %` : '-');
  row(
    'time for one user avg/p95',
    jd ? `${ms(jd.values.avg)} / ${ms(jd.values['p(95)'])} ms` : '-',
  );
  row('per-call avg/p95', dur ? `${ms(dur.values.avg)} / ${ms(dur.values['p(95)'])} ms` : '-');
  row('http_req_failed', failed ? `${(failed.values.rate * 100).toFixed(2)} %` : '-');
  L.push('');
  L.push('='.repeat(W));
  L.push('');

  const text = L.join('\n');
  const tag = __ENV.RESULT_TAG || `vus-${VUS}`;
  return { stdout: text, [`/tmp/k6-journey-${tag}.txt`]: text };
}
