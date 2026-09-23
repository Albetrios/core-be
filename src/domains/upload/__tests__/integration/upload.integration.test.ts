import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { buildIdempotencyCacheKey } from '@/shared/utils/idempotency/idempotency-key.util.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { database } from '@/infrastructure/database/connection.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/** Bucket recorded on seeded rows; asserted to be absent from the detail response body. */
const SEEDED_BUCKET = 'test-uploads';

describe('Upload Domain — Integration', () => {
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

  /**
   * Inserts an already-`UPLOADED` upload row directly. The read and re-confirm paths never
   * touch object storage, so seeding the terminal state is both sufficient and cheaper than
   * walking request → confirm behind a mocked S3 port.
   */
  async function seedUploadedRow(
    userInternalId: number,
  ): Promise<{ id: number; publicId: string; fileKey: string }> {
    const publicId = generatePublicId('upload');
    const fileKey = `avatars/${publicId}/verified.png`;
    const [seeded] = await database
      .insert(uploads)
      .values({
        public_id: publicId,
        user_id: userInternalId,
        organization_id: null,
        file_name: 'verified.png',
        file_key: fileKey,
        mime_type: 'image/png',
        file_size: 1024,
        storage_provider: 's3',
        bucket: SEEDED_BUCKET,
        status: 'UPLOADED',
        metadata: { purpose: 'AVATAR', target: 'USER' },
        uploaded_at: new Date(),
      })
      .returning();
    return { id: seeded!.id, publicId, fileKey };
  }

  describe('POST /api/v1/uploads', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/uploads'),
        payload: {},
        // POST /uploads is idempotencyRequired; without a key the global onRequest hook returns 422
        // before auth. Supply one so this exercises the auth 401 it intends to assert.
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 400 for missing upload data', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/uploads'),
        token: token,
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('should return 400 for invalid purpose enum', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/uploads'),
        token: token,
        payload: {
          purpose: 'invalid-purpose',
          for: 'user',
          content_type: 'image/png',
          file_name: 'avatar.png',
          file_size: 1024,
        },
      });
      expect(response.statusCode, response.body).toBe(400);
    });
  });

  describe('GET /api/v1/uploads/:publicId', () => {
    const unknownUploadPublicId = 'upl_abcdefghijklmnopqrstu';

    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`/uploads/${unknownUploadPublicId}`),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 200 with the upload detail for its owner', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const { publicId } = await seedUploadedRow(user.id);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/uploads/${publicId}`),
        token,
      });

      expect(response.statusCode, response.body).toBe(200);
      const data = (response.json() as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        id: publicId,
        file_name: 'verified.png',
        mime_type: 'image/png',
        file_size: 1024,
        status: 'UPLOADED',
        storage_provider: 's3',
        organization_id: null,
      });
    });

    it('should omit the internal storage key and bucket from the detail body', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const { publicId, fileKey } = await seedUploadedRow(user.id);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/uploads/${publicId}`),
        token,
      });

      expect(response.statusCode, response.body).toBe(200);
      const data = (response.json() as { data: Record<string, unknown> }).data;
      // Storage layout is internal: the client attaches via the create-time `key` and reads
      // via presigned URLs, never the raw path. Leaking either invites bucket enumeration.
      expect(data).not.toHaveProperty('key');
      expect(data).not.toHaveProperty('file_key');
      expect(data).not.toHaveProperty('bucket');
      expect(response.body).not.toContain(fileKey);
      expect(response.body).not.toContain(SEEDED_BUCKET);
    });

    it('should return 404 for unknown upload', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/uploads/${unknownUploadPublicId}`),
        token: token,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/v1/uploads/:publicId', () => {
    const unknownUploadPublicId = 'upl_abcdefghijklmnopqrstu';

    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/uploads/${unknownUploadPublicId}`),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 404 for unknown upload', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/uploads/${unknownUploadPublicId}`),
        token: token,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/v1/uploads/:publicId/confirm (route-coverage gap-fill)', () => {
    const unknownUploadPublicId = 'upl_abcdefghijklmnopqrstu';

    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(`/uploads/${unknownUploadPublicId}/confirm`),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 404 for unknown upload public_id', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/uploads/${unknownUploadPublicId}/confirm`),
        token,
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    });

    it('is idempotent: re-confirming an already-UPLOADED row returns 200 without S3 calls', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const { id, publicId } = await seedUploadedRow(user.id);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/uploads/${publicId}/confirm`),
        token,
        payload: {},
      });
      expect(response.statusCode).toBe(200);

      const [postCall] = await database.select().from(uploads).where(eq(uploads.id, id));
      expect(postCall!.status).toBe('UPLOADED');
    });
  });

  /**
   * `POST /uploads` is the only `idempotencyRequired` route in this domain, but the
   * middleware's own suite (`idempotency.security.test.ts`) exercises it exclusively against
   * `/tenancy/organizations`. These cases pin the contract at this route.
   *
   * Both use a raw `app.inject` on purpose: `injectAuthenticated` auto-supplies a fresh
   * `X-Idempotency-Key` for exactly this path, which would route straight past the hook
   * under test.
   */
  describe('POST /api/v1/uploads — idempotency contract', () => {
    const validAvatarPayload = {
      purpose: 'avatar',
      for: 'user',
      content_type: 'image/png',
      file_name: 'avatar.png',
      file_size: 1024,
    };

    it('should return 422 when X-Idempotency-Key is missing', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });

      const response = await app.inject({
        method: 'POST',
        url: testApiPath('/uploads'),
        headers: { authorization: `Bearer ${token}` },
        payload: validAvatarPayload,
      });

      expect(response.statusCode, response.body).toBe(422);
    });

    /**
     * CHARACTERIZATION — this pins today's behavior, which is NOT replay protection.
     *
     * The presign response carries `upload_url` and a SigV4 `Policy`/`X-Amz-Signature`, so
     * `responseBodyContainsSecretFields` refuses to cache it
     * (`idempotency.cache.secret_response_skipped`). With no completed entry stashed,
     * `idempotencyOnResponse` takes its release branch and DELETEs the placeholder — leaving
     * no record of the key at all.
     *
     * Consequence: the key is mandatory (see the 422 above) but spent-and-forgotten. A client
     * that retries after a timeout mints a SECOND upload row and burns another
     * `UPLOAD_MAX_PENDING_PER_USER` slot, and the divergent-payload guard never fires either.
     * Only the in-flight window is protected.
     *
     * If that is later judged a defect, this test should flip — deliberately, not silently.
     */
    it('does not replay a reused key: the presign response is never cached (characterization)', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const headers = {
        authorization: `Bearer ${token}`,
        'x-idempotency-key': `idem-${randomUUID()}`,
      };

      const first = await app.inject({
        method: 'POST',
        url: testApiPath('/uploads'),
        headers,
        payload: validAvatarPayload,
      });
      expect(first.statusCode, first.body).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: testApiPath('/uploads'),
        headers,
        payload: validAvatarPayload,
      });
      expect(second.statusCode, second.body).toBe(200);

      const idOf = (raw: string): string => (JSON.parse(raw) as { data: { id: string } }).data.id;
      // A replay would return the first id byte-for-byte; a fresh execution mints a new row.
      expect(idOf(second.body)).not.toBe(idOf(first.body));
      const rows = await database.select().from(uploads).where(eq(uploads.user_id, user.id));
      expect(rows).toHaveLength(2);
    });

    it('returns 409 conflict_in_flight while the same key is mid-flight — the one window that IS protected', async () => {
      // The characterization above proves a COMPLETED request's key is spent-and-forgotten.
      // This is the other half of that finding: DURING flight the placeholder exists, so a
      // concurrent retry gets 409 (retry the same key shortly) rather than minting a second
      // upload row. Deterministic per the billing-idempotency-replay pattern: seed the exact
      // in-flight placeholder the preHandler writes, then issue one request.
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const idempotencyKey = `idem-${randomUUID()}`;
      // No organization in the token -> the middleware scopes the key as `none:<userId>`.
      const cacheKey = buildIdempotencyCacheKey(idempotencyKey, { userId: user.public_id });
      await redisConnection.set(
        cacheKey,
        JSON.stringify({
          state: 'in_flight',
          claimedAt: Date.now(),
          requestId: 'req-first-caller',
        }),
        'EX',
        60,
      );

      try {
        const response = await app.inject({
          method: 'POST',
          url: testApiPath('/uploads'),
          headers: { authorization: `Bearer ${token}`, 'x-idempotency-key': idempotencyKey },
          payload: validAvatarPayload,
        });

        expect(response.statusCode, response.body).toBe(409);
        const body = response.json() as { error?: { code?: string } };
        expect(body.error?.code).toBe('conflict_in_flight');
      } finally {
        await redisConnection.del(cacheKey);
      }
    });
  });
});
