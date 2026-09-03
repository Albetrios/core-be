#!/usr/bin/env node
// Dashboards hub + authenticating reverse proxy (part of tooling/dev/dashboards/).
//
// Serves the single-page control-room hub at http://localhost:3010/ and proxies the gated
// dashboards so they open in any browser: a browser can't attach an `Authorization: Bearer`
// header to a plain navigation, so this proxy injects the metrics scrape token and a
// self-refreshing super_admin JWT and forwards to the API. It also serves /_status (live
// health + latency), /_worker/* (worker readiness/metrics), and the vendored Tailwind engine
// at /_hub/tw.js, and strips frame-blocking headers so dashboards can be embedded if wanted.
//
//   pnpm dashboards:proxy        (or: node tooling/dev/dashboards/proxy.mjs)
//     → http://localhost:3010/                the hub (status, queues, metrics, links)
//     → http://localhost:3010/admin/queues    Bull Board (super_admin JWT injected, refreshed)
//     → http://localhost:3010/metrics         Prometheus (METRICS_SCRAPE_TOKEN injected)
//     → http://localhost:3010/reference/      Scalar API docs (public)
//
// The hub UI is ./hub.html (read per request — edit it live, no restart).
//
// It can also front a DEPLOYED environment (the API is reached over HTTPS; the worker health
// server, SonarQube and Drizzle Studio are local-only and are reported as unavailable):
//
//   pnpm dashboards:proxy:development   → http://localhost:3011/  (development on Railway)
//
// Env (optional): PROXY_PORT (3010), TARGET_ENV (local — names the `.env.<TARGET_ENV>` file that
//                 supplies PORT and METRICS_SCRAPE_TOKEN), API_ORIGIN (http://127.0.0.1:<PORT> —
//                 any origin, e.g. the development deployment's public https origin), API_PORT
//                 (local port shortcut), DEMO_EMAIL, DEMO_PASSWORD (a super_admin on the target).
//                 METRICS_SCRAPE_TOKEN in the process env wins over the env file.
//
// HOSTED mode (Dockerfile.dashboards — one small Railway service next to api/worker):
//   HUB_BIND=0.0.0.0 makes it reachable beyond loopback, and then HUB_AUTH="user:password" is
//   REQUIRED — the proxy refuses to start without it, because it hands every visitor a
//   super_admin Bull Board session and the metrics token. Every request is HTTP basic-auth
//   checked except GET /_health (the platform health check). Vendored assets missing from the
//   image fall back to their CDN.

import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HUB_HTML_PATH = join(ROOT, 'tooling/dev/dashboards/hub.html');
const TW_PATH = join(ROOT, 'tooling/dev/dashboards/tailwind.js');
const GRIDSTACK_JS_PATH = join(ROOT, 'tooling/dev/dashboards/gridstack.js');
const GRIDSTACK_CSS_PATH = join(ROOT, 'tooling/dev/dashboards/gridstack.css');

// Which `.env.<name>` supplies PORT + METRICS_SCRAPE_TOKEN: `local` (default) for the Compose
// stack, `development` / `production` for a deployed target (same files `pnpm github:sync` pushes).
const TARGET_ENV = process.env.TARGET_ENV || 'local';
const ENV_FILE_PATH = join(ROOT, `.env.${TARGET_ENV}`);

