import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import errorHandlerMiddleware from '@/shared/middlewares/core/error-handler.middleware.js';
import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import { AppError, ConflictError, ServiceUnavailableError } from '@/shared/errors/index.js';

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureException: vi.fn(),
}));

const mockedCaptureException = vi.mocked(captureException);

/**
 * Throws whatever the route's query `?case=` selects, so a single app exercises
 * every branch of the error handler. Framework-style errors are plain objects
 * with `statusCode` / `code` (not `AppError`), matching what Fastify emits.
 */
async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest(
    't',
    ((key: string) => `translated:${key}`) as unknown as NonNullable<
      Parameters<typeof app.decorateRequest>[1]
    >,
  );
  await app.register(errorHandlerMiddleware);

  app.get('/app-error-500', async () => {
    throw new AppError(
      'INTERNAL_ERROR',
      500,
      'errors:internal',
      undefined,
      'Internal boom',
    ).withReason('should_not_leak');
  });
  app.get('/app-error-409', async () => {
    throw new ConflictError('errors:conflict', undefined, 'Conflict').withReason(
      'membership_already_exists',
    );
  });
  app.get('/app-error-401', async () => {
    throw new AppError('UNAUTHORIZED', 401, 'errors:unauthorized', undefined, 'Nope');
  });
  app.get('/zod', async () => {
    z.object({ name: z.string().min(1) }).parse({});
  });
  app.post(
    '/fastify-validation',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string' } },
        },
      },
    },
    async () => ({ ok: true }),
  );
  app.get('/framework', async (request) => {
    const status = Number((request.query as { status?: string }).status);
    const code = (request.query as { code?: string }).code;
    const error = new Error('framework error') as Error & { statusCode: number; code?: string };
    error.statusCode = status;
    if (code) error.code = code;
    throw error;
  });
  app.get('/request-timeout', async () => {
    const error = new Error('timed out') as Error & { code: string };
    error.code = 'FST_ERR_REQ_TIMEOUT';
    throw error;
  });
  app.get('/pg-timeout', async () => {
    const error = new Error('canceling statement due to statement timeout') as Error & {
      code: string;
    };
    error.code = '57014';
    throw error;
  });
  app.get('/lock-timeout', async () => {
    // Shape a postgres.js PostgresError: SQLSTATE lives on `code`, and drizzle wraps the driver
    // error in `cause`, which is where the handler's detection has to look.
    const driverError = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    throw Object.assign(new Error('Failed query'), { cause: driverError });
  });

  app.get('/unhandled', async () => {
    throw new Error('unexpected');
  });
  // Carries the FST_ERR_VALIDATION code but NO `validation` array — must NOT be
  // treated as a validation error (the guard requires the array), so it falls
  // through to the masked 500 path.
  app.get('/validation-code-without-array', async () => {
    const error = new Error('not really a validation error') as Error & { code: string };
    error.code = 'FST_ERR_VALIDATION';
    throw error;
  });
  app.post(
    '/instance-path-validation',
    {
      schema: {
        body: {
          type: 'object',
          required: ['age'],
          properties: { age: { type: 'integer' } },
        },
      },
    },
    async () => ({ ok: true }),
  );

  app.get('/app-error-503-retry-after', async () => {
    throw new ServiceUnavailableError().withRetryAfter(5);
  });

  await app.ready();
  return app;
}

