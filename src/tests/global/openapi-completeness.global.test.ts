/**
 * OpenAPI completeness — no bare generic request bodies; catalog routes appear in spec.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTES_WITHOUT_JSON_BODY } from '@tooling/openapi/routes-without-json-body.js';
import { loadRouteRegistryFromCatalog } from '@/tests/helpers/route-catalog-registry.js';

const OPENAPI_PATH = join(process.cwd(), 'docs', 'openapi', 'openapi.json');

function isBareGenericObjectSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') {
    return false;
  }
  const record = schema as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 1 && record.type === 'object';
}

function normalizeOpenApiPath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
}

function collectOpenApiRouteKeys(spec: {
  paths: Record<string, Record<string, { requestBody?: unknown }>>;
}): Set<string> {
  const keys = new Set<string>();
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const normalizedPath = normalizeOpenApiPath(path);
    for (const [method] of Object.entries(pathItem)) {
      keys.add(`${method.toUpperCase()} ${normalizedPath}`);
    }
  }
  return keys;
}

describe('OpenAPI completeness', () => {
  const spec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf-8')) as {
    paths: Record<string, Record<string, { requestBody?: unknown }>>;
  };

  it('has no bare generic JSON request body schemas', () => {
    const violations: string[] = [];

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const routeKey = `${method.toUpperCase()} ${path}`;
        if (ROUTES_WITHOUT_JSON_BODY.has(routeKey)) {
          continue;
        }

        const requestBody = operation.requestBody as
          | { content?: { 'application/json'?: { schema?: unknown } } }
          | undefined;
        const schema = requestBody?.content?.['application/json']?.schema;
        if (schema && isBareGenericObjectSchema(schema)) {
          violations.push(routeKey);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('advertises the bearerAuth security scheme on protected routes and omits it on public routes', () => {
    // Drift guard for `getRouteSecurity` / `PUBLIC_ROUTE_KEYS`: the active organization rides the token claim,
    // so every authenticated route must require bearerAuth and every PUBLIC route (auth forms,
    // Stripe-signed webhooks, health, plans) must NOT advertise a JWT requirement. If a NEW public
    // route is added but not exempted, this fails — preventing the OpenAPI from over-stating auth.
    const registry = loadRouteRegistryFromCatalog();
    const securityByKey = spec.paths as unknown as Record<
      string,
      Record<string, { security?: unknown[] }>
    >;
    const mismatches: string[] = [];
    for (const route of registry) {
      if (route.path.startsWith('/mcp')) continue; // MCP transport documented separately
      const openApiPath = normalizeOpenApiPath(route.path.replace(/:([^/]+)/g, '{$1}'));
      const operation = securityByKey[openApiPath]?.[route.method.toLowerCase()];
      if (!operation) continue; // existence is covered by the completeness test above
      const hasBearer =
        Array.isArray(operation.security) &&
        operation.security.some((s) => s && typeof s === 'object' && 'bearerAuth' in s);
      const hasSessionCookie =
        Array.isArray(operation.security) &&
        operation.security.some((s) => s && typeof s === 'object' && 'sessionCookie' in s);
      const isPublic = route.access === 'public';
      const isSessionCookieRoute = route.path.endsWith('/auth/refresh');
      if (isPublic && hasBearer) {
        mismatches.push(`${route.method} ${openApiPath} is PUBLIC but advertises bearerAuth`);
      }
      // Refresh authenticates via the session cookie + CSRF header (its own scheme); the cookie
      // scheme must not creep onto any other route, and refresh must not fall back to bearerAuth.
      if (hasSessionCookie && !isSessionCookieRoute) {
        mismatches.push(
          `${route.method} ${openApiPath} advertises sessionCookie but is not refresh`,
        );
      }
      if (isSessionCookieRoute && !hasSessionCookie) {
        mismatches.push(`${route.method} ${openApiPath} must advertise the sessionCookie scheme`);
      }
      if (!(isPublic || hasBearer || (isSessionCookieRoute && hasSessionCookie))) {
        mismatches.push(`${route.method} ${openApiPath} is ${route.access} but has no bearerAuth`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  const isOpenApiCatalogRoute = (route: { access: string; path: string }) =>
    route.access !== 'bearer-token' && !route.path.startsWith('/mcp');

  it('includes every OpenAPI-documentable route from docs/routes.txt', () => {
    const registry = loadRouteRegistryFromCatalog();
    const openApiKeys = collectOpenApiRouteKeys(spec);

    const allowlistedMissing = new Set<string>([
      // Registered outside domain *.routes.ts scan (health is added explicitly in generator)
    ]);

    const missing: string[] = [];
    for (const route of registry.filter(isOpenApiCatalogRoute)) {
      const openApiPath = normalizeOpenApiPath(route.path.replace(/:([^/]+)/g, '{$1}'));
      const key = `${route.method} ${openApiPath}`;
      if (!(openApiKeys.has(key) || allowlistedMissing.has(key))) {
        missing.push(key);
      }
    }

    expect(
      missing,
      `OpenAPI missing ${missing.length} catalog route(s). Run pnpm docs:generate. First: ${missing.slice(0, 5).join(', ')}`,
    ).toEqual([]);
  });

  it('documents at least as many operations as the route catalog', () => {
    const openApiCatalogRouteCount =
      loadRouteRegistryFromCatalog().filter(isOpenApiCatalogRoute).length;
    expect(collectOpenApiRouteKeys(spec).size).toBeGreaterThanOrEqual(openApiCatalogRouteCount);
  });
});
