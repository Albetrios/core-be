/**
 * Per-operation request-header documentation. Mirrors the runtime middleware
 * truth: idempotency (`X-Idempotency-Key`, required on the 13 writes that
 * register `idempotencyRequired: true`), captcha on the public auth surface
 * (`X-Captcha-Token`), CSRF on the cookie refresh flow (`X-CSRF-Token`), and
 * Stripe's own `Stripe-Signature` on webhook ingestion.
 *
 * The active organization rides the signed `org` JWT claim (switched via
 * `/api/v1/auth/switch-to-organization` / `/auth/switch-to-personal`), NOT a
 * header — so no `X-Organization-Id` parameter is emitted on organization-scoped routes.
 * `Authorization: Bearer <ACCESS_TOKEN>` is expressed via the OpenAPI security
 * scheme, not a literal parameter.
 */

const IDEMPOTENCY_REQUIRED_ROUTE_KEYS = new Set([
  'POST /api/v1/tenancy/organizations',
  'POST /api/v1/tenancy/organization/memberships',
  'POST /api/v1/tenancy/organization/transfer-ownership',
  'POST /api/v1/tenancy/organization/roles',
  'POST /api/v1/tenancy/organization/api-keys',
  'POST /api/v1/tenancy/organization/notification-policies',
  'POST /api/v1/billing/subscriptions',
  'POST /api/v1/billing/subscriptions/{subscription_id}/change-plan',
  'POST /api/v1/billing/subscriptions/{subscription_id}/cancel',
  'POST /api/v1/billing/subscriptions/{subscription_id}/resume',
  'POST /api/v1/billing/payment-methods/setup',
  'POST /api/v1/notify/webhooks',
  'POST /api/v1/uploads',
]);

const CAPTCHA_ROUTE_KEYS = new Set([
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/mfa/login',
  'POST /api/v1/auth/email/send-code',
  'POST /api/v1/auth/email/login',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/webauthn/authenticate/options',
  'GET /api/v1/auth/oauth/{provider}',
]);

const WEBHOOK_ROUTE_KEYS = new Set(['POST /api/v1/billing/webhook']);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Builds the documented request-header parameters for one operation. */
export function buildHeaderParameters(method: string, routeKey: string): object[] {
  const headers: object[] = [];

  if (
    MUTATING_METHODS.has(method) &&
    !WEBHOOK_ROUTE_KEYS.has(routeKey) &&
    !routeKey.includes('/api/v1/mcp')
  ) {
    const required = IDEMPOTENCY_REQUIRED_ROUTE_KEYS.has(routeKey);
    headers.push({
      name: 'X-Idempotency-Key',
      in: 'header',
      required,
      description: required
        ? 'Required. A unique key (UUID recommended) making this write retry-safe: replays return the cached response (`X-Idempotency-Replay: true`), key reuse with a different payload is rejected with 422.'
        : 'Optional but recommended — auto-generate one per write in your API client. Replays within 24h return the cached response (`X-Idempotency-Replay: true`); reusing a key with a different payload is rejected with 422.',
      schema: { type: 'string', minLength: 16, maxLength: 255 },
      example: '7f9c2b4e-0d1a-4e5f-9c3b-2a1d4e5f6a7b',
    });
  }

  if (CAPTCHA_ROUTE_KEYS.has(routeKey)) {
    headers.push({
      name: 'X-Captcha-Token',
      in: 'header',
      required: true,
      description:
        'Cloudflare Turnstile token for this public auth form (bot protection). Not used on authenticated routes.',
      schema: { type: 'string' },
      example: '0.4AAAAABkT1n…',
    });
  }

  if (routeKey === 'POST /api/v1/auth/refresh') {
    headers.push({
      name: 'X-CSRF-Token',
      in: 'header',
      required: true,
      description:
        'Echo of the `csrf_token` cookie issued with the session — double-submit CSRF protection for the cookie-based refresh flow.',
      schema: { type: 'string' },
      example: 'b41c6f0e6a7d4f0c9d2e8a5b3c7d1e9f',
    });
  }

  if (WEBHOOK_ROUTE_KEYS.has(routeKey)) {
    headers.push({
      name: 'Stripe-Signature',
      in: 'header',
      required: true,
      description:
        'Set by Stripe when it delivers the event (t=timestamp,v1=HMAC signature). Your application never sends this header; the endpoint verifies it against the webhook signing secret.',
      schema: { type: 'string' },
      example: 't=1718200000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd',
    });
  }

  return headers;
}