describe('error-handler.middleware status + body mapping', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockedCaptureException.mockClear();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('AppError 5xx vs 4xx boundary', () => {
    it('captures a 500 AppError to Sentry, masks its detail, and omits reason', async () => {
      const response = await app.inject({ method: 'GET', url: '/app-error-500' });
      const body = response.json();

      expect(response.statusCode).toBe(500);
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
      // The capture context object carries the request id (not an empty object).
      expect(mockedCaptureException).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requestId: expect.any(String) }),
      );
      // 5xx detail is masked to the generic internal message, never the raw thrown text.
      expect(body.error.detail).toBe('translated:errors:internal');
      expect(body.error.detail).not.toContain('boom');
      // reason is surfaced only on 4xx; a 5xx must not leak it.
      expect(body.error).not.toHaveProperty('reason');
      expect(body.error.type).toBe('request_error');
      expect(body.meta.request_id).toEqual(expect.any(String));
      expect(body.meta.request_id.length).toBeGreaterThan(0);
    });

    it('does NOT capture a 4xx AppError, keeps its real detail, and surfaces reason', async () => {
      const response = await app.inject({ method: 'GET', url: '/app-error-409' });
      const body = response.json();

      expect(response.statusCode).toBe(409);
      expect(mockedCaptureException).not.toHaveBeenCalled();
      expect(body.error.detail).toBe('translated:errors:conflict');
      expect(body.error.reason).toBe('membership_already_exists');
      // A non-validation error carries no `errors` array.
      expect(body.error).not.toHaveProperty('errors');
      expect(response.headers['retry-after']).toBeUndefined();
    });

    it('sends Retry-After when the AppError carries retryAfterSeconds', async () => {
      const response = await app.inject({ method: 'GET', url: '/app-error-503-retry-after' });

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('5');
    });

    it('does NOT capture a 401 AppError to Sentry', async () => {
      const response = await app.inject({ method: 'GET', url: '/app-error-401' });
      expect(response.statusCode).toBe(401);
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });
  });

  describe('framework client errors honor their 4xx status', () => {
    it('maps a 413 body-too-large to payload_too_large without capturing to Sentry', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/framework?status=413&code=FST_ERR_CTP_BODY_TOO_LARGE',
      });
      const body = response.json();
      expect(response.statusCode).toBe(413);
      expect(body.error.code).toBe('payload_too_large');
      expect(body.error.type).toBe('request_error');
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('maps a 415 unsupported-media-type to unsupported_media_type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/framework?status=415&code=FST_ERR_CTP_UNSUPPORTED_MEDIA_TYPE',
      });
      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe('unsupported_media_type');
    });

    it('honors an unmapped 4xx framework status with a generic invalid_request code', async () => {
      const response = await app.inject({ method: 'GET', url: '/framework?status=429' });
      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('invalid_request');
    });

    it('honors a framework status of exactly 400', async () => {
      const response = await app.inject({ method: 'GET', url: '/framework?status=400' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_request');
    });

    it('treats a framework statusCode of 500 as unhandled (masked + captured), not a client error', async () => {
      const response = await app.inject({ method: 'GET', url: '/framework?status=500' });
      const body = response.json();
      expect(response.statusCode).toBe(500);
      expect(body.error.code).toBe('internal_error');
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout branches', () => {
    it('maps a Fastify request timeout to 408 request_timeout', async () => {
      const response = await app.inject({ method: 'GET', url: '/request-timeout' });
      const body = response.json();
      expect(response.statusCode).toBe(408);
      expect(body.error.code).toBe('request_timeout');
      expect(body.meta.request_id).toEqual(expect.any(String));
      // A timeout is a client/gateway condition — not a Sentry capture.
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('maps a Postgres statement timeout to 504 gateway_timeout', async () => {
      const response = await app.inject({ method: 'GET', url: '/pg-timeout' });
      const body = response.json();
      expect(response.statusCode).toBe(504);
      expect(body.error.code).toBe('gateway_timeout');
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });
  });

  describe('validation + unhandled', () => {
    it('formats a ZodError as a 400 invalid_field validation_error with per-field messages', async () => {
      const response = await app.inject({ method: 'GET', url: '/zod' });
      const body = response.json();
      expect(response.statusCode).toBe(400);
      expect(body.error.type).toBe('validation_error');
      expect(body.error.code).toBe('invalid_field');
      expect(Array.isArray(body.error.errors)).toBe(true);
      expect(body.error.errors[0].field).toBe('name');
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('maps a Fastify schema validation failure to 400 with the missing field name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fastify-validation',
        payload: {},
      });
      const body = response.json();
      expect(response.statusCode).toBe(400);
      expect(body.error.type).toBe('validation_error');
      expect(body.error.errors.some((entry: { field: string }) => entry.field === 'email')).toBe(
        true,
      );
    });

    it('maps a Postgres lock_timeout (55P03) to 409 rather than a masked 500', async () => {
      // `DATABASE_LOCK_TIMEOUT_MS` bounds lock waits — including `pg_advisory_xact_lock`, which the
      // quota guards use — so contention now surfaces as a cancelled statement instead of queueing
      // forever. It is transient (retrying succeeds once the holder commits), so it must not be
      // reported as a server fault or captured to Sentry as unhandled.
      const response = await app.inject({ method: 'GET', url: '/lock-timeout' });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('conflict');
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('maps a plain unhandled error to a masked 500 internal_error and captures it', async () => {
      const response = await app.inject({ method: 'GET', url: '/unhandled' });
      const body = response.json();
      expect(response.statusCode).toBe(500);
      expect(body.error.code).toBe('internal_error');
      expect(body.error.type).toBe('request_error');
      expect(body.error.detail).toBe('translated:errors:internal');
      expect(body.error.detail).not.toContain('unexpected');
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });

    it('does NOT treat a FST_ERR_VALIDATION code without a validation array as a validation error', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/validation-code-without-array',
      });
      const body = response.json();
      // The guard requires an actual `validation` array; lacking it, this is a masked 500.
      expect(response.statusCode).toBe(500);
      expect(body.error.type).toBe('request_error');
      expect(body.error.code).toBe('internal_error');
    });

    it('derives the field name from the schema instancePath when there is no missingProperty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/instance-path-validation',
        payload: { age: 'not-an-integer' },
      });
      const body = response.json();
      expect(response.statusCode).toBe(400);
      expect(body.error.type).toBe('validation_error');
      // instancePath '/age' → 'age' (leading slash stripped), prefixed by the
      // validation context (e.g. 'body.age'), never the bare 'body' fallback.
      expect(
        body.error.errors.some((entry: { field: string }) => entry.field.endsWith('age')),
      ).toBe(true);
    });
  });
});
