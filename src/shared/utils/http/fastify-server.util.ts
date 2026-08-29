import { randomUUID } from 'node:crypto';
import { LogController, type FastifyServerOptions } from 'fastify';

/** fastify's trust-proxy predicate form (the type itself is not re-exported by fastify@5.12). */
type TrustProxyFunction = Extract<
  NonNullable<FastifyServerOptions['trustProxy']>,
  (address: string, hop: number) => boolean
>;
import type { IncomingMessage } from 'node:http';
import { env } from '@/shared/config/env.config.js';
import { DEFAULT_BODY_LIMIT_BYTES } from '@/shared/constants/limits.constants.js';
import { TEN_SECONDS_MS, THIRTY_SECONDS_MS } from '@/shared/constants/ttl.constants.js';
import {
  redactSensitive,
  SENSITIVE_KEY_FRAGMENTS,
} from '@/shared/utils/security/sensitive-redaction.util.js';

/**
 * Explicit NESTED Pino redact paths (header/body shapes Pino cannot reach by bare key name).
 * The bare top-level keys come from the single source {@link SENSITIVE_KEY_FRAGMENTS}; this list
 * only adds the dotted/bracketed paths plus `secret_access_key` (caught recursively by the
 * `secret` fragment, but pinned here for the exact Pino fast-path).
 */
const PINO_REDACT_NESTED_PATHS = [
  'secret_access_key',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'body.password',
  'body.token',
  'body.secret',
  'body.access_token',
  'body.refresh_token',
  'body.email',
  'req.body.email',
] as const;

/**
 * Shared Pino redact paths — fast exact-path scrubbing for well-known fields. The bare key set
 * is DERIVED from {@link SENSITIVE_KEY_FRAGMENTS} (audit #27: one source of truth, no drift)
 * and combined with {@link PINO_REDACT_NESTED_PATHS}. Recursive, case-insensitive scrubbing of
 * everything else is handled by the `redactSensitive` formatter.
 */
export const PINO_REDACT_PATHS = [...SENSITIVE_KEY_FRAGMENTS, ...PINO_REDACT_NESTED_PATHS] as const;

/**
 * Resolves the Fastify `trustProxy` value from the validated env. `TRUST_PROXY` is parsed
 * by the schema into `false | number` (a hop count); this normalizes to the shape Fastify
 * accepts and never trusts a bare boolean `true`.
 */
export function resolveTrustProxy(): boolean | TrustProxyFunction {
  const trustProxy = env.TRUST_PROXY;
  if (typeof trustProxy === 'number') {
    // fastify@5.12 removed `number` from the trustProxy TYPE; the runtime hop
    // semantics ("trust the first n hops") are preserved by compiling the env
    // number to the equivalent predicate fastify used internally.
    const trustedHops = trustProxy;
    return (_address: string, hopIndex: number) => hopIndex < trustedHops;
  }
  return false;
}

/**
 * Maximum accepted length for a client-supplied `x-request-id`. Bounds memory/log size and
 * comfortably covers a canonical UUID (36 chars) plus common tracing token formats.
 */
const MAX_INBOUND_REQUEST_IDENTIFIER_LENGTH = 128;

/**
 * Strict allow-list for inbound `x-request-id` values: a non-empty token of safe correlation-id
 * characters (alphanumerics, hyphen, underscore) within {@link MAX_INBOUND_REQUEST_IDENTIFIER_LENGTH}.
 * Canonical UUIDs satisfy this pattern. Anything else (whitespace, control chars, separators,
 * oversized values) is rejected so attackers cannot inject arbitrary correlation ids, collide
 * with other traffic, or poison incident triage — those requests get a server-generated id.
 */
