import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateSuperAdminToken } from '@/tests/helpers/test-auth.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import type { FastifyInstance } from 'fastify';

type PaginatedBody<T> = {
  data: T[];
  meta?: { pagination?: { next: string | null; has_more: boolean } };
};

describe('Cursor pagination — integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('GET /organizations pages forward with after cursor', async () => {
    const owner = await createTestUser();
    const token = await generateSuperAdminToken(owner.public_id);
    await createTestOrganization({ ownerUserId: owner.id, name: 'Org Alpha' });
    await createTestOrganization({ ownerUserId: owner.id, name: 'Org Beta' });

    const firstPage = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/users/me/organizations'),
      token,
      query: { limit: '1' },
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as PaginatedBody<{ id: string }>;
    expect(firstBody.data).toHaveLength(1);
    expect(firstBody.meta?.pagination?.has_more).toBe(true);
    const nextCursor = firstBody.meta?.pagination?.next;
    expect(nextCursor).toBeTruthy();

    const secondPage = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/users/me/organizations'),
      token,
      query: { limit: '1', after: nextCursor ?? '' },
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json() as PaginatedBody<{ id: string }>;
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.data[0]?.id).not.toBe(firstBody.data[0]?.id);
  });

  it('GET /organizations rejects legacy page query parameter with a clear cursor-only message', async () => {
    const owner = await createTestUser();
    const token = await generateSuperAdminToken(owner.public_id);
    await createTestOrganization({ ownerUserId: owner.id });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/users/me/organizations'),
      token,
      query: { page: '1', limit: '10' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: {
        type: string;
        detail: string;
        errors?: Array<{ field: string; message: string }>;
      };
    };
    expect(body.error.type).toBe('validation_error');
    expect(body.error.detail).toMatch(/cursor-based pagination/i);
    expect(body.error.errors).toEqual([
      expect.objectContaining({ field: 'page', message: expect.stringMatching(/cursor/i) }),
    ]);
  });
});
