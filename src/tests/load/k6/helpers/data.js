import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

/**
 * Generate random test data for load tests.
 */
export function randomOrganization() {
  const suffix = randomString(8);
  return {
    name: `Load Test Org ${suffix}`,
    slug: `load-test-${suffix}`,
  };
}

export function randomEmail() {
  return `loadtest-${randomString(8)}@k6.test`;
}

export function randomWebhook(organizationPublicId) {
  return {
    url: `https://httpbin.org/post?organization=${organizationPublicId}`,
    events: ['*'],
    description: `k6 test webhook ${randomString(6)}`,
  };
}
