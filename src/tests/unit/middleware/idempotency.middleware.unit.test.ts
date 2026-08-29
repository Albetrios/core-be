import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS,
  IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS,
} from '@/shared/constants/index.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';
const IDEMPOTENCY_TEST_KEY = 'test-key-1234567890';
const TEST_USER_PUBLIC_ID = 'user-public';
const TEST_ORGANIZATION_PUBLIC_ID = 'org-public';

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisIncr = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisEval = vi.fn();

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    get: (...arguments_: unknown[]) => mockRedisGet(...arguments_),
    set: (...arguments_: unknown[]) => mockRedisSet(...arguments_),
    incr: (...arguments_: unknown[]) => mockRedisIncr(...arguments_),
    del: (...arguments_: unknown[]) => mockRedisDel(...arguments_),
    eval: (...arguments_: unknown[]) => mockRedisEval(...arguments_),
  },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: vi.fn() },
}));

function buildCompletedEntry(statusCode: number, body: unknown): string {
  return JSON.stringify({
    state: 'completed',
    statusCode,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function buildInFlightEntry(): string {
  return JSON.stringify({ state: 'in_flight', claimedAt: Date.now(), requestId: 'req-other' });
}

function buildLegacyPlaceholderEntry(): string {
  return JSON.stringify({ statusCode: 202, body: '{}', headers: {} });
}

describe('idempotency middleware fail-closed behavior', () => {
  beforeEach(() => {
    // mockReset (not clearAllMocks) so a prior mockRejectedValue cannot leak into
    // later describes under timeout races — fail-closed must re-arm its rejection.
    mockRedisGet.mockReset();
    mockRedisSet.mockReset();
    mockRedisIncr.mockReset();
    mockRedisDel.mockReset();
    mockRedisEval.mockReset();
  });

  it('returns 503 when Redis is unavailable during claim', async () => {
    const { default: idempotencyPlugin } = await import(
      '@/shared/middlewares/core/idempotency.middleware.js'
    );

    let claimPreHandler: ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) | null =
      null;

    const mockApp = {
      addHook: vi.fn((hookName: string, handler: unknown) => {
        if (hookName === 'onRoute') {
          const onRoute = handler as (routeOptions: {
            method: string;
            preHandler?: unknown[];
          }) => void;
          onRoute({
            method: 'POST',
            preHandler: [],
          });
        }
      }),
    };

    mockRedisGet.mockRejectedValue(new Error('Redis down'));

    await idempotencyPlugin(mockApp as never, {} as never);

    const onRouteCall = mockApp.addHook.mock.calls.find((call) => call[0] === 'onRoute');
    expect(onRouteCall).toBeDefined();

    const onRoute = onRouteCall![1] as (routeOptions: {
      method: string;
      preHandler: unknown[];
    }) => void;
    const routeOptions = { method: 'POST', preHandler: [] as unknown[] };
    onRoute(routeOptions);
    claimPreHandler = routeOptions.preHandler.at(-1) as (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;

    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
    } as unknown as FastifyRequest & { _idempotencyKey?: string };

    const { parseIdempotencyKeyHeader } = await import(
      '@/shared/utils/idempotency/idempotency-key.util.js'
    );
    const parsed = parseIdempotencyKeyHeader(request.headers[IDEMPOTENCY_KEY_HEADER]);
    if (parsed.kind === 'valid') {
      (request as { _idempotencyKey?: string })._idempotencyKey = parsed.value;
    }

    const send = vi.fn();
    const header = vi.fn().mockReturnThis();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      header,
      send,
    } as unknown as FastifyReply;

    await claimPreHandler!(request, reply);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(header).toHaveBeenCalledWith('Retry-After', '2');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'service_unavailable', retryable: true }),
      }),
    );
  });
});

