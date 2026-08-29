import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  injectAuthenticated,
  injectRoute,
  injectUnauthenticated,
  injectWithCookies,
} from '@/tests/helpers/test-http-inject.helper.js';

describe('test-http-inject.helper', () => {
  it('injectRoute returns status and json body', async () => {
    const application = Fastify();
    application.get('/hello', async () => ({ message: 'ok' }));
    await application.ready();

    const response = await injectRoute(application, { method: 'GET', url: '/hello' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'ok' });

    await application.close();
  });

  it('injectAuthenticated sets Authorization header', async () => {
    const application = Fastify();
    application.get('/protected', async (request) => ({
      authorization: request.headers.authorization,
      organizationHeader: request.headers['x-organization-id'] ?? null,
    }));
    await application.ready();

    const response = await injectAuthenticated(application, {
      method: 'GET',
      url: '/protected',
      token: 'test-token',
      organizationPublicId: 'org_public_id_1234567',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { authorization: string; organizationHeader: string | null };
    expect(body.authorization).toBe('Bearer test-token');
    expect(body.organizationHeader).toBeNull(); // header removed — claim-only

    await application.close();
  });

  it('injectUnauthenticated does not set Authorization', async () => {
    const application = Fastify();
    application.get('/open', async (request) => ({
      authorization: request.headers.authorization ?? null,
    }));
    await application.ready();

    const response = await injectUnauthenticated(application, { method: 'GET', url: '/open' });
    const body = response.json() as { authorization: string | null };
    expect(body.authorization).toBeNull();

    await application.close();
  });

  it('injectWithCookies forwards cookie header', async () => {
    const application = Fastify();
    application.get('/cookie', async (request) => ({
      cookie: request.headers.cookie ?? null,
    }));
    await application.ready();

    const response = await injectWithCookies(application, {
      method: 'GET',
      url: '/cookie',
      cookies: { session_id: 'abc123' },
    });
    const body = response.json() as { cookie: string };
    expect(body.cookie).toContain('session_id=abc123');

    await application.close();
  });
});
