import { describe, it } from 'vitest';
import { smokeFetch, smokeLogin } from '@/tests/smoke/helpers/smoke-client.js';

describe('Smoke: tenancy', () => {
  it('GET /api/v1/users/me/organizations returns 200', async () => {
    const { accessToken } = await smokeLogin();
    await smokeFetch('/api/v1/users/me/organizations', {
      headers: { authorization: `Bearer ${accessToken}` },
      expectStatus: 200,
    });
  });
});
