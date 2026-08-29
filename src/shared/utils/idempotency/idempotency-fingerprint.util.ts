import { createHash } from 'node:crypto';
import { isSensitiveKey } from '@/shared/utils/security/sensitive-redaction.util.js';

/**
 * Route patterns that must never participate in idempotency caching (token or secret issuance).
 *
 * @remarks
 * Matched against the Fastify route template from {@link normalizeIdempotencyRoutePath}, which is
 * the FULL prefixed path (e.g. `/api/v1/auth/login`). The patterns are therefore suffix-anchored
 * (`/…$/`, not `/^\/…$/`) so they match regardless of the `/api/v{n}` version prefix. The
 * api-key issuance route is the flattened `/api/v1/tenancy/organization/api-keys` (the active organization
 * comes from the token claim — there is no `/organizations/{organization_id}` segment).
 */
const IDEMPOTENCY_EXCLUDED_ROUTE_PATTERNS: RegExp[] = [
  /\/auth\/login$/,
  /\/auth\/email\/login$/,
  /\/auth\/mfa\/login$/,
  /\/auth\/oauth\/[^/]+\/callback$/,
  /\/auth\/webauthn\/authenticate\/verify$/,
  /\/auth\/refresh$/,
  /\/tenancy\/organization\/api-keys$/,
];

/**
 * JSON field names whose presence in a cached response body would expose secrets.
 *
 * @remarks
 * sec-C/M finding #12: the prior 4-name allowlist let many secret-bearing fields slip
 * through (`token`, `secret`, `password_reset_token`, `verification_token`,
 * `mfa_recovery_code`, `private_key`, `csrf_token`, etc.). The fingerprint helper now
 * pairs this allowlist with a substring-match fall-back via {@link isSensitiveKey}
 * (same matcher Pino redaction uses), failing closed on any field whose name carries a
 * sensitive fragment. The named allowlist is retained as a fast path / regression doc.
 */
const IDEMPOTENCY_SECRET_RESPONSE_FIELD_NAMES = new Set([
  'access_token',
  'raw_key',
  'mfa_session_token',
  'refresh_token',
  // route-audit-#3: single-use / signed-URL secrets returned exactly once whose names carry no
  // sensitive fragment, so `isSensitiveKey` misses them — without this they get neither the
  // `cache-control: no-store` response header (compress.middleware) nor exclusion from the
  // idempotency response cache. `recovery_codes` = plaintext MFA-bypass codes; `download_url`
  // (GDPR data export) and `upload_url` (upload presign) embed time-boxed `X-Amz-Signature` grants.
  'recovery_codes',
  'download_url',
  'upload_url',
]);

/**
 * Normalizes a request path for idempotency fingerprinting: strips the query string and
 * collapses duplicate slashes. Prefer the Fastify route template when available so
 * `/api/v1/tenancy/organization/api-keys/:api_key_id` and concrete ids hash consistently.
 */
