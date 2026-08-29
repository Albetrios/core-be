import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import { env } from '@/shared/config/env.config.js';
import { getAuthenticatedActorId } from '@/shared/utils/http/request.util.js';
import { Sentry } from '@/infrastructure/observability/sentry/sentry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import { shouldEmitRateLimitTelemetry } from '@/shared/middlewares/rate-limit/rate-limit-telemetry-throttle.js';

/**
 * Per-route rate limit presets for high-risk endpoints.
 * Authenticated presets use hook `preHandler` so `keyGenerator` runs after `app.authenticate`.
 * @see https://github.com/fastify/fastify-rate-limit#custom-hook-example-usage-after-authentication
 */
function buildRateLimitKeyFromIpAddress(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

/**
 * Shared `onExceeding` observer wired into every preset below so a throttled per-email / per-user /
 * per-organization request surfaces its bucket key. Emits the same structured `rate_limit.exceeded` warning
 * as the global limiter plus a warning-level Sentry breadcrumb for trace context. Observe-only — it
 * never changes throttling behavior. Matches the `onExceeding` signature `(request, key)`.
 */
function recordRouteRateLimitExceeded(request: FastifyRequest, key: string): void {
  // Throttle the WARN + Sentry breadcrumb per key (see rate-limit-telemetry-throttle.ts) so a
  // hot per-user / per-organization bucket cannot flood logs and Sentry under load.
  if (!shouldEmitRateLimitTelemetry(key)) {
    return;
  }
  const url = request.routeOptions?.url ?? request.url;
  logger.warn({
    event: 'rate_limit.exceeded',
    ip: request.ip,
    method: request.method,
    url,
    key,
  });
  Sentry.addBreadcrumb({
    category: 'rate_limit',
    message: `Rate limit exceeded: ${key}`,
    level: 'warning',
    data: {
      method: request.method,
      url,
      ip: request.ip,
    },
  });
}

/**
 * Length of the SHA-256 hex prefix used as the per-email rate-limit bucket id (sec-re-11).
 * 16 hex chars (64 bits) is well clear of birthday collisions for the per-IP user-base
 * we'd realistically throttle in a 15-minute window, while keeping bucket keys short for
 * Redis. The full 64-char hash would also work; the trim is just hygiene.
 */
const RATE_LIMIT_EMAIL_HASH_PREFIX_LENGTH = 16;

/**
 * Derives a stable per-identity rate-limit key from the normalized email in the request body.
 * Falls back to the caller IP when no email is present (e.g. malformed body that still reaches
 * the limiter), so the bucket is never globally shared.
 *
 * sec-re-11: hash the email portion before embedding it in the key. The prior raw-email key
 * (`email:user@host.com`) was the literal value Redis stored, the value `recordRouteRateLimitExceeded`
 * logged via Pino, and the value the Sentry breadcrumb message interpolated. Pino's `redact.paths`
 * are exact-path so `key` was never matched; `redactSensitive` only catches URL/query-shaped
 * strings; the breadcrumb message isn't run through any redaction. Every credential-stuffing
 * campaign hitting the per-email cap therefore shipped its targeted addresses to BOTH Pino logs
 * AND Sentry breadcrumbs — a direct breach of the codebase's email redaction policy and the
 * `sendDefaultPii: false` Sentry posture. Hashing the email keeps the bucket stable (deterministic
 * per address) while making the log/breadcrumb value an opaque identifier.
 */
function buildRateLimitKeyFromRequestBodyEmail(request: FastifyRequest): string {
  const body = request.body as { email?: unknown } | undefined;
  const rawEmail = body?.email;
  if (typeof rawEmail === 'string') {
    const normalizedEmail = rawEmail.trim().toLowerCase();
    if (normalizedEmail.length > 0) {
      const emailHashPrefix = createHash('sha256')
        .update(normalizedEmail)
        .digest('hex')
        .slice(0, RATE_LIMIT_EMAIL_HASH_PREFIX_LENGTH);
      return `email:${emailHashPrefix}`;
    }
  }
  return `ip:${request.ip}`;
}

function buildRateLimitKeyFromAuthenticatedUserOrIpAddress(request: FastifyRequest): string {
  const auth = request.auth;
  const userId = auth && auth.kind === 'user' ? auth.userId : undefined;
  return userId ? `user:${userId}` : `ip:${request.ip}`;
}

/**
 * Builds the organization-scoped rate-limit key, namespaced by the authenticated actor
 * (`organization:<id>:actor:<userId|apiKeyPublicId>`).
 *
 * Keying on organization + actor — rather than the organization alone — prevents
 * cross-tenant rate-limit exhaustion: an actor probing `/organizations/:victimOrgId/...`
 * can only ever consume its OWN bucket within that namespace, never the shared bucket of
 * the victim org's real members (audit #14). It also isolates one member from exhausting
 * the quota of other members in the same organization. Falls back to the actor alone (no
 * verified organization context yet) and finally to the caller IP for unauthenticated edge cases.
 */
function buildRateLimitKeyFromOrganizationActorOrIpAddress(request: FastifyRequest): string {
  // Resolve the actor via the principal union so an API-key caller keys on its key public id
  // (`actor:<apiKeyPublicId>`) instead of collapsing to `ip:` — the old `userId ?? apiKeyPublicId`
  // returned the empty-string user sentinel for API keys, defeating per-actor isolation.
  const actorId = request.auth ? getAuthenticatedActorId(request.auth) : undefined;
  // Prefer the signed `org` token claim (the active organization for both user and API-key principals) over
  // the claim-derived request decoration. Without this the
  // per-(organization, actor) bucket would collapse to per-actor post-flatten, so one actor's spend
  // in one organization would throttle them everywhere instead of isolating quota by active organization.
  const requestWithOrganization = request as FastifyRequest & {
    organizationId?: string | null;
  };
  const organizationPublicId =
    request.auth?.organizationPublicId ?? requestWithOrganization.organizationId;
  if (
    organizationPublicId !== undefined &&
    organizationPublicId !== null &&
    organizationPublicId.length > 0 &&
    actorId
  ) {
    return `organization:${organizationPublicId}:actor:${actorId}`;
  }
  if (actorId) {
    return `actor:${actorId}`;
  }
  return `ip:${request.ip}`;
}

// Read from the validated env config: RATE_LIMIT_RELAXED_CAPS defaults false (hardened); development
// sets it true in `.env` and the test harness sets it true (loopback E2E + dev UX are not throttled),
// while a schema refine forbids overriding it to true in production so credential-stuffing protection stays on.
const RATE_LIMIT_CAPS_RELAXED = env.RATE_LIMIT_RELAXED_CAPS;

/**
 * Sensitive public endpoints use a tight cap in production so credentials cannot be brute-forced
 * from a single IPv4 rapidly. Lift the ceiling when RATE_LIMIT_RELAXED_CAPS is set (development/test)
 * so Playwright E2E and loopback integration suites do not trip Redis-backed 429s from parallel workers.
 */
const STRICT_PUBLIC_ROUTE_MAX_REQUESTS_PER_WINDOW = RATE_LIMIT_CAPS_RELAXED ? 5000 : 5;

/** Sensitive public auth-style endpoints — strict cap keyed by IP. */
export const STRICT_PUBLIC_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: STRICT_PUBLIC_ROUTE_MAX_REQUESTS_PER_WINDOW,
      timeWindow: MILLISECONDS_PER_MINUTE,
      keyGenerator: buildRateLimitKeyFromIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;

/**
 * Per-identity cap (5 requests / 15 min per normalized email in production) for unauthenticated
 * credential and outbound-email endpoints (login, magic-link request, password-reset request).
 * The IP-only {@link STRICT_PUBLIC_RATE_LIMIT} is spoofable, so this complements it by binding the
 * limit to the targeted account/email — blunting credential stuffing, account enumeration, and
 * mailbomb abuse on public auth routes. Lifted when RATE_LIMIT_RELAXED_CAPS is set (development/test)
 * so loopback suites that loop these routes do not produce flaky 429s.
 */
const STRICT_PUBLIC_PER_EMAIL_MAX_REQUESTS_PER_WINDOW = RATE_LIMIT_CAPS_RELAXED ? 5000 : 5;
const STRICT_PUBLIC_PER_EMAIL_WINDOW_MS = 15 * MILLISECONDS_PER_MINUTE;

/**
 * Options for an `app.rateLimit(...)` preHandler that throttles per normalized email/identity,
 * independent of IP. Pass to `app.rateLimit(...)` and add the returned hook to a route's
 * `preHandler` array; keying happens at `preHandler` so the validated body is available.
 */
export const STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS: RateLimitOptions = {
  max: STRICT_PUBLIC_PER_EMAIL_MAX_REQUESTS_PER_WINDOW,
  timeWindow: STRICT_PUBLIC_PER_EMAIL_WINDOW_MS,
  hook: 'preHandler',
  keyGenerator: buildRateLimitKeyFromRequestBodyEmail,
  onExceeding: recordRouteRateLimitExceeded,
};

const STRICT_AUTHED_MAX_REQUESTS_PER_WINDOW = RATE_LIMIT_CAPS_RELAXED ? 5000 : 10;
const MODERATE_AUTHED_MAX_REQUESTS_PER_WINDOW = RATE_LIMIT_CAPS_RELAXED ? 5000 : 30;

/**
 * Authenticated credential / abuse-sensitive mutations (10 req / 60s in production), keyed by
 * user when possible. The cap is lifted when RATE_LIMIT_RELAXED_CAPS is set (development/test) so
 * suites that loop through password change / MFA flows from a single loopback IP do not produce flaky 429s.
 */
export const STRICT_AUTHED_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: STRICT_AUTHED_MAX_REQUESTS_PER_WINDOW,
      timeWindow: MILLISECONDS_PER_MINUTE,
      hook: 'preHandler' as const,
      keyGenerator: buildRateLimitKeyFromAuthenticatedUserOrIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;

/** Moderate cap for authenticated operations that send email or mint URLs (30 req / 60s). */
export const MODERATE_AUTHED_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: MODERATE_AUTHED_MAX_REQUESTS_PER_WINDOW,
      timeWindow: MILLISECONDS_PER_MINUTE,
      hook: 'preHandler' as const,
      keyGenerator: buildRateLimitKeyFromAuthenticatedUserOrIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;

/** Token refresh (30 req / 60s), keyed by IP — runs on the default hook (onRequest). */
export const REFRESH_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: MILLISECONDS_PER_MINUTE,
      keyGenerator: buildRateLimitKeyFromIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;

/** Stripe webhook ingress (60 req / 60s per IP) — signature verified but cap abuse. */
export const WEBHOOK_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: RATE_LIMIT_CAPS_RELAXED ? 5000 : 60,
      timeWindow: MILLISECONDS_PER_MINUTE,
      keyGenerator: buildRateLimitKeyFromIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;

/**
 * Unauthenticated read-only catalog endpoints (60 req / 60s per IP) — today the public plan
 * catalog (`GET /billing/plans`, `GET /billing/plans/:plan_id`).
 *
 * @remarks
 * These routes are deliberately public (they are on the reviewed allowlist in
 * `public-route-allowlist.global.test.ts`) but they still hit Postgres on every call — the
 * `304` short-circuit only helps clients that send `If-None-Match`. Without a per-route cap
 * they were the only unauthenticated, uncapped surface in the billing domain, falling back to
 * the global limiter alone. The cap is deliberately looser than {@link STRICT_PUBLIC_RATE_LIMIT}
 * (5/min): nothing here is credential-bearing, so the threat is read amplification, not
 * brute force. Keyed by IP on the default `onRequest` hook — there is no authenticated actor
 * to key on. Lifted when RATE_LIMIT_RELAXED_CAPS is set (development/test) so loopback suites
 * that loop the catalog do not produce flaky 429s.
 */
export const PUBLIC_READ_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: RATE_LIMIT_CAPS_RELAXED ? 5000 : 60,
      timeWindow: MILLISECONDS_PER_MINUTE,
      keyGenerator: buildRateLimitKeyFromIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;

/**
 * Organization-scoped mutations (100 req / 60s), keyed by organization + authenticated
 * actor (`organization:<id>:actor:<actorId>`). Per-actor namespacing prevents cross-tenant
 * exhaustion of a victim org's shared bucket and isolates members from one another
 * (audit #14). Runs on the `preHandler` hook so it is appended AFTER the route's
 * `requireOrganizationPermission` preHandler — unauthorized callers are rejected before the
 * key is ever derived.
 */
export const ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 100,
      timeWindow: MILLISECONDS_PER_MINUTE,
      hook: 'preHandler' as const,
      keyGenerator: buildRateLimitKeyFromOrganizationActorOrIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;

/** Expensive operations (5 req / 5 min), keyed by user when possible. */
export const EXPENSIVE_AUTHED_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: 5 * MILLISECONDS_PER_MINUTE,
      hook: 'preHandler' as const,
      keyGenerator: buildRateLimitKeyFromAuthenticatedUserOrIpAddress,
      onExceeding: recordRouteRateLimitExceeded,
    },
  },
} as const;