async function registerIdempotencyHooks() {
  const idempotencyModule = await import('@/shared/middlewares/core/idempotency.middleware.js');
  const idempotencyPlugin = idempotencyModule.default;
  // `idempotencyOnResponse` is no longer registered as an onResponse hook by the plugin
  // itself — the request lifecycle coordinator invokes it post-RLS-commit. Tests reach
  // through the exported function directly so they keep exercising the same code path.
  const idempotencyOnResponse = idempotencyModule.idempotencyOnResponse;
  const hooks: Record<string, unknown> = {};
  const mockApp = {
    addHook: vi.fn((hookName: string, handler: unknown) => {
      hooks[hookName] = handler;
    }),
  };
  await idempotencyPlugin(mockApp as never, {} as never);
  const onRoute = hooks.onRoute as (routeOptions: {
    method: string;
    preHandler: unknown[];
  }) => void;
  const routeOptions = { method: 'POST', preHandler: [] as unknown[] };
  onRoute(routeOptions);
  return {
    onRequest: hooks.onRequest as (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
    claimPreHandler: routeOptions.preHandler.at(-1) as (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>,
    onSend: hooks.onSend as (
      request: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
    ) => Promise<unknown>,
    onResponse: idempotencyOnResponse,
  };
}

describe('idempotency middleware happy paths and conflicts', () => {
  beforeEach(() => {
    mockRedisGet.mockReset().mockResolvedValue(null);
    mockRedisSet.mockReset().mockResolvedValue('OK');
    mockRedisIncr.mockReset().mockResolvedValue(1);
    mockRedisDel.mockReset().mockResolvedValue(1);
    // P0-#4: default to "under cap" — Lua returns the new count after INCR.
    mockRedisEval.mockReset().mockResolvedValue(1);
  });

  it('replays completed cache entries when Redis already has an entry', async () => {
    mockRedisGet.mockResolvedValue(buildCompletedEntry(200, { id: 'created' }));
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith({ id: 'created' });
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('returns 422 when the same key is reused with a different request payload', async () => {
    // A completed entry whose stored fingerprint cannot match the incoming request's fingerprint
    // (method + route + body). The reuse must be rejected (422) rather than replaying the prior
    // response or executing a divergent second operation.
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        state: 'completed',
        statusCode: 200,
        body: JSON.stringify({ id: 'first' }),
        headers: { 'content-type': 'application/json' },
        fingerprint: 'fingerprint-for-a-different-original-body',
      }),
    );
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      id: 'req-test',
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      body: { name: 'A different payload than the original' },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(422);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'idempotency_key_reuse' }),
        // audit api-contract-#1: idempotency errors carry the standard meta.request_id envelope.
        meta: expect.objectContaining({ request_id: expect.any(String) }),
      }),
    );
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('replays a completed entry when the fingerprint matches (same key + same payload)', async () => {
    const { buildIdempotencyRequestFingerprint } = await import(
      '@/shared/utils/idempotency/idempotency-fingerprint.util.js'
    );
    const body = { name: 'same payload' };
    const fingerprint = buildIdempotencyRequestFingerprint({
      method: 'POST',
      routePath: '/',
      body,
    });
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        state: 'completed',
        statusCode: 200,
        body: JSON.stringify({ id: 'created' }),
        headers: { 'content-type': 'application/json' },
        fingerprint,
      }),
    );
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      body,
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith({ id: 'created' });
  });

  it('returns 409 in_flight when an in-flight entry already exists', async () => {
    mockRedisGet.mockResolvedValue(buildInFlightEntry());
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'conflict_in_flight' }),
      }),
    );
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('treats legacy placeholder shape as in_flight (migration path)', async () => {
    mockRedisGet.mockResolvedValue(buildLegacyPlaceholderEntry());
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'conflict_in_flight' }),
      }),
    );
  });

  it('returns translated conflict_in_flight detail when request.t is available', async () => {
    mockRedisGet.mockResolvedValue(buildInFlightEntry());
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      headers: {},
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      t: (key: string) => `translated:${key}`,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ detail: 'translated:errors:idempotencyKeyInFlight' }),
      }),
    );
  });

  it('returns 409 when another request wins the SETNX race', async () => {
    mockRedisSet.mockResolvedValue(null);
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'conflict' }),
      }),
    );
  });

  it('replays completed entry when SETNX race re-read finds a completed cache', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockRedisSet.mockResolvedValue(null);
    mockRedisGet.mockResolvedValueOnce(buildCompletedEntry(200, { ok: true }));
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith({ ok: true });
  });

  it('rejects invalid idempotency keys during onRequest', async () => {
    const { onRequest } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: '!!!invalid!!!' },
    } as unknown as FastifyRequest;
    const reply = {} as FastifyReply;

    await expect(onRequest(request, reply)).rejects.toMatchObject({
      messageKey: 'errors:idempotencyKeyInvalid',
    });
  });

  it('defers placeholder release on 4xx responses until onResponse', async () => {
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: { userId: TEST_USER_PUBLIC_ID },
    } as unknown as FastifyRequest & { _idempotencyClaimed?: boolean };
    const reply = {
      statusCode: 422,
      getHeader: vi.fn().mockReturnValue('application/json'),
    } as unknown as FastifyReply;

    await onSend(request, reply, { error: 'validation' });
    expect(mockRedisDel).not.toHaveBeenCalled();
    expect(request._idempotencyClaimed).toBe(true);

    await onResponse(request, reply);
    expect(mockRedisDel).toHaveBeenCalled();
    expect(request._idempotencyClaimed).toBe(false);
  });

  it('onRequest stores valid idempotency keys for write methods', async () => {
    const { onRequest } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
    } as unknown as FastifyRequest & { _idempotencyKey?: string };

    await onRequest(request, {} as FastifyReply);

    expect(request._idempotencyKey).toBe(IDEMPOTENCY_TEST_KEY);
  });

  it('onRequest ignores GET requests without idempotency keys', async () => {
    const { onRequest } = await registerIdempotencyHooks();
    const request = { method: 'GET', headers: {} } as FastifyRequest;

    await onRequest(request, {} as FastifyReply);

    expect((request as { _idempotencyKey?: string })._idempotencyKey).toBeUndefined();
  });

  it('claimPreHandler prefers request.organizationId over header value', async () => {
    const organizationPublicId = generatePublicId('organization');
    mockRedisSet.mockResolvedValue('OK');
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: {
        [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY,
        'x-organization-id': 'header-org',
      },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      organizationId: organizationPublicId,
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest & { organizationId: string };

    await claimPreHandler(request, { sent: false } as FastifyReply);

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(`idempotency:${organizationPublicId}:`),
      expect.any(String),
      'EX',
      IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS,
      'NX',
    );
  });

  it('claimPreHandler writes an in_flight discriminated entry, not a fake CachedResponse', async () => {
    mockRedisSet.mockResolvedValue('OK');
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      id: 'req-1',
    } as unknown as FastifyRequest;

    await claimPreHandler(request, { sent: false } as FastifyReply);

    const [, body] = mockRedisSet.mock.calls.at(-1) as [string, string, ...unknown[]];
    const parsed = JSON.parse(body) as { state: string; statusCode?: number };
    expect(parsed.state).toBe('in_flight');
    expect(parsed.statusCode).toBeUndefined();
  });

  it('claimPreHandler scopes cache keys using the organization claim', async () => {
    const organizationPublicId = generatePublicId('organization');
    mockRedisSet.mockResolvedValue('OK');
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: {
        [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY,
      },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID, organizationPublicId },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest & { _idempotencyClaimed?: boolean };

    await claimPreHandler(request, { sent: false } as FastifyReply);

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(`idempotency:${organizationPublicId}:user-public:`),
      expect.any(String),
      'EX',
      IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS,
      'NX',
    );
    expect(request._idempotencyClaimed).toBe(true);
  });

  it('continues when idempotency counter increment fails after claim', async () => {
    mockRedisIncr.mockRejectedValueOnce(new Error('counter unavailable'));
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest & { _idempotencyClaimed?: boolean };

    await claimPreHandler(request, { sent: false } as FastifyReply);

    expect(request._idempotencyClaimed).toBe(true);
  });

  it('onSend stashes pending completion; onResponse writes completed entry on 2xx', async () => {
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: {
        userId: TEST_USER_PUBLIC_ID,
        organizationId: TEST_ORGANIZATION_PUBLIC_ID,
      },
    } as unknown as FastifyRequest;
    const reply = {
      statusCode: 200,
      getHeader: vi.fn().mockReturnValue('application/json'),
    } as unknown as FastifyReply;

    const payload = await onSend(request, reply, { id: 'created' });
    expect(payload).toEqual({ id: 'created' });
    expect(mockRedisSet).not.toHaveBeenCalled();

    await onResponse(request, reply);

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(IDEMPOTENCY_TEST_KEY),
      expect.stringContaining('"state":"completed"'),
      'EX',
      IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS,
    );
  });

  it('caches responses at exactly 100KB after onResponse runs', async () => {
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: {
        userId: TEST_USER_PUBLIC_ID,
        organizationId: TEST_ORGANIZATION_PUBLIC_ID,
      },
    } as unknown as FastifyRequest;
    const reply = {
      statusCode: 200,
      getHeader: vi.fn().mockReturnValue('application/json'),
    } as unknown as FastifyReply;
    const maxSizeBody = 'x'.repeat(100 * 1024);

    await onSend(request, reply, maxSizeBody);
    await onResponse(request, reply);

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(IDEMPOTENCY_TEST_KEY),
      expect.any(String),
      'EX',
      IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS,
    );
  });

  it('skips caching responses larger than 100KB and releases placeholder', async () => {
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: {
        userId: TEST_USER_PUBLIC_ID,
        organizationId: TEST_ORGANIZATION_PUBLIC_ID,
      },
    } as unknown as FastifyRequest & { _idempotencyClaimed?: boolean };
    const reply = {
      statusCode: 200,
      getHeader: vi.fn().mockReturnValue('application/json'),
    } as unknown as FastifyReply;
    const oversizedBody = 'x'.repeat(100 * 1024 + 1);

    const payload = await onSend(request, reply, oversizedBody);
    expect(payload).toBe(oversizedBody);
    expect(mockRedisSet).not.toHaveBeenCalled();

    await onResponse(request, reply);
    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(request._idempotencyClaimed).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: IDEMPOTENCY_TEST_KEY,
        bodyByteLength: 100 * 1024 + 1,
        maxBytes: 100 * 1024,
      }),
      'idempotency.cache.body.too_large',
    );
  });

  it('onSend caches an empty 204 body (undefined payload) as JSON null without crashing', async () => {
    // Regression: a client that attaches X-Idempotency-Key to a write returning 204 (empty
    // body) previously 500'd here — `JSON.stringify(undefined)` returns `undefined`, which
    // threw inside `Buffer.byteLength`. The empty body must normalize to JSON `null`.
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: {
        userId: TEST_USER_PUBLIC_ID,
        organizationId: TEST_ORGANIZATION_PUBLIC_ID,
      },
    } as unknown as FastifyRequest;
    const reply = {
      statusCode: 204,
      getHeader: vi.fn().mockReturnValue(undefined),
    } as unknown as FastifyReply;

    // Must not throw on an undefined (empty 204) payload; returns it untouched.
    const payload = await onSend(request, reply, undefined);
    expect(payload).toBeUndefined();

    await onResponse(request, reply);

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(IDEMPOTENCY_TEST_KEY),
      expect.stringContaining('"statusCode":204'),
      'EX',
      IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS,
    );
    const storedEntry = mockRedisSet.mock.calls.at(-1)?.[1] as string;
    expect(JSON.parse(storedEntry)).toMatchObject({
      state: 'completed',
      statusCode: 204,
      body: 'null',
    });
  });

  it('replays a cached empty 204 entry without crashing on JSON.parse', async () => {
    // The stored body is JSON `null`; the replay path must `JSON.parse('null')` -> null and
    // send an empty body, not throw — guarding `sendCachedIdempotencyResponse` for 204s.
    mockRedisGet.mockResolvedValue(buildCompletedEntry(204, 'null'));
    const { claimPreHandler } = await registerIdempotencyHooks();

    const request = {
      method: 'DELETE',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(204);
    expect(reply.header).toHaveBeenCalledWith('x-idempotency-replay', 'true');
    expect(send).toHaveBeenCalledWith(null);
  });

  it('claimPreHandler returns early when reply is already sent', async () => {
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    await claimPreHandler(request, { sent: true } as FastifyReply);

    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('claimPreHandler returns early when idempotency key is absent', async () => {
    const { claimPreHandler } = await registerIdempotencyHooks();
    await claimPreHandler({} as FastifyRequest, { sent: false } as FastifyReply);
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('onSend skips stashing when claim was not acquired', async () => {
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: false,
    } as unknown as FastifyRequest;
    const reply = { statusCode: 200, getHeader: vi.fn() } as unknown as FastifyReply;

    await onSend(request, reply, { ok: true });
    await onResponse(request, reply);

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('caches string payloads via onResponse and uses organization id from request', async () => {
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      headers: {},
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      organizationId: 'org-from-request',
    } as unknown as FastifyRequest & { organizationId: string };
    const reply = {
      statusCode: 200,
      getHeader: vi.fn().mockReturnValue(undefined),
    } as unknown as FastifyReply;

    await onSend(request, reply, '{"ok":true}');
    await onResponse(request, reply);

    expect(mockRedisSet).toHaveBeenCalled();
  });

  it('logs when Redis set fails during onResponse cache write', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('set failed'));
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: { userId: TEST_USER_PUBLIC_ID },
    } as unknown as FastifyRequest;
    const reply = {
      statusCode: 200,
      getHeader: vi.fn().mockReturnValue('application/json'),
    } as unknown as FastifyReply;

    await onSend(request, reply, { id: 'created' });
    await onResponse(request, reply);

    expect(mockRedisSet).toHaveBeenCalled();
  });

  it('logs when placeholder release fails on error responses in onResponse', async () => {
    mockRedisDel.mockRejectedValueOnce(new Error('del failed'));
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: { userId: TEST_USER_PUBLIC_ID },
    } as unknown as FastifyRequest;
    const reply = {
      statusCode: 500,
      getHeader: vi.fn().mockReturnValue('application/json'),
    } as unknown as FastifyReply;

    await onSend(request, reply, { error: 'server' });
    await onResponse(request, reply);

    expect(mockRedisDel).toHaveBeenCalled();
  });

  it('onRoute skips non-write methods and appends claim handler for write routes', async () => {
    const { default: idempotencyPlugin } = await import(
      '@/shared/middlewares/core/idempotency.middleware.js'
    );
    const mockApp = { addHook: vi.fn() };
    await idempotencyPlugin(mockApp as never, {} as never);

    const onRoute = mockApp.addHook.mock.calls.find(
      (call) => call[0] === 'onRoute',
    )![1] as (routeOptions: { method: string | string[]; preHandler?: unknown }) => void;

    const getRoute = { method: 'GET', preHandler: undefined as unknown };
    onRoute(getRoute);
    expect(getRoute.preHandler).toBeUndefined();

    const undefinedMethodRoute = {
      method: undefined as unknown as string,
      preHandler: [] as unknown[],
    };
    onRoute(undefinedMethodRoute);
    expect(undefinedMethodRoute.preHandler).toHaveLength(0);

    const postRoute = { method: 'POST', preHandler: vi.fn() };
    onRoute(postRoute);
    expect(Array.isArray(postRoute.preHandler)).toBe(true);

    const multiRoute = { method: ['GET', 'PATCH'], preHandler: [] as unknown[] };
    onRoute(multiRoute);
    expect(multiRoute.preHandler.length).toBeGreaterThan(0);
  });

  it('uses translated error detail when request.t is available', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis down'));
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      headers: {},
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      t: (key: string) => `translated:${key}`,
    } as unknown as FastifyRequest;
    const send = vi.fn();
    const reply = {
      sent: false,
      status: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send,
    } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ detail: 'translated:errors:serviceUnavailable' }),
      }),
    );
  });

  it('skips claim and cache entirely for unauthenticated callers (no cross-caller replay)', async () => {
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: {
        [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY,
        'x-organization-id': 'unverified-org',
      },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest & { _idempotencyClaimed?: boolean };

    const reply = { sent: false } as unknown as FastifyReply;

    await claimPreHandler(request, reply);

    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockRedisIncr).not.toHaveBeenCalled();
    expect(request._idempotencyClaimed).toBeUndefined();
  });

  it('increments a sharded claim counter key after a successful claim (no global hot key)', async () => {
    mockRedisSet.mockResolvedValue('OK');
    const { claimPreHandler } = await registerIdempotencyHooks();
    const request = {
      method: 'POST',
      headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
      auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
    } as unknown as FastifyRequest;

    await claimPreHandler(request, { sent: false } as FastifyReply);

    expect(mockRedisIncr).toHaveBeenCalledTimes(1);
    const [counterKey] = mockRedisIncr.mock.calls.at(-1) as [string];
    expect(counterKey).toMatch(/^idempotency-claim-counter:shard:\d+$/);
  });

  // P0-#4: per-actor idempotency-key cap. A single misbehaving client sending unique keys
  // per request would fill Redis with ~24h-lived entries. The cap rejects fresh claims with
  // 429 + Retry-After once the per-actor counter crosses IDEMPOTENCY_PER_ACTOR_CAP inside
  // the configured window; cache-hit replays of completed work are unaffected.
  describe('per-actor cardinality cap (P0-#4)', () => {
    it('responds 429 with Retry-After when the Lua check-and-incr returns -1 (over cap)', async () => {
      mockRedisEval.mockResolvedValueOnce(-1);
      const { claimPreHandler } = await registerIdempotencyHooks();
      const request = {
        method: 'POST',
        headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
        auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
        _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      } as unknown as FastifyRequest;

      const send = vi.fn();
      const header = vi.fn().mockReturnThis();
      const reply = {
        sent: false,
        status: vi.fn().mockReturnThis(),
        header,
        send,
      } as unknown as FastifyReply;

      await claimPreHandler(request, reply);

      expect(reply.status).toHaveBeenCalledWith(429);
      expect(header).toHaveBeenCalledWith('Retry-After', expect.any(String));
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'idempotency_per_actor_cap',
            retryable: true,
          }),
        }),
      );
      // Never reach the SETNX claim or the shard counter when over cap.
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockRedisIncr).not.toHaveBeenCalled();
    });

    it('keys the rate counter by API key id when the actor authenticates with an API key', async () => {
      const apiKeyPublicId = generatePublicId('organizationApiKey');
      const { claimPreHandler } = await registerIdempotencyHooks();
      const request = {
        method: 'POST',
        headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
        auth: {
          kind: 'apiKey' as const,
          apiKeyPublicId,
          apiKeyScopes: ['write:any'],
          organizationPublicId: TEST_ORGANIZATION_PUBLIC_ID,
        },
        _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      } as unknown as FastifyRequest;

      await claimPreHandler(request, { sent: false } as FastifyReply);

      expect(mockRedisEval).toHaveBeenCalledTimes(1);
      const evalArgs = mockRedisEval.mock.calls.at(-1) as unknown[];
      // EVAL signature: (script, numKeys, ...keys, ...args). KEY[0] is at index 2.
      expect(evalArgs[2]).toBe(`idempotency:actor-rate:api-key:${apiKeyPublicId}`);
    });

    it('does NOT consume the cap on a cache-hit replay (cap protects only new claim allocations)', async () => {
      mockRedisGet.mockResolvedValue(buildCompletedEntry(200, { id: 'replay' }));
      const { claimPreHandler } = await registerIdempotencyHooks();
      const request = {
        method: 'POST',
        headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
        auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
        _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      } as unknown as FastifyRequest;

      const reply = {
        sent: false,
        status: vi.fn().mockReturnThis(),
        header: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await claimPreHandler(request, reply);

      expect(reply.status).toHaveBeenCalledWith(200);
      // Cache hit short-circuits before the cap eval — a legitimate retry of a completed
      // request must never count against the actor's cardinality budget.
      expect(mockRedisEval).not.toHaveBeenCalled();
    });

    it('fails open (allows the claim) when Redis EVAL throws so a transient outage does not turn the cap into a 5xx spike', async () => {
      mockRedisEval.mockRejectedValueOnce(new Error('eval-failed'));
      const { claimPreHandler } = await registerIdempotencyHooks();
      const request = {
        method: 'POST',
        headers: { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY_TEST_KEY },
        auth: { kind: 'user' as const, userId: TEST_USER_PUBLIC_ID },
        _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      } as unknown as FastifyRequest;

      const reply = {
        sent: false,
        status: vi.fn().mockReturnThis(),
        header: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply;

      await claimPreHandler(request, reply);

      // SETNX still ran, the request proceeds; downstream Redis failures still hit the
      // existing fail-closed 503 path.
      expect(mockRedisSet).toHaveBeenCalled();
      expect(reply.status).not.toHaveBeenCalledWith(429);
    });
  });

  it('onResponse releases unclaimed placeholders when handler throws (no pending completion, statusCode 500)', async () => {
    const { onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: { userId: TEST_USER_PUBLIC_ID },
    } as unknown as FastifyRequest & { _idempotencyClaimed?: boolean };
    const reply = { statusCode: 500 } as unknown as FastifyReply;

    await onResponse(request, reply);

    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(request._idempotencyClaimed).toBe(false);
  });

  it('onResponse releases placeholder when statusCode is success but no pending completion was stashed', async () => {
    const { onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: { userId: TEST_USER_PUBLIC_ID },
    } as unknown as FastifyRequest & { _idempotencyClaimed?: boolean };
    const reply = { statusCode: 204 } as unknown as FastifyReply;

    await onResponse(request, reply);

    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('onResponse with forceRelease deletes placeholder and never caches a 2xx body', async () => {
    const { onSend, onResponse } = await registerIdempotencyHooks();
    const request = {
      _idempotencyKey: IDEMPOTENCY_TEST_KEY,
      _idempotencyClaimed: true,
      _idempotencyScope: {
        userId: TEST_USER_PUBLIC_ID,
        organizationId: TEST_ORGANIZATION_PUBLIC_ID,
      },
    } as unknown as FastifyRequest & { _idempotencyPendingCompleted?: unknown };
    const reply = {
      statusCode: 200,
      getHeader: vi.fn().mockReturnValue('application/json'),
    } as unknown as FastifyReply;

    await onSend(request, reply, { id: 'created' });
    await onResponse(request, reply, { forceRelease: true });

    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(request._idempotencyPendingCompleted).toBeUndefined();
  });
});
