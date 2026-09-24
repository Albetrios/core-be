import http from 'k6/http';
import { sleep } from 'k6';
import { API_PREFIX, THRESHOLDS, SCENARIOS } from '../helpers/config.js';
import { checkResponseTime, checkStatus } from '../helpers/checks.js';
import { authHeaders } from '../helpers/auth.js';

export const options = {
  scenarios: {
    load: { ...SCENARIOS.load, exec: 'userDataExportOps' },
  },
  thresholds: {
    ...THRESHOLDS,
    'http_req_duration{name:user-data-export-status}': ['p(95)<500', 'p(99)<1000'],
  },
};

/**
 * A user may have one export in flight, so requesting one per iteration measured nothing but the
 * 409 that rule answers (99% "failures"). Request it once, then load the read a client polls.
 */
export function setup() {
  const token = __ENV.TEST_TOKEN;
  if (!token) return { dataExportId: null };
  const response = http.post(`${API_PREFIX}/users/me/data-export`, JSON.stringify({}), {
    ...authHeaders(token),
    tags: { name: 'user-data-export-request' },
    responseCallback: http.expectedStatuses(200, 409),
  });
  const body = response.status === 200 ? JSON.parse(response.body) : null;
  return { dataExportId: body?.data?.id ?? null };
}

export function userDataExportOps(data) {
  const token = __ENV.TEST_TOKEN;
  if (!(token && data?.dataExportId)) return;

  const response = http.get(`${API_PREFIX}/users/me/data-export/${data.dataExportId}`, {
    ...authHeaders(token),
    tags: { name: 'user-data-export-status' },
  });
  checkStatus(response, 200, 'user-data-export-status');
  checkResponseTime(response, 500, 'user-data-export-status');
  sleep(1);
}

export default userDataExportOps;