const SAFE_INBOUND_REQUEST_IDENTIFIER_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{1,${MAX_INBOUND_REQUEST_IDENTIFIER_LENGTH}}$`,
);

/**
 * Returns the client-supplied `x-request-id` value when it passes the strict allow-list, or
 * undefined otherwise. Exported so the request-context middleware can attach the raw client
 * value as a SEPARATE log field (`client_request_id`) without ever promoting it to the
 * authoritative server-side correlation id (sec-C/M finding #27).
 */
export function isSafeInboundRequestIdentifier(candidate: string): boolean {
  return SAFE_INBOUND_REQUEST_IDENTIFIER_PATTERN.test(candidate);
}

/**
 * Pull the client-supplied `x-request-id` from inbound request headers when it passes the
 * strict allow-list, or return undefined. Used by the request-context middleware to expose
 * the value as a separate `x-client-request-id` response header + `clientRequestId` log
 * field, keeping distributed-tracing UX intact while ensuring the server-minted UUID is
 * always the authoritative correlation id (sec-C/M finding #27).
 */
export function extractClientSuppliedRequestIdentifier(
  headers: IncomingMessage['headers'],
): string | undefined {
  const headerValue = headers['x-request-id'];
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof candidate === 'string' && isSafeInboundRequestIdentifier(candidate)) {
    return candidate;
  }
  return undefined;
}

/**
 * sec-C/M finding #27: always mint a fresh server-side correlation id. The prior
 * implementation accepted any well-formed inbound `x-request-id` as the PRIMARY id —
 * which Sentry tags, Pino structured logs, and `meta.request_id` error payloads all
 * inherit. An attacker could replay a victim's id to pollute incident triage, plant a
 * chosen id to bait on-call into the wrong trace, or interfere with deduplication
 * tooling. The client value is still surfaced separately via
 * {@link extractClientSuppliedRequestIdentifier} so legitimate distributed tracing
 * (clients that DO want their id preserved for correlation across hops) keeps working,
 * but the server-side id is always authoritative.
 */
function resolveIncomingRequestIdentifier(_incomingMessage: IncomingMessage): string {
  return randomUUID();
}

/**
 * Builds the canonical {@link FastifyServerOptions} used by both the HTTP server and the
 * worker health server: Pino logger with {@link PINO_REDACT_PATHS} plus recursive
 * `redactSensitive` formatter, `pino-pretty` only in local, `trustProxy` resolved from
 * env (required behind Railway/LB), correlation id propagation from `x-request-id`
 * (accepted only when it matches {@link SAFE_INBOUND_REQUEST_IDENTIFIER_PATTERN}, otherwise a
 * server-side UUID is generated), and the platform body-limit, request-timeout, and
 * connection-timeout defaults.
 */
export function buildFastifyServerOptions(): FastifyServerOptions {
  return {
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [...PINO_REDACT_PATHS],
        censor: '[REDACTED]',
      },
      formatters: {
        log: (object) => redactSensitive(object),
      },
      ...(env.LOG_PRETTY
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' },
            },
          }
        : {}),
    },
    // Drop Fastify's automatic per-request "incoming request" / "request completed" info logs.
    // Each was run through the recursive `redactSensitive` formatter + Pino transport on every
    // request — a load test attributed ~25% of throughput / ~23% of p99 to that volume. Request
    // observability is preserved via Prometheus /metrics (counts, latency histograms, status),
    // the `Server-Timing` header, and the error handler (which logs failures). Explicit
    // `request.log.*` calls and error logging are unaffected.
    //
    // Passed via a `LogController` instance rather than the top-level `disableRequestLogging`
    // flag, which fastify@5.10 deprecated (FSTDEP023) and fastify@6 removes. In 5.10 the option
    // must be a `LogController` instance — a plain `{ disableRequestLogging: true }` object throws
    // `FST_ERR_LOG_INVALID_LOG_CONTROLLER`.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: resolveTrustProxy(),
    genReqId: (request) => resolveIncomingRequestIdentifier(request),
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    requestTimeout: env.FASTIFY_REQUEST_TIMEOUT_MS ?? THIRTY_SECONDS_MS,
    connectionTimeout: env.FASTIFY_CONNECTION_TIMEOUT_MS ?? TEN_SECONDS_MS,
    // On shutdown, keep-alive sockets sitting idle between requests are closed by Node itself
    // (native `server.close()` reaps idle connections on Node >= 19), while in-flight requests
    // drain normally. Must stay `false`: fastify 5.9.0 (fastify/fastify#6669) made the previous
    // `'idle'` value fall through to `closeAllConnections()` on native servers, which destroys
    // ACTIVE sockets mid-request — every in-flight request during a rolling deploy would die
    // with a connection reset (caught by shutdown-drain.integration.test.ts).
    forceCloseConnections: false,
  };
}