function envVal(key) {
  try {
    const line = readFileSync(ENV_FILE_PATH, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : '';
  } catch {
    return '';
  }
}

const LOCAL_HOST = '127.0.0.1';
const API_ORIGIN = new URL(
  process.env.API_ORIGIN ||
    `http://${LOCAL_HOST}:${Number(process.env.API_PORT || envVal('PORT') || 3000)}`,
);
const API_IS_HTTPS = API_ORIGIN.protocol === 'https:';
// Request options shared by every call to the API target (http or https picked by protocol).
const API_TARGET = {
  protocol: API_ORIGIN.protocol,
  host: API_ORIGIN.hostname,
  port: Number(API_ORIGIN.port || (API_IS_HTTPS ? 443 : 80)),
};
const API_IS_LOCAL = [LOCAL_HOST, 'localhost', '::1'].includes(API_ORIGIN.hostname);
const PROXY_PORT = Number(process.env.PROXY_PORT || process.env.PORT || 3010);
// Process env first (hosted: Railway service variables), then the `.env.<TARGET_ENV>` file (local).
const METRICS_TOKEN = process.env.METRICS_SCRAPE_TOKEN || envVal('METRICS_SCRAPE_TOKEN');

// Hosted mode: bind beyond loopback only behind a mandatory basic-auth login.
const HUB_BIND = process.env.HUB_BIND || LOCAL_HOST;
const HUB_IS_LOOPBACK = [LOCAL_HOST, 'localhost', '::1'].includes(HUB_BIND);
const HUB_AUTH = process.env.HUB_AUTH || '';
if (!(HUB_IS_LOOPBACK || HUB_AUTH.includes(':'))) {
  process.stderr.write(
    `\n  ✗ HUB_BIND=${HUB_BIND} exposes the hub beyond loopback — set HUB_AUTH="user:password" first.\n` +
      '    The hub injects a super_admin session and the metrics token into every request; it must\n' +
      '    never be reachable without its own login.\n\n',
  );
  process.exit(1);
}
const EXPECTED_AUTH = HUB_AUTH
  ? Buffer.from(`Basic ${Buffer.from(HUB_AUTH).toString('base64')}`)
  : null;
const CDN_FALLBACKS = {
  '/_hub/tw.js': 'https://cdn.tailwindcss.com',
  '/_hub/gridstack.js': 'https://cdn.jsdelivr.net/npm/gridstack@11/dist/gridstack-all.min.js',
  '/_hub/gridstack.css': 'https://cdn.jsdelivr.net/npm/gridstack@11/dist/gridstack.min.css',
};
// The super_admin this proxy logs in as to mint the Bull Board JWT. `dashboards:up` ensures
// this user via `pnpm db:seed:demo-admin` — keep these defaults in sync with that script
// (src/scripts/seed/ensure-demo-admin.ts) so the seeded password matches what we submit here.
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@example.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoPassword123!';
const WORKER_PORT = 9090;
const SONAR_PORT = 9000;
const STUDIO_PORT = 4983;

// Headers that would stop a dashboard from rendering inside the hub's <iframe>. Stripped on
// proxied responses — this is a localhost-only dev proxy, so relaxing them is intentional.
const FRAME_BLOCK_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
];

let adminToken = null;

function upstream(options, body) {
  const client = options.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 502,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
    if (body?.length) req.write(body);
    req.end();
  });
}

async function login() {
  const res = await upstream(
    {
      ...API_TARGET,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', 'x-captcha-bypass': 'true' },
    },
    Buffer.from(JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD })),
  );
  let token = null;
  try {
    const data = JSON.parse(res.body.toString());
    token = data?.data?.access_token ?? data?.access_token ?? null;
  } catch {
    /* fall through to error below */
  }
  if (!token) {
    throw new Error(`login failed (status ${res.status}): ${res.body.toString().slice(0, 200)}`);
  }
  adminToken = token;
  return token;
}

function isMetricsPath(path) {
  return path === '/metrics' || path.startsWith('/metrics?');
}

function isQueueDashboardPath(path) {
  return (
    path === '/admin/queues' ||
    path.startsWith('/admin/queues/') ||
    path.startsWith('/admin/queues?')
  );
}

function isHubPath(path) {
  return path === '/' || path === '/dashboards' || path === '/dashboards/';
}

function stripFrameHeaders(headers) {
  const out = { ...headers };
  delete out['content-encoding'];
  delete out['content-length'];
  for (const key of FRAME_BLOCK_HEADERS) delete out[key];
  return out;
}

