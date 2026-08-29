import type { FastifyPluginAsync, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { ValidationError } from '@/shared/errors/index.js';
import {
  buildIdempotencyActorRateKey,
  buildIdempotencyCacheKey,
  hasAuthenticatedIdempotencyActor,
  parseIdempotencyKeyHeader,
  selectIdempotencyClaimCounterShardKey,
} from '@/shared/utils/idempotency/idempotency-key.util.js';
import {
  buildIdempotencyRequestFingerprint,
  isIdempotencyRouteExcluded,
  responseBodyContainsSecretFields,
} from '@/shared/utils/idempotency/idempotency-fingerprint.util.js';
import { translateRequestMessage } from '@/shared/utils/i18n/translate-request.util.js';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  assertIdempotencyKeyPresentWhenRequired,
  isIdempotencyKeyRequiredForRequest,
} from '@/shared/utils/idempotency/idempotency-required.util.js';
import {
  IDEMPOTENCY_CACHED_BODY_BYTES,
  IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS,
  IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS,
  IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from '@/shared/constants/index.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Throttle window for the degraded-mode Sentry alert so a Redis outage cannot flood Sentry. */
const IDEMPOTENCY_STORE_UNAVAILABLE_ALERT_INTERVAL_MS = 30_000;
let lastIdempotencyStoreUnavailableAlertAtMs = 0;

/** Throttle window for the per-actor-cap exceeded Sentry alert so a noisy client cannot flood Sentry. */
const IDEMPOTENCY_PER_ACTOR_CAP_ALERT_INTERVAL_MS = 60_000;
let lastIdempotencyPerActorCapAlertAtMs = 0;

/**
 * Atomic "check threshold then INCR + EXPIRE" so a concurrent burst from one actor cannot
 * race past the cap (a TS-side GET-then-INCR would let N concurrent requests all read N-1
 * and then each push the counter to N). Returns the new count, or `-1` if the actor is
 * already at or above the cap (caller responds 429).
 */
const IDEMPOTENCY_PER_ACTOR_RATE_CHECK_AND_INCR_LUA = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
if count >= cap then
  return -1
end
local new_count = redis.call('INCR', KEYS[1])
if new_count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return new_count
`;

/**
 * Surfaces a per-actor idempotency-key cap breach as a throttled Sentry warning so a noisy
 * client (one sending unique keys per request) is observable to operators without flooding
 * Sentry. Throttled to one event per {@link IDEMPOTENCY_PER_ACTOR_CAP_ALERT_INTERVAL_MS}.
 */
function alertIdempotencyPerActorCapExceeded(payload: {
  actorRateKey: string;
  cap: number;
  windowSeconds: number;
}): void {
  const now = Date.now();
  if (now - lastIdempotencyPerActorCapAlertAtMs < IDEMPOTENCY_PER_ACTOR_CAP_ALERT_INTERVAL_MS) {
    return;
  }
  lastIdempotencyPerActorCapAlertAtMs = now;
  captureMessage('idempotency.per_actor_cap.exceeded', {
    level: 'warning',
    extra: payload,
  });
}

/**
 * Surfaces the idempotency store (Redis) being unavailable as a throttled Sentry event so a
 * Redis outage — during which required-idempotency writes fail closed with 503 — actually pages
 * operations instead of only appearing in logs. Throttled to one event per
 * {@link IDEMPOTENCY_STORE_UNAVAILABLE_ALERT_INTERVAL_MS} so a sustained outage does not flood Sentry.
 */
function alertIdempotencyStoreUnavailable(error: unknown): void {
  const now = Date.now();
  if (
    now - lastIdempotencyStoreUnavailableAlertAtMs <
    IDEMPOTENCY_STORE_UNAVAILABLE_ALERT_INTERVAL_MS
  ) {
    return;
  }
  lastIdempotencyStoreUnavailableAlertAtMs = now;
  captureMessage('idempotency.cache.unavailable', {
    level: 'error',
    extra: { error: error instanceof Error ? error.message : String(error) },
  });
}

interface CompletedIdempotencyEntry {
  state: 'completed';
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  /** Fingerprint (method + route + body) of the request that produced this entry; used to reject key reuse with a different payload. */
  fingerprint?: string;
}

interface InFlightIdempotencyEntry {
  state: 'in_flight';
  claimedAt: number;
  requestId?: string;
  /** Fingerprint of the in-flight request; a later request reusing the key with a different fingerprint is rejected. */
  fingerprint?: string;
}

type IdempotencyEntry = CompletedIdempotencyEntry | InFlightIdempotencyEntry;

interface PendingIdempotencyCompletion {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

interface RequestWithIdempotency extends FastifyRequest {
  _idempotencyKey?: string;
  _idempotencyRequestFingerprint?: string;
  _idempotencyScope?: { userId?: string; organizationId?: string; apiKeyPublicId?: string };
  /** Set when this request claimed the placeholder via SETNX. Used to release on error. */
  _idempotencyClaimed?: boolean;
  /** Serialized successful response stashed in onSend; written to Redis in onResponse. */
  _idempotencyPendingCompleted?: PendingIdempotencyCompletion;
}

/**
 * Backward compatible parser: prior versions stored the placeholder as a fully-formed
 * CachedResponse (`{ statusCode: 202, body: '{}', headers: {} }`). Treat any entry that
 * does not explicitly carry `state: 'completed'` as `in_flight` so a rolling deployment
 * does not replay 202 placeholders as real responses.
 */
function parseCompletedIdempotencyEntry(
  parsed: Record<string, unknown>,
): CompletedIdempotencyEntry | null {
  const completed = parsed as Partial<CompletedIdempotencyEntry>;
  if (
    typeof completed.statusCode === 'number' &&
    typeof completed.body === 'string' &&
    completed.headers !== null &&
    typeof completed.headers === 'object'
  ) {
    return {
      state: 'completed',
      statusCode: completed.statusCode,
      body: completed.body,
      headers: completed.headers,
      ...(typeof completed.fingerprint === 'string' ? { fingerprint: completed.fingerprint } : {}),
    };
  }
  return null;
}

function parseInFlightIdempotencyEntry(parsed: Record<string, unknown>): InFlightIdempotencyEntry {
  const inFlight = parsed as Partial<InFlightIdempotencyEntry>;
  return {
    state: 'in_flight',
    claimedAt: typeof inFlight.claimedAt === 'number' ? inFlight.claimedAt : 0,
    ...(typeof inFlight.requestId === 'string' ? { requestId: inFlight.requestId } : {}),
    ...(typeof inFlight.fingerprint === 'string' ? { fingerprint: inFlight.fingerprint } : {}),
  };
}

function parseIdempotencyEntry(raw: string): IdempotencyEntry {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && parsed.state === 'completed') {
      const completed = parseCompletedIdempotencyEntry(parsed);
      if (completed) return completed;
    }
    if (parsed && typeof parsed === 'object' && parsed.state === 'in_flight') {
      return parseInFlightIdempotencyEntry(parsed);
    }
    return { state: 'in_flight', claimedAt: 0 };
  } catch {
    return { state: 'in_flight', claimedAt: 0 };
  }
}

function isWriteRouteMethod(method: RouteOptions['method']): boolean {
  if (method === undefined) return false;
  const methods = Array.isArray(method) ? method : [method];
  return methods.some((item) => WRITE_METHODS.has(item));
}

function resolveIdempotencyScope(request: FastifyRequest): {
  userId?: string;
  organizationId?: string;
  apiKeyPublicId?: string;
} {
  const authentication = request.auth;
  const requestWithOrganization = request as FastifyRequest & { organizationId?: string | null };
  const organizationFromRequest = requestWithOrganization.organizationId;
  const organizationHeader = request.headers['x-organization-id'];
  const organizationIdFromHeader =
    typeof organizationHeader === 'string' && organizationHeader.length > 0
      ? organizationHeader
      : undefined;
  // The active organization scopes the idempotency cache key. After the route flatten it rides the
  // signed `org` JWT claim (`auth.organizationPublicId`) — the authoritative active organization for both
  // user and API-key principals — not the legacy `X-Organization-Id` header (which clients no longer
  // send on flat routes). Without this, a user reusing an X-Idempotency-Key across organizations would collide
  // in the same `idempotency:none:<userId>:<key>` bucket. Header is kept only as a pre-auth fallback.
  const organizationId =
    authentication?.organizationPublicId ?? organizationFromRequest ?? organizationIdFromHeader;

  return omitUndefined({
    userId: authentication?.kind === 'user' ? authentication.userId : undefined,
    organizationId,
    apiKeyPublicId: authentication?.kind === 'apiKey' ? authentication.apiKeyPublicId : undefined,
  });
}

function sendCachedIdempotencyResponse(
  reply: FastifyReply,
  response: CompletedIdempotencyEntry,
): FastifyReply {
  reply.status(response.statusCode);
  for (const [headerKey, headerValue] of Object.entries(response.headers)) {
    reply.header(headerKey, headerValue);
  }
  reply.header('x-idempotency-replay', 'true');
  return reply.send(JSON.parse(response.body));
}

/**
 * Builds an idempotency error body that matches the standard API error envelope — `error` plus a
 * `meta.request_id` block (audit api-contract-#1: these middleware responses previously `reply.send`-d
 * a bare `{ error }` with no `meta`, so every idempotency 409/422/429/503 dropped the `request_id`
 * that every other error carries). Keeps the exact `type`/`code`/`detail` each caller already used;
 * `retry_after_seconds` is snake_case per the body-key contract (was `retryAfterSeconds`).
 */
function buildIdempotencyErrorBody(
  request: FastifyRequest,
  error: {
    type: string;
    code: string;
    detail: string;
    retryable?: boolean;
    retry_after_seconds?: number;
  },
) {
  return {
    error: omitUndefined({
      type: error.type,
      code: error.code,
      detail: error.detail,
      retryable: error.retryable,
      retry_after_seconds: error.retry_after_seconds,
    }),
    meta: { request_id: getRequestIdentifier(request) },
  };
}

function sendInFlightConflict(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const detail = translateRequestMessage(
    request,
    'errors:idempotencyKeyInFlight',
    'A request with this idempotency key is still in flight',
  );
  reply.status(409);
  return reply.send(
    buildIdempotencyErrorBody(request, {
      type: 'request_error',
      code: 'conflict_in_flight',
      detail,
    }),
  );
}

/**
 * Rejects a request that reuses an `X-Idempotency-Key` already associated with a *different* request
 * payload (method + route + body fingerprint mismatch). Returns 422 so the client knows the key was
 * reused incorrectly rather than retrying the same operation — matching Stripe-style semantics and
 * preventing a divergent second operation from executing under the same key.
 */
function sendIdempotencyKeyReuseConflict(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const detail = translateRequestMessage(
    request,
    'errors:idempotencyKeyReuse',
    'This idempotency key was already used with a different request payload',
  );
  reply.status(422);
  return reply.send(
    buildIdempotencyErrorBody(request, {
      type: 'request_error',
      code: 'idempotency_key_reuse',
      detail,
    }),
  );
}

/**
 * Short-lived placeholder TTL. Once a real response is computed, `onSend` overwrites the
 * key with the real cached response and the standard 24h TTL. Keeping the in-flight
 * window short avoids 24h "ghost" placeholders if the worker crashes hard before `onSend`
 * runs (and the error-path DEL has not had a chance to execute).
 */
function resolveIdempotencyRoutePath(request: FastifyRequest): string {
  const routeTemplate = request.routeOptions?.url;
  if (typeof routeTemplate === 'string' && routeTemplate.length > 0) {
    return routeTemplate;
  }
  const pathOnly = request.url?.split('?')[0];
  return pathOnly && pathOnly.length > 0 ? pathOnly : '/';
}

/**
 * Runs the atomic check-and-INCR for the per-actor idempotency claim cap (P0-#4).
 * Returns `true` when the actor has crossed `IDEMPOTENCY_PER_ACTOR_CAP` inside the
 * configured window and the request must be rejected with 429.
 *
 * @remarks
 * Fails open on Redis errors (logs, returns `false`) so a transient Lua/EVAL outage does
 * not turn the soft rate limit into a 5xx spike — the cache-level claim path (SETNX) still
 * has its own fail-closed treatment via {@link respondIdempotencyStoreUnavailable}, which
 * is the right escalation for a Redis outage.
 */
async function enforceIdempotencyPerActorCap(scope: {
  userId?: string;
  organizationId?: string;
  apiKeyPublicId?: string;
}): Promise<boolean> {
  const actorRateKey = buildIdempotencyActorRateKey(scope);
  if (actorRateKey === null) return false;

  const cap = env.IDEMPOTENCY_PER_ACTOR_CAP;
  const windowSeconds = env.IDEMPOTENCY_PER_ACTOR_CAP_WINDOW_SECONDS;
  let result: unknown;
  try {
    result = await redisConnection.eval(
      IDEMPOTENCY_PER_ACTOR_RATE_CHECK_AND_INCR_LUA,
      1,
      actorRateKey,
      String(cap),
      String(windowSeconds),
    );
  } catch (error) {
    logger.warn({ error, actorRateKey }, 'idempotency.per_actor_cap.eval.failed');
    return false;
  }
  if (typeof result !== 'number') return false;
  if (result === -1) {
    alertIdempotencyPerActorCapExceeded({ actorRateKey, cap, windowSeconds });
    logger.warn({ actorRateKey, cap, windowSeconds }, 'idempotency.per_actor_cap.exceeded');
    return true;
  }
  return false;
}

function sendIdempotencyPerActorCapExceeded(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const retryAfterSeconds = env.IDEMPOTENCY_PER_ACTOR_CAP_WINDOW_SECONDS;
  const detail = translateRequestMessage(
    request,
    'errors:idempotencyPerActorCapExceeded',
    'Too many idempotent requests; reuse a key or wait for the window to reset',
  );
  reply.header('Retry-After', String(retryAfterSeconds));
  reply.status(429);
  return reply.send(
    buildIdempotencyErrorBody(request, {
      type: 'rate_limit_error',
      code: 'idempotency_per_actor_cap',
      detail,
      retryable: true,
      retry_after_seconds: retryAfterSeconds,
    }),
  );
}

async function idempotencyClaimPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (reply.sent) return;

  // Must precede the missing-key early return below: an absent key on a required route
  // is exactly what this asserts, and running post-auth means anonymous callers get 401.
  assertIdempotencyKeyPresentWhenRequired(request);

  const requestWithIdempotency = request as RequestWithIdempotency;
  const idempotencyKey = requestWithIdempotency._idempotencyKey;
  if (!idempotencyKey) return;

  const routePath = resolveIdempotencyRoutePath(request);
  if (isIdempotencyRouteExcluded(routePath)) {
    return;
  }

  const scope = resolveIdempotencyScope(request);
  if (!hasAuthenticatedIdempotencyActor(scope)) {
    /**
     * Never store or replay idempotent responses for unauthenticated callers. Two anonymous
     * callers presenting the same `X-Idempotency-Key` would otherwise collide on a single
     * `idempotency:none:anonymous:<key>` bucket, letting the second caller receive the first
     * caller's cached (possibly token-bearing) response body. The request still proceeds
     * normally — it simply gets no idempotency dedup.
     */
    return;
  }

  const requestFingerprint = buildIdempotencyRequestFingerprint({
    method: request.method,
    routePath,
    body: request.body,
  });
  requestWithIdempotency._idempotencyRequestFingerprint = requestFingerprint;

  const cacheKey = buildIdempotencyCacheKey(idempotencyKey, scope);
  requestWithIdempotency._idempotencyScope = scope;

  let cached: string | null;
  let claimed: 'OK' | null;
  try {
    cached = await redisConnection.get(cacheKey);
    if (cached !== null) {
      return serveIdempotencyCacheHit(
        request,
        reply,
        parseIdempotencyEntry(cached),
        requestFingerprint,
      );
    }

    // P0-#4: per-actor claim cap. The cache-hit path above is intentionally before this check
    // so legitimate replay traffic (same key, expecting the cached completed response) is never
    // rate-limited; only attempts that would actually allocate a new Redis entry count.
    const isOverCap = await enforceIdempotencyPerActorCap(scope);
    if (isOverCap) {
      return sendIdempotencyPerActorCapExceeded(request, reply);
    }

    const inFlightEntry: InFlightIdempotencyEntry = {
      state: 'in_flight',
      claimedAt: Date.now(),
      requestId: typeof request.id === 'string' ? request.id : String(request.id ?? ''),
      fingerprint: requestFingerprint,
    };
    claimed = await redisConnection.set(
      cacheKey,
      JSON.stringify(inFlightEntry),
      'EX',
      IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS,
      'NX',
    );
  } catch (error) {
    return respondIdempotencyStoreUnavailable(request, reply, error, idempotencyKey);
  }

  if (!claimed) {
    return handleIdempotencyClaimRace(request, reply, cacheKey, requestFingerprint, idempotencyKey);
  }

  requestWithIdempotency._idempotencyClaimed = true;

  try {
    /**
     * Spread the claim counter over a fixed shard fan-out instead of one global key so high
     * write throughput (or Redis Cluster) does not turn a single slot into a hot spot. The
     * total is the sum across shards; the cardinality monitor's SCAN is independent of this.
     */
    await redisConnection.incr(selectIdempotencyClaimCounterShardKey());
  } catch (counterError) {
    logger.warn({ error: counterError }, 'idempotency.claim.counter.incr.failed');
  }
}

/** Replays/cached-conflicts a hit: fingerprint mismatch → 422, completed → replay, else in-flight 409. */
function serveIdempotencyCacheHit(
  request: FastifyRequest,
  reply: FastifyReply,
  entry: IdempotencyEntry,
  requestFingerprint: string,
): FastifyReply {
  // Same key, different payload → reject (do not execute a divergent second operation).
  // Entries written before this rollout carry no fingerprint; skip the check for them.
  if (entry.fingerprint !== undefined && entry.fingerprint !== requestFingerprint) {
    sendIdempotencyKeyReuseConflict(request, reply);
    return reply;
  }
  if (entry.state === 'completed') {
    sendCachedIdempotencyResponse(reply, entry);
    return reply;
  }
  sendInFlightConflict(request, reply);
  return reply;
}

/**
 * Degraded mode (fail closed, but cleanly retryable): with Redis degraded we cannot guarantee
 * at-most-once execution, so we must not run the handler. Advertise an explicit `Retry-After`
 * and flag the error retryable so well-behaved clients re-issue the same `X-Idempotency-Key` once
 * the transient Redis blip clears — preserving correctness while turning a write outage into a
 * brief, self-healing retry.
 */
function respondIdempotencyStoreUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  idempotencyKey: string,
): FastifyReply {
  logger.warn({ error, idempotencyKey }, 'idempotency.cache.unavailable');
  alertIdempotencyStoreUnavailable(error);
  const detail = translateRequestMessage(
    request,
    'errors:serviceUnavailable',
    'Idempotency store unavailable',
  );
  reply.header('Retry-After', String(IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS));
  reply.status(503);
  reply.send(
    buildIdempotencyErrorBody(request, {
      type: 'service_error',
      code: 'service_unavailable',
      detail,
      retryable: true,
      retry_after_seconds: IDEMPOTENCY_STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
    }),
  );
  return reply;
}

/**
 * Lost the SETNX race: another concurrent claim landed between our GET miss and SETNX. Re-read
 * so we can tell apart "still computing" (409 in_flight) from "already completed" (replay).
 */
async function handleIdempotencyClaimRace(
  request: FastifyRequest,
  reply: FastifyReply,
  cacheKey: string,
  requestFingerprint: string,
  idempotencyKey: string,
): Promise<FastifyReply> {
  let raceEntry: IdempotencyEntry | null = null;
  try {
    const rawRace = await redisConnection.get(cacheKey);
    if (rawRace !== null) raceEntry = parseIdempotencyEntry(rawRace);
  } catch (raceError) {
    logger.warn({ error: raceError, idempotencyKey }, 'idempotency.cache.race.read.failed');
  }
  if (raceEntry?.fingerprint !== undefined && raceEntry.fingerprint !== requestFingerprint) {
    sendIdempotencyKeyReuseConflict(request, reply);
    return reply;
  }
  if (raceEntry?.state === 'completed') {
    sendCachedIdempotencyResponse(reply, raceEntry);
    return reply;
  }
  const detail = translateRequestMessage(
    request,
    'errors:idempotencyKeyConflict',
    'Concurrent request with same idempotency key',
  );
  reply.status(409);
  reply.send(
    buildIdempotencyErrorBody(request, {
      type: 'request_error',
      code: 'conflict',
      detail,
    }),
  );
  return reply;
}

async function idempotencyOnRequest(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!WRITE_METHODS.has(request.method)) return;

  // Fastify runs GLOBAL onRequest hooks before a route's own `onRequest: [authenticate]`,
  // so rejecting here tells an anonymous caller about the route's idempotency contract
  // instead of returning 401. Both rejections are therefore deferred to the preHandler,
  // which is appended AFTER the route's auth preHandlers.
  const idempotencyRequired = isIdempotencyKeyRequiredForRequest(request);

  const parsed = parseIdempotencyKeyHeader(request.headers['x-idempotency-key']);
  if (parsed.kind === 'absent') return;
  if (parsed.kind === 'invalid') {
    // Routes that never opted in keep the 400: there the key is optional, so a malformed
    // one is ordinary request validation rather than a violated contract.
    if (idempotencyRequired) return;
    throw new ValidationError('errors:idempotencyKeyInvalid');
  }

  const requestWithIdempotency = request as RequestWithIdempotency;
  const idempotencyKey = parsed.value;
  requestWithIdempotency._idempotencyKey = idempotencyKey;
}

/**
 * Normalizes the `onSend` payload into a JSON-parseable cache body string.
 *
 * A successful response with no body (HTTP 204, or an empty 200) reaches `onSend` with a
 * nullish/empty payload. `JSON.stringify(undefined)` returns `undefined` (not a string),
 * which crashes the downstream `Buffer.byteLength` and 500s the response whenever a client
 * attaches an `X-Idempotency-Key` to such a write; an empty string would instead crash the
 * `JSON.parse` in {@link sendCachedIdempotencyResponse} on replay. Both empty cases collapse
 * to JSON `null` so the entry is byte-measurable here and replays as an empty body.
 */
function toIdempotencyCacheBody(payload: unknown): string {
  if (payload === undefined || payload === null || payload === '') return 'null';
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/**
 * Snapshots the outgoing response so the completed-cache write can run in `onResponse`,
 * after the request-level transaction (or any service-level transaction) has committed.
 *
 * This hook never writes to Redis directly. For error responses or oversize bodies it
 * marks the claim for release (handled in `onResponse`). For successful responses it
 * stashes the snapshot on the request; if the transaction later rolls back at the
 * framework boundary, the snapshot is dropped without persisting a fake replay entry.
 */
async function idempotencyOnSend(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const requestWithIdempotency = request as RequestWithIdempotency;
  const idempotencyKey = requestWithIdempotency._idempotencyKey;
  if (!idempotencyKey) return payload;
  if (!requestWithIdempotency._idempotencyClaimed) return payload;

  const statusCode = reply.statusCode;
  if (statusCode >= 400) {
    /**
     * Leave `_idempotencyClaimed = true` so `onResponse` releases the placeholder. We
     * intentionally do not delete here: `onResponse` is the single owner of Redis
     * mutations once the request enters the response lifecycle, which keeps the
     * "completed cache written iff transaction committed" invariant simple to reason
     * about and to test.
     */
    return payload;
  }

  const body = toIdempotencyCacheBody(payload);
  const bodyByteLength = Buffer.byteLength(body, 'utf8');
  if (bodyByteLength > IDEMPOTENCY_CACHED_BODY_BYTES) {
    logger.warn(
      { idempotencyKey, bodyByteLength, maxBytes: IDEMPOTENCY_CACHED_BODY_BYTES },
      'idempotency.cache.body.too_large',
    );
    /** Force release: oversize bodies fall through to the same path as error responses. */
    delete requestWithIdempotency._idempotencyPendingCompleted;
    return payload;
  }

  if (responseBodyContainsSecretFields(body)) {
    logger.info({ idempotencyKey }, 'idempotency.cache.secret_response_skipped');
    delete requestWithIdempotency._idempotencyPendingCompleted;
    return payload;
  }

  requestWithIdempotency._idempotencyPendingCompleted = {
    statusCode,
    body,
    headers: {
      'content-type': String(reply.getHeader('content-type') ?? 'application/json'),
    },
  };

  return payload;
}

/**
 * Options for {@link idempotencyOnResponse}. The request-lifecycle coordinator sets
 * `forceRelease` when a 2xx response was produced but the underlying RLS/business
 * transaction ultimately rolled back, so the cached entry must not be written.
 */
export type IdempotencyOnResponseOptions = {
  /**
   * When true, always delete the in-flight placeholder and never persist a completed cache
   * entry — used when the HTTP response was 2xx but the request DB transaction did not commit.
   */
  forceRelease?: boolean;
};

/**
 * Final-step Redis write. By running here (rather than in `onSend`) the completed cache
 * is only persisted after the request-level transaction has resolved — preventing the
 * documented "rolled-back write replays as 2xx" failure mode. Three terminal cases:
 *
 *  1. statusCode < 400 + pending completion stashed -> overwrite placeholder with completed entry
 *  2. statusCode >= 400 or pending completion absent (handler threw, body too large) -> DEL
 *     placeholder so the client may safely retry
 *  3. claim was never acquired -> no-op
 */
export async function idempotencyOnResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  options?: IdempotencyOnResponseOptions,
): Promise<void> {
  const requestWithIdempotency = request as RequestWithIdempotency;
  if (!requestWithIdempotency._idempotencyClaimed) return;

  const idempotencyKey = requestWithIdempotency._idempotencyKey;
  if (!idempotencyKey) return;

  const scope = requestWithIdempotency._idempotencyScope ?? resolveIdempotencyScope(request);
  const requestFingerprint = requestWithIdempotency._idempotencyRequestFingerprint;
  const cacheKey = buildIdempotencyCacheKey(idempotencyKey, scope);
  requestWithIdempotency._idempotencyClaimed = false;

  const statusCode = reply.statusCode;
  const pending = requestWithIdempotency._idempotencyPendingCompleted;
  if (options?.forceRelease === true) {
    delete requestWithIdempotency._idempotencyPendingCompleted;
    try {
      await redisConnection.del(cacheKey);
    } catch (error) {
      logger.warn({ error, idempotencyKey }, 'idempotency.cache.release.failed');
    }
    return;
  }

  if (statusCode < 400 && pending !== undefined) {
    const completed: CompletedIdempotencyEntry = {
      state: 'completed',
      statusCode: pending.statusCode,
      body: pending.body,
      headers: pending.headers,
      ...(requestFingerprint !== undefined ? { fingerprint: requestFingerprint } : {}),
    };
    try {
      await redisConnection.set(
        cacheKey,
        JSON.stringify(completed),
        'EX',
        IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      logger.warn({ error, idempotencyKey }, 'idempotency.cache.set.failed');
    }
    delete requestWithIdempotency._idempotencyPendingCompleted;
    return;
  }

  delete requestWithIdempotency._idempotencyPendingCompleted;
  try {
    await redisConnection.del(cacheKey);
  } catch (error) {
    logger.warn({ error, idempotencyKey }, 'idempotency.cache.release.failed');
  }
}

/**
 * Idempotency middleware for POST/PUT/PATCH/DELETE requests.
 *
 * When a client sends an `X-Idempotency-Key` header, the response is cached
 * in Redis for 24 hours using SETNX to prevent race conditions. Subsequent
 * requests with the same key return the cached response without
 * re-executing the handler.
 *
 * The SETNX claim runs in a route `preHandler` appended via `onRoute`, after
 * route authentication preHandlers, so unauthenticated requests do not occupy
 * Redis keys.
 */
const idempotencyMiddlewarePlugin: FastifyPluginAsync = async (application) => {
  application.addHook('onRoute', (routeOptions: RouteOptions) => {
    if (!isWriteRouteMethod(routeOptions.method)) return;

    const existingPreHandlers = (() => {
      if (routeOptions.preHandler === undefined) return [];
      if (Array.isArray(routeOptions.preHandler)) return [...routeOptions.preHandler];
      return [routeOptions.preHandler];
    })();

    routeOptions.preHandler = [...existingPreHandlers, idempotencyClaimPreHandler];
  });

  application.addHook('onRequest', idempotencyOnRequest);
  application.addHook('onSend', idempotencyOnSend);
  // The post-response cache write is dispatched by request-lifecycle.middleware.ts so it
  // runs strictly AFTER the RLS transaction has committed/rolled back. Registering an
  // `onResponse` hook here would run too early (Fastify onResponse is FIFO).
};

/** Must break encapsulation so hooks apply to routes registered after middleware on the root app. */
export default fp(idempotencyMiddlewarePlugin, { name: 'idempotency-middleware' });
