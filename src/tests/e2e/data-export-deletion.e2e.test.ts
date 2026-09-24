import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { database } from '@/infrastructure/database/connection.js';
import { user_data_exports } from '@/domains/user/sub-domains/user-data-export/user-data-export.schema.js';
import type { FastifyInstance } from 'fastify';

describe('Cross-domain e2e: data export and deletion', () => {
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

  it('requests data export then deletes account', async () => {
    const user = await createTestUser();
    const token = await generateTestToken({ userId: user.public_id });

    const exportResponse = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/users/me/data-export'),
      token,
      payload: {},
    });
    expect(exportResponse.statusCode).toBe(200);
    const exportBody = exportResponse.json() as { data?: { id?: string; status?: string } };
    expect(exportBody.data?.status).toBe('pending');
    expect(exportBody.data?.id).toBeTruthy();

    const deleteResponse = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath('/users/me'),
      token,
    });
    // DELETE is 204 under the uniform method→status policy (a CLAUDE.md non-negotiable);
    // accepting 200 too would let a policy-violating regression pass this cross-domain guard.
    expect(deleteResponse.statusCode).toBe(204);

    const exportRows = await database
      .select({ id: user_data_exports.id })
      .from(user_data_exports)
      .where(eq(user_data_exports.user_id, user.id));
    expect(exportRows).toHaveLength(0);
    // Account deletion runs synchronous cross-domain offboarding (sessions, credentials, uploads,
    // data-export purge incl. S3) while the just-requested export is still generating, so it
    // legitimately takes a few seconds; the default 5s timeout flakes under the parallel db-bound
    // lane's load.
  }, 15_000);
});