/** Request options for a local-only sidecar (worker health server, SonarQube, Drizzle Studio). */
function localTarget(port) {
  return { protocol: 'http:', host: LOCAL_HOST, port };
}

/** GET a path on a target; resolve { code, ms } (code 0 on error/timeout). */
function probe(target, path, bearer) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const elapsed = () => Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        ...target,
        path,
        method: 'GET',
        timeout: 2500,
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      },
      (res) => {
        res.resume();
        resolve({ code: res.statusCode ?? 0, ms: elapsed() });
      },
    );
    req.on('error', () => resolve({ code: 0, ms: elapsed() }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ code: 0, ms: 2500 });
    });
    req.end();
  });
}

let statusCache = null;
let statusCacheAt = 0;

/**
 * Server-side health (+latency) of every dashboard target — no browser CORS limits.
 * Cached for 3s so several open hub tabs polling at once don't trip the API rate limiter.
 */
async function probeAll() {
  if (statusCache && Date.now() - statusCacheAt < 3000) return statusCache;
  let token = adminToken;
  if (!token) {
    try {
      token = await login();
    } catch {
      token = null;
    }
  }
  // The worker health server, SonarQube and Drizzle Studio only exist next to a LOCAL API —
  // against a deployed target they are not probed and are left out of the status (the hub
  // renders a missing key as "unavailable" rather than "down").
  const sidecar = (port, path) =>
    API_IS_LOCAL ? probe(localTarget(port), path) : Promise.resolve(null);
  const [api, reference, bullboard, metrics, worker, sonar, drizzle] = await Promise.all([
    probe(API_TARGET, '/livez'),
    probe(API_TARGET, '/reference/'),
    probe(API_TARGET, '/admin/queues', token),
    probe(API_TARGET, '/metrics', METRICS_TOKEN),
    sidecar(WORKER_PORT, '/readyz'),
    sidecar(SONAR_PORT, '/api/system/status'),
    sidecar(STUDIO_PORT, '/'),
  ]);
  const ok = (c) => c >= 200 && c < 400;
  const entry = (p, anyResponse) =>
    p ? { up: anyResponse ? p.code > 0 : ok(p.code), ms: p.ms } : undefined;
  statusCache = {
    target: { env: TARGET_ENV, origin: API_ORIGIN.origin, local: API_IS_LOCAL },
    api: entry(api),
    reference: entry(reference),
    bullboard: entry(bullboard),
    metrics: entry(metrics),
    worker: entry(worker),
    sonar: entry(sonar),
    drizzle: entry(drizzle, true),
  };
  statusCacheAt = Date.now();
  return statusCache;
}

function readHub() {
  try {
    return readFileSync(HUB_HTML_PATH, 'utf8');
  } catch {
    return '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">Hub file missing: tooling/dev/dashboards/hub.html</body>';
  }
}

function sendError(res, error) {
  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ proxy_error: String(error?.message || error) }));
}

async function serveStatus(res) {
  const status = await probeAll();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status));
}

async function serveWorker(res, path) {
  if (!API_IS_LOCAL) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        proxy_error: `worker health server is local-only — not reachable for ${API_ORIGIN.origin}`,
      }),
    );
    return;
  }
  const workerPath = path.slice('/_worker'.length) || '/';
  const headers =
    workerPath.startsWith('/metrics') && METRICS_TOKEN
      ? { authorization: `Bearer ${METRICS_TOKEN}` }
      : {};
  const r = await upstream({
    ...localTarget(WORKER_PORT),
    method: 'GET',
    path: workerPath,
    headers,
  });
  res.writeHead(r.status, stripFrameHeaders(r.headers));
  res.end(r.body);
}

