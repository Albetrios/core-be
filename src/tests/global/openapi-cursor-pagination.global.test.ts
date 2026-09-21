/**
 * OpenAPI documents cursor pagination query params on all cursor-paginated list routes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURSOR_PAGINATED_LIST_ROUTE_KEYS } from '@tooling/openapi/pagination-openapi.js';
import { routeQuerySchemaMap } from '@tooling/openapi/query-schema-map.js';

const OPENAPI_PATH = join(process.cwd(), 'docs', 'openapi', 'openapi.json');

type OpenApiParameter = { name: string; in: string };

function normalizeOpenApiPath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
}

function getQueryParameterNames(
  spec: { paths: Record<string, Record<string, { parameters?: OpenApiParameter[] }>> },
  routeKey: string,
): string[] {
  const spaceIndex = routeKey.indexOf(' ');
  const method = routeKey.slice(0, spaceIndex).toLowerCase();
  const path = normalizeOpenApiPath(routeKey.slice(spaceIndex + 1));
  const operation = spec.paths[path]?.[method];
  return (operation?.parameters ?? [])
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => parameter.name);
}

describe('OpenAPI cursor pagination', () => {
  const spec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf-8')) as {
    paths: Record<
      string,
      Record<string, { parameters?: OpenApiParameter[]; description?: string }>
    >;
  };

  it('query-schema-map covers every cursor-paginated list route', () => {
    for (const routeKey of CURSOR_PAGINATED_LIST_ROUTE_KEYS) {
      expect(routeQuerySchemaMap[routeKey], `Missing query map for ${routeKey}`).toBeDefined();
    }
  });

  it.each(CURSOR_PAGINATED_LIST_ROUTE_KEYS)(
    'documents limit and after query parameters on %s',
    (routeKey) => {
      const queryNames = getQueryParameterNames(spec, routeKey);
      expect(queryNames, `${routeKey} query params: ${queryNames.join(', ')}`).toContain('limit');
      expect(queryNames, `${routeKey} query params: ${queryNames.join(', ')}`).toContain('after');
    },
  );

  it('does not expose legacy page parameter on cursor list routes', () => {
    for (const routeKey of CURSOR_PAGINATED_LIST_ROUTE_KEYS) {
      const queryNames = getQueryParameterNames(spec, routeKey);
      expect(queryNames, `${routeKey} should not document page`).not.toContain('page');
    }
  });

  it('includes cursor pagination guidance in operation descriptions', () => {
    const operation = spec.paths['/api/v1/users/me/organizations']?.get;
    expect(operation?.description).toContain('cursor pagination');
    expect(operation?.description).toContain('meta.pagination.next');
  });

  it('documents that legacy page is no longer supported in operation descriptions', () => {
    const operation = spec.paths['/api/v1/users/me/organizations']?.get;
    expect(operation?.description).toMatch(/legacy `page`.*no longer supported/i);
  });
});
