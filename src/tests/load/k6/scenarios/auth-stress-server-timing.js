import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE_URL, API_PREFIX } from '../helpers/config.js';
import { authHeaders } from '../helpers/auth.js';

/**
 * Authenticated stress that ramps to `MAX_VUS` (default 100) and records the server-side processing
 * time from the `Server-Timing: app;dur=<ms>` response header as a custom Trend, so the summary
 * separates true server latency from network round-trip. Requires TEST_TOKEN (+ optional
 * TEST_ORG_ID) and BASE_URL. Set MAX_VUS to scale (e.g. MAX_VUS=1000 for a 10x run).
 */
const serverSideMs = new Trend('server_side_ms', true);
const MAX_VUS = Number.parseInt(__ENV.MAX_VUS || '100', 10);
const RAMP_UP = __ENV.RAMP_UP || '30s';
const HOLD = __ENV.HOLD || '0s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '30s';

const stages = [{ duration: RAMP_UP, target: MAX_VUS }];
if (HOLD !== '0s') stages.push({ duration: HOLD, target: MAX_VUS });
stages.push({ duration: RAMP_DOWN, target: 0 });

export const options = {
  scenarios: {
    authStress: { executor: 'ramping-vus', startVUs: 0, stages, exec: 'run' },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    server_side_ms: ['p(95)<300', 'p(99)<500'],
  },
};

function recordServerTiming(response, name) {
  const header = response.headers['Server-Timing'] || response.headers['server-timing'];
  if (!header) return;
  const match = String(header).match(/dur=([\d.]+)/);
  if (match) serverSideMs.add(Number.parseFloat(match[1]), { name });
}

export function run() {
  const token = __ENV.TEST_TOKEN;
  if (!token) return;
  const options_ = (name) => ({ ...authHeaders(token), tags: { name } });

  const endpoints = [
    ['users-me', `${API_PREFIX}/users/me`],
    ['organizations', `${API_PREFIX}/users/me/organizations`],
    ['notifications', `${API_PREFIX}/notify/notifications`],
    ['unread-count', `${API_PREFIX}/notify/notifications/unread-count`],
  ];

  for (const [name, url] of endpoints) {
    const response = http.get(url, options_(name));
    check(response, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
    recordServerTiming(response, name);
  }

  // touch the URL var so lint doesn't flag the import when unused on some paths
  void BASE_URL;
  sleep(0.5);
}

export default run;
