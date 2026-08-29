import { describe, it } from 'vitest';
import { smokeFetch, smokeLogin } from '@/tests/smoke/helpers/smoke-client.js';

describe('Smoke: notify', () => {
  it('lists organizations then webhooks without 5xx', async () => {
    // Flat webhook routes resolve the organization from the JWT `org` claim,
    // which the login flow embeds (the user's default active organization). There is no
    // longer an organization path segment or `x-organization-id` header — a 200
    // (has webhook:read) or 403 (lacks it) both prove the route is reachable
    // without a 5xx.
    const { accessToken } = await smokeLogin();
    await smokeFetch('/api/v1/tenancy/organizations', {
      headers: { authorization: `Bearer ${accessToken}` },
      expectStatus: 200,
    });

    await smokeFetch('/api/v1/notify/webhooks', {
      headers: { authorization: `Bearer ${accessToken}` },
      expectStatus: [200, 403],
    });
  });
});
