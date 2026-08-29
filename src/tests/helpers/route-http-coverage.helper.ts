import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getRoutesByDomain, type RouteEntry } from '@/tests/helpers/route-catalog-registry.js';
import {
  getDeclaredSuccessStatus,
  loadRouteSuccessStatusMap,
} from '@/tests/helpers/route-success-status.helper.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';

export type RouteSmokeCase = {
  route: RouteEntry;
  materializedPath: string;
  expectUnauthenticated: number | number[];
  expectForbidden?: number;
  /**
   * Declared happy-path status from tooling/openapi/route-catalog/route-success-statuses.json
   * (200/204) — what the route returns for a correctly authorized, valid request.
   */
  expectSuccess: number;
};

const successStatusMap = loadRouteSuccessStatusMap();

function declaredSuccessStatus(route: RouteEntry): number {
  return getDeclaredSuccessStatus({
    method: route.method,
    path: route.path,
    map: successStatusMap,
  });
}

import {
  PARAM_NAME_TO_ENTITY,
  publicIdPlaceholderFor,
} from '@/shared/utils/identity/public-id.util.js';

/** Entity-correct placeholder for a path param (valid prefixed shape, never a real row). */
function placeholderForParamName(paramName: string): string {
  const entity = PARAM_NAME_TO_ENTITY[paramName as keyof typeof PARAM_NAME_TO_ENTITY];
  return entity ? publicIdPlaceholderFor(entity) : 'placeholder';
}

export function loadRoutesForDomain(domain: string): RouteEntry[] {
  return getRoutesByDomain(domain);
}

export function materializeRoutePath(path: string, organizationPublicId: string): string {
  return path
    .replace(':organization_id', organizationPublicId)
    .replace(/:([a-zA-Z_]+)/g, (_, name: string) => placeholderForParamName(name));
}

export function buildRouteSmokeCases(
  route: RouteEntry,
  organizationPublicId: string,
): RouteSmokeCase {
  const materializedPath = materializeRoutePath(route.path, organizationPublicId);

  switch (route.access) {
    case 'public': {
      const hasPathParam = route.path.includes(':');
      const expectUnauthenticated =
        hasPathParam && (route.method === 'GET' || route.method === 'DELETE')
          ? 404
          : hasPathParam
            ? 400
            : declaredSuccessStatus(route);
      return {
        route,
        materializedPath,
        expectUnauthenticated,
        expectSuccess: declaredSuccessStatus(route),
      };
    }
    case 'authenticated': {
      /**
       * Fastify runs schema validation before `preHandler`, so an authenticated POST/PUT/PATCH
       * with an empty payload may legitimately respond 400 (body fails Zod) before the auth
       * preHandler asserts 401. Accept both for smoke coverage.
       */
      const unauthenticatedStatus =
        route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH'
          ? [400, 401, 422]
          : 401;
      return {
        route,
        materializedPath,
        expectUnauthenticated: unauthenticatedStatus,
        expectSuccess: declaredSuccessStatus(route),
      };
    }
    case 'global-role':
      return {
        route,
        materializedPath,
        expectUnauthenticated: 401,
        expectForbidden: 403,
        expectSuccess: declaredSuccessStatus(route),
      };
    case 'organization-permission': {
      const unauthenticatedStatus =
        route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH'
          ? [400, 401, 422]
          : 401;
      return {
        route,
        materializedPath,
        expectUnauthenticated: unauthenticatedStatus,
        expectForbidden: 403,
        expectSuccess: declaredSuccessStatus(route),
      };
    }
    default:
      // `POST /auth/refresh` is bearer-token registry class but authenticates via the session
      // cookie + CSRF pair: with no credentials at all, the missing `X-CSRF-Token` is refused
      // (403) before the missing session cookie would be (401). Both are unauthenticated
      // rejections; the metrics-token routes stay strict 401.
      if (route.path.endsWith('/auth/refresh')) {
        return {
          route,
          materializedPath,
          expectUnauthenticated: [401, 403],
          expectSuccess: declaredSuccessStatus(route),
        };
      }
      return {
        route,
        materializedPath,
        expectUnauthenticated: 401,
        expectSuccess: declaredSuccessStatus(route),
      };
  }
}

export type RouteSmokeFixtures = {
  token?: string;
  organizationPublicId?: string;
  tokenWithoutPermission?: string;
};

export async function assertRouteSmokeUnauthenticated(
  application: FastifyInstance,
  smokeCase: RouteSmokeCase,
): Promise<InjectHttpResult> {
  const response = await injectUnauthenticated(application, {
    method: smokeCase.route.method,
    url: smokeCase.materializedPath,
    payload:
      smokeCase.route.method === 'GET' || smokeCase.route.method === 'DELETE' ? undefined : {},
  });
  if (Array.isArray(smokeCase.expectUnauthenticated)) {
    expect(smokeCase.expectUnauthenticated).toContain(response.statusCode);
  } else {
    expect(response.statusCode).toBe(smokeCase.expectUnauthenticated);
  }
  return response;
}

export async function assertRouteSmokeForbidden(
  application: FastifyInstance,
  smokeCase: RouteSmokeCase,
  fixtures: RouteSmokeFixtures,
): Promise<InjectHttpResult> {
  if (!fixtures.tokenWithoutPermission) {
    throw new Error('tokenWithoutPermission required for forbidden assertion');
  }
  const response = await injectAuthenticated(application, {
    method: smokeCase.route.method,
    url: smokeCase.materializedPath,
    token: fixtures.tokenWithoutPermission,
    ...(fixtures.organizationPublicId !== undefined
      ? { organizationPublicId: fixtures.organizationPublicId }
      : {}),
    ...(smokeCase.route.method !== 'GET' && smokeCase.route.method !== 'DELETE'
      ? { payload: {} }
      : {}),
  });
  const expected = smokeCase.expectForbidden ?? 403;
  expect([expected, 404]).toContain(response.statusCode);
  return response;
}