export function normalizeIdempotencyRoutePath(routePath: string): string {
  if (routePath.length === 0) return '/';
  const withoutQuery = routePath.split('?')[0] ?? routePath;
  return withoutQuery.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/** Lexicographic (code-point) key comparator for the canonical-serialize sort. */
function compareFingerprintKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * sec-M6: canonicalizing JSON serializer for the fingerprint body segment.
 *
 * @remarks
 * `JSON.stringify` silently drops `undefined` keys, so `{a:1, b:undefined}`
 * and `{a:1}` collide on the same fingerprint. Today benign — Zod strips
 * undefined before the middleware runs — but a future route that bypasses
 * Zod (raw JSON pass-through) would let a caller weaponize the collision
 * to replay a different body under the same idempotency key.
 *
 * The canonical form:
 *   - sorts object keys lexicographically (`{b,a}` and `{a,b}` collapse),
 *   - replaces `undefined` with the explicit marker `'__undefined__'`,
 *   - leaves arrays in declared order (insertion semantics matter for them).
 *
 * Detection guarantee: any two structurally distinct bodies (including ones
 * differing only in undefined-key presence) produce distinct fingerprints.
 */
function canonicalSerializeForFingerprint(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? '"__undefined__"';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSerializeForFingerprint(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    compareFingerprintKeys(a, b),
  );
  const segments = entries.map(
    ([key, nested]) => `${JSON.stringify(key)}:${canonicalSerializeForFingerprint(nested)}`,
  );
  return `{${segments.join(',')}}`;
}

/**
 * Builds a stable SHA-256 fingerprint segment from HTTP method, normalized route, and body.
 * Two requests with the same idempotency key but different method, route, or body must not replay.
 *
 * @remarks
 * sec-M6: uses {@link canonicalSerializeForFingerprint} so `undefined`
 * values and key ordering can't produce silent collisions.
 */
export function buildIdempotencyRequestFingerprint(parameters: {
  method: string;
  routePath: string;
  body: unknown;
}): string {
  const normalizedRoute = normalizeIdempotencyRoutePath(parameters.routePath);
  let bodySegment: string;
  if (parameters.body === undefined || parameters.body === null) {
    bodySegment = '';
  } else if (typeof parameters.body === 'string') {
    bodySegment = parameters.body;
  } else {
    bodySegment = canonicalSerializeForFingerprint(parameters.body);
  }
  const canonical = `${(parameters.method ?? 'GET').toUpperCase()}:${normalizedRoute}:${bodySegment}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Returns true when the route must not store or replay idempotent responses (auth/token issuance).
 */
export function isIdempotencyRouteExcluded(routePath: string): boolean {
  const normalized = normalizeIdempotencyRoutePath(routePath);
  return IDEMPOTENCY_EXCLUDED_ROUTE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function objectContainsSecretField(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => objectContainsSecretField(entry));
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      // sec-C/M #12: layered guard. The named allowlist is the fast path /
      // regression doc for the four most-exposed fields; `isSensitiveKey` is the
      // broad backstop that catches `token`, `secret`, `password`, `credential`,
      // `cookie`, `jwt`, `private_key`, and similar substrings. Failing closed
      // on either match is the same trade-off Pino redaction already accepts.
      if (IDEMPOTENCY_SECRET_RESPONSE_FIELD_NAMES.has(key)) return true;
      if (isSensitiveKey(key)) return true;
      if (objectContainsSecretField(nested)) return true;
    }
    return false;
  }
  return false;
}

/**
 * sec-C/M #12: substrings that indicate the body almost certainly carries a secret-bearing
 * field when JSON parsing fails. Mirrors the broader `isSensitiveKey` matcher but operates on
 * raw bytes — the parse-failure branch never sees parsed keys, so a coarse string search is
 * the only available signal. Match on the JSON-quoted form (`"<fragment>"`) and on adjacent
 * snake_case fragments (`_<fragment>"` / `<fragment>_`) to keep false positives bounded.
 */
const RESPONSE_BODY_SECRET_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'credential',
  'cookie',
  'jwt',
  'private_key',
  'api_key',
  'recovery_code',
] as const;

/**
 * Returns true when a serialized HTTP response body carries token or raw-secret fields and must
 * not be written to the idempotency Redis cache.
 */
export function responseBodyContainsSecretFields(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    return objectContainsSecretField(parsed);
  } catch {
    // safe-catch: a non-JSON body is expected (not a fault); fall back to a conservative
    // case-insensitive substring scan rather than failing the secret-exclusion check.
    const lower = body.toLowerCase();
    for (const fragment of RESPONSE_BODY_SECRET_FRAGMENTS) {
      if (
        lower.includes(`"${fragment}"`) ||
        lower.includes(`_${fragment}"`) ||
        lower.includes(`"${fragment}_`)
      ) {
        return true;
      }
    }
    return false;
  }
}
