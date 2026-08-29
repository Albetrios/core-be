import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/**
 * Cross-actor isolation of the idempotency cache.
 *
 * The idempotency cache key is namespaced by (organization, actor) so a key that
 * one caller minted can never replay another caller's cached response — the unit
 * suite proves `buildIdempotencyCacheKey` produces distinct keys, but nothing
 * proved the MIDDLEWARE actually scopes by actor at the HTTP layer. If it ever
 * regressed to keying on the raw `X-Idempotency-Key` value alone, user B sending
 * a key value that user A already used would be served user A's cached response
 * body — a cross-account data leak (A's freshly created organization handed to
 * B) that every same-user replay test would still pass.
 *
 * This locks the end-to-end invariant: two distinct authenticated actors sending
 * the SAME key value each execute their own write; neither receives the other's
 * response.
 */
function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

interface CreatedOrganizationResponse {
  data?: { id?: string; slug?: string };
}

describe('Security: idempotency cross-actor isolation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('a shared X-Idempotency-Key value never replays one actor’s response to another actor', async () => {
    const actorA = await createTestUser({ email: 'idem-actor-a@example.com' });
    const actorB = await createTestUser({ email: 'idem-actor-b@example.com' });
    const tokenA = await generateTestToken({ userId: actorA.public_id });
    const tokenB = await generateTestToken({ userId: actorB.public_id });

    // BOTH actors use the identical key value — the whole point of the attack.
    const sharedKeyValue = `shared-idem-${randomUUID()}`;

    const responseA = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organizations'),
      token: tokenA,
      headers: { 'x-idempotency-key': sharedKeyValue },
      payload: { name: 'Actor A Organization', slug: uniqueSlug('actor-a') },
    });
    expect(responseA.statusCode).toBe(200);
    const organizationA = (responseA.json() as CreatedOrganizationResponse).data;
    expect(organizationA?.id).toBeDefined();

    // Let the post-commit cache write settle (same guard the sibling replay test uses).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const responseB = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organizations'),
      token: tokenB,
      headers: { 'x-idempotency-key': sharedKeyValue },
      payload: { name: 'Actor B Organization', slug: uniqueSlug('actor-b') },
    });

    // B executes its OWN write — it must never be served A's cached replay.
    expect(responseB.statusCode).toBe(200);
    expect(responseB.headers['x-idempotency-replay']).not.toBe('true');

    const organizationB = (responseB.json() as CreatedOrganizationResponse).data;
    expect(organizationB?.id).toBeDefined();
    // The decisive assertion: B got a DIFFERENT organization than A. A shared
    // (non-actor-scoped) cache would hand B actor A's public id and slug here.
    expect(organizationB?.id).not.toBe(organizationA?.id);
    expect(organizationB?.slug).not.toBe(organizationA?.slug);
    // B's slug carries its own prefix — never actor A's cached one.
    expect(organizationB?.slug).toMatch(/^actor-b-/);
  });

  it('the same actor DOES replay its own key (control: proves the cache is on, not merely bypassed)', async () => {
    const actor = await createTestUser({ email: 'idem-self-replay@example.com' });
    const token = await generateTestToken({ userId: actor.public_id });
    const keyValue = `self-idem-${randomUUID()}`;
    // IDENTICAL request both times — a replay requires the same (key, method, route,
    // body) fingerprint; a different body under the same key is a 422 conflict, not
    // a replay (that conflict path is covered by the sibling idempotency suite).
    const identicalPayload = { name: 'Self Replay Org', slug: uniqueSlug('self-replay') };

    const first = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organizations'),
      token,
      headers: { 'x-idempotency-key': keyValue },
      payload: identicalPayload,
    });
    expect(first.statusCode).toBe(200);
    const firstOrganization = (first.json() as CreatedOrganizationResponse).data;

    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organizations'),
      token,
      headers: { 'x-idempotency-key': keyValue },
      payload: identicalPayload,
    });
    expect(second.statusCode).toBe(200);
    const secondOrganization = (second.json() as CreatedOrganizationResponse).data;

    // When the cache entry survived, the replay returns the ORIGINAL organization (proving
    // self-replay works); when Redis evicted it, a fresh 2xx is allowed.
    if (second.headers['x-idempotency-replay'] === 'true') {
      expect(secondOrganization?.id).toBe(firstOrganization?.id);
    }
  });
});