// Forward to the API with the right token injected, re-logging in once on a 401.
async function serveProxy(clientReq, res, path, reqBody) {
  const metrics = isMetricsPath(path);
  const forward = (bearer) => {
    const headers = { ...clientReq.headers, host: API_ORIGIN.host };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    delete headers['accept-encoding']; // keep upstream responses uncompressed for simple piping
    return upstream({ ...API_TARGET, method: clientReq.method, path, headers }, reqBody);
  };
  // Only Bull Board needs the super_admin JWT; public pages (Scalar /reference/, /livez …) are
  // forwarded as-is so a failed login (no demo user on a deployed target) cannot 502 them.
  const needsAdmin = isQueueDashboardPath(path);
  const bearer = metrics ? METRICS_TOKEN : needsAdmin ? adminToken || (await login()) : null;
  let response = await forward(bearer);
  if (needsAdmin && response.status === 401) {
    await login();
    response = await forward(adminToken);
  }
  res.writeHead(response.status, stripFrameHeaders(response.headers));
  res.end(response.body);
}

async function handleRequest(clientReq, res, reqBody) {
  const path = clientReq.url || '/';
  if (clientReq.method === 'GET' && isHubPath(path)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readHub());
    return;
  }
  if (clientReq.method === 'GET' && path in CDN_FALLBACKS) {
    // Vendored copies are gitignored; when absent (fresh clone, hosted image built offline)
    // send the browser to the CDN the file was vendored from instead of breaking the page.
    const isCss = path.endsWith('.css');
    const filePath =
      path === '/_hub/tw.js' ? TW_PATH : isCss ? GRIDSTACK_CSS_PATH : GRIDSTACK_JS_PATH;
    let asset;
    try {
      asset = readFileSync(filePath);
    } catch {
      res.writeHead(302, { location: CDN_FALLBACKS[path], 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': isCss ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    });
    res.end(asset);
    return;
  }
  if (clientReq.method === 'GET' && path === '/_status') return serveStatus(res);
  if (clientReq.method === 'GET' && path.startsWith('/_worker/')) return serveWorker(res, path);
  return serveProxy(clientReq, res, path, reqBody);
}

/** True when the request carries the `HUB_AUTH` basic credentials (constant-time compare). */
function isAuthorized(clientReq) {
  if (!EXPECTED_AUTH) return true;
  const presented = Buffer.from(clientReq.headers.authorization || '');
  return presented.length === EXPECTED_AUTH.length && timingSafeEqual(presented, EXPECTED_AUTH);
}

const server = http.createServer((clientReq, clientRes) => {
  const path = clientReq.url || '/';
  // Platform health check — the only route that skips the login (it reveals nothing).
  if (clientReq.method === 'GET' && path === '/_health') {
    clientRes.writeHead(200, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ status: 'ok', target: API_ORIGIN.origin, env: TARGET_ENV }));
    return;
  }
  if (!isAuthorized(clientReq)) {
    clientRes.writeHead(401, {
      'www-authenticate': 'Basic realm="control room", charset="UTF-8"',
      'content-type': 'text/plain',
    });
    clientRes.end('login required');
    return;
  }
  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', () => {
    handleRequest(clientReq, clientRes, Buffer.concat(chunks)).catch((error) =>
      sendError(clientRes, error),
    );
  });
});

server.listen(PROXY_PORT, HUB_BIND, () => {
  const base = `http://localhost:${PROXY_PORT}`;
  process.stdout.write(
    `\n  Dashboards hub → ${base}/   (tabbed control room · live status)\n` +
      `  Auth proxy     → ${base}    (→ API ${API_ORIGIN.origin} · env ${TARGET_ENV} · tokens from .env.${TARGET_ENV})\n` +
      (HUB_IS_LOOPBACK
        ? ''
        : `  Hosted mode    → bound to ${HUB_BIND}, basic-auth login "${HUB_AUTH.split(':')[0]}" required on every route except /_health\n`) +
      '\n' +
      (METRICS_TOKEN
        ? ''
        : `  ! METRICS_SCRAPE_TOKEN is empty in .env.${TARGET_ENV} — /metrics may already be open.\n`) +
      (API_IS_LOCAL
        ? ''
        : '  ! remote target — worker health, SonarQube and Drizzle Studio are local-only (shown as unavailable).\n'),
  );
});
