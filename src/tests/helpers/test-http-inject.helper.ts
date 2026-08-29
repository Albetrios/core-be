import { randomUUID } from 'node:crypto';
import type { InjectOptions } from 'light-my-request';
import type { FastifyInstance } from 'fastify';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Path suffixes of the `idempotencyRequired` CREATE routes added in EX-06. Their missing-key 422 is
 * emitted by the GLOBAL `onRequest` idempotency hook, which runs BEFORE route auth/validation — so a
 * test write to one of these without a key gets 422 instead of the 401/403/201 it intends to assert.
 * `injectRoute` auto-supplies a fresh key for exactly these create endpoints (scoped by an exact path
 * suffix so it never touches `:id` sub-routes, non-required writes like password change, or the
 * original idempotency routes whose tests pass explicit keys). An explicit key always wins.
 */
const IDEMPOTENCY_REQUIRED_CREATE_PATH_SUFFIXES = [
  '/uploads',
  '/notify/webhooks',
  '/organization/api-keys',
  '/organization/roles',
  '/organization/notification-policies',
];

function shouldAutoAddIdempotencyKey(
  method: string,
  url: string,
  headers: Record<string, string>,
): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  const path = (url.split('?')[0] ?? '').replace(/\/+$/, '');
  if (!IDEMPOTENCY_REQUIRED_CREATE_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return false;
  }
  return !Object.keys(headers).some((key) => key.toLowerCase() === 'x-idempotency-key');
}

export type InjectRouteOptions = {
  method?: InjectOptions['method'];
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
  cookies?: Record<string, string>;
  query?: Record<string, string>;
};

export type InjectHttpResult = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string>;
  body: string;
  json: () => unknown;
};

function parseCookies(setCookieHeader: string | string[] | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!setCookieHeader) return cookies;
  const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const part of parts) {
    const pair = part.split(';')[0] ?? '';
    const equalsIndex = pair.indexOf('=');
    if (equalsIndex <= 0) continue;
    const name = pair.slice(0, equalsIndex).trim();
    const value = pair.slice(equalsIndex + 1).trim();
    cookies[name] = value;
  }
  return cookies;
}

function buildCookieHeader(cookies: Record<string, string> | undefined): string | undefined {
  if (!cookies || Object.keys(cookies).length === 0) return undefined;
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function toInjectResult(response: {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}): InjectHttpResult {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    cookies: parseCookies(response.headers['set-cookie']),
    body: response.body,
    json: () => {
      if (!response.body) return undefined;
      try {
        return JSON.parse(response.body) as unknown;
      } catch {
        return undefined;
      }
    },
  };
}

export async function injectRoute(
  application: FastifyInstance,
  options: InjectRouteOptions,
): Promise<InjectHttpResult> {
  const cookieHeader = buildCookieHeader(options.cookies);
  const headers = { ...options.headers };
  if (cookieHeader) {
    headers.cookie = headers.cookie ? `${headers.cookie}; ${cookieHeader}` : cookieHeader;
  }
  if (shouldAutoAddIdempotencyKey(options.method ?? 'GET', options.url, headers)) {
    headers['x-idempotency-key'] = `idem-${randomUUID()}`;
  }

  const injectOptions: InjectOptions = {
    method: options.method ?? 'GET',
    url: options.url,
    headers,
  };
  if (options.payload !== undefined) {
    injectOptions.payload = options.payload as NonNullable<InjectOptions['payload']>;
  }
  if (options.query !== undefined) {
    injectOptions.query = options.query;
  }

  const response = await application.inject(injectOptions);

  return toInjectResult({
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[] | undefined>,
    body: response.body,
  });
}

export type InjectAuthenticatedOptions = InjectRouteOptions & {
  token: string;
  organizationPublicId?: string;
  extraHeaders?: Record<string, string>;
};

export async function injectAuthenticated(
  application: FastifyInstance,
  options: InjectAuthenticatedOptions,
): Promise<InjectHttpResult> {
  const headers: Record<string, string> = {
    ...options.extraHeaders,
    ...options.headers,
    authorization: `Bearer ${options.token}`,
  };
  if (options.organizationPublicId) {
    headers['x-organization-id'] = options.organizationPublicId;
  }
  const { token, organizationPublicId, extraHeaders, ...routeOptions } = options;
  void token;
  void organizationPublicId;
  void extraHeaders;
  return injectRoute(application, { ...routeOptions, headers });
}

export async function injectUnauthenticated(
  application: FastifyInstance,
  options: InjectRouteOptions,
): Promise<InjectHttpResult> {
  return injectRoute(application, options);
}

export type InjectWithCookiesOptions = InjectRouteOptions & {
  cookies: Record<string, string>;
};

export async function injectWithCookies(
  application: FastifyInstance,
  options: InjectWithCookiesOptions,
): Promise<InjectHttpResult> {
  return injectRoute(application, options);
}

/**
 * Organization-scoped routes pin Drizzle to a request transaction that commits in
 * `onResponse` after `inject()` resolves. Yield the event loop before follow-up reads.
 */
export async function waitForOrganizationRlsTransactionCommit(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

/** POST/PATCH/DELETE on organization-scoped routes commit in onResponse after inject() resolves. */
export async function injectAuthenticatedOrganizationMutation(
  application: FastifyInstance,
  options: InjectAuthenticatedOptions,
): Promise<InjectHttpResult> {
  const response = await injectAuthenticated(application, options);
  const method = options.method ?? 'GET';
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    await waitForOrganizationRlsTransactionCommit();
  }
  return response;
}
