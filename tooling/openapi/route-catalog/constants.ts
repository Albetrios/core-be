import { join } from 'node:path';
import type { ParsedRoute } from './types.js';

export const DOMAINS_ROOT = join(process.cwd(), 'src', 'domains');
export const ROUTES_TS_PATH = join(process.cwd(), 'src', 'routes.ts');
export const CATALOG_OUTPUT_PATH = join(process.cwd(), 'docs', 'routes.txt');
export const ROUTE_SUCCESS_STATUS_PATH = join(
  process.cwd(),
  'tooling',
  'openapi',
  'route-catalog',
  'route-success-statuses.json',
);
export const ROUTE_ORG_SCOPE_PATH = join(
  process.cwd(),
  'tooling',
  'openapi',
  'route-catalog',
  'route-organization-scope.json',
);
export const METHOD_ORDER = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

export const DOMAIN_LABELS: Record<string, string> = {
  '/api/v1/auth': 'AUTH',
  '/api/v1/users': 'USER',
  '/api/v1/audit': 'AUDIT',
  '/api/v1/tenancy': 'TENANCY',
  '/api/v1/billing': 'BILLING',
  '/api/v1/notify': 'NOTIFY',
  '/api/v1/uploads': 'UPLOAD',
  '/api/v1/mcp': 'MCP',
  '/livez': 'HEALTH',
  '/metrics': 'METRICS',
  '/internal/ops': 'OPS',
};

export const ROUTE_METHOD_PATTERN = /\b[a-zA-Z][\w$]*\.(get|post|patch|put|delete)\s*[(<]/g;
export const ROUTE_PATH_PATTERN = /['"]([/][^'"]*)['"]/;

export const SUPPLEMENTAL_ROUTES: ParsedRoute[] = [
  {
    method: 'GET',
    fullPath: '/livez',
    access: 'PUBLIC',
    domainKey: '/livez',
    domain: 'health',
  },
  {
    method: 'GET',
    fullPath: '/readyz',
    access: 'PUBLIC',
    domainKey: '/livez',
    domain: 'health',
  },
  {
    method: 'GET',
    fullPath: '/api/v1/mcp',
    access: 'ROLE: super_admin',
    domainKey: '/api/v1/mcp',
    domain: 'mcp',
  },
  {
    method: 'POST',
    fullPath: '/api/v1/mcp',
    access: 'ROLE: super_admin',
    domainKey: '/api/v1/mcp',
    domain: 'mcp',
  },
  {
    method: 'GET',
    fullPath: '/metrics',
    access: 'TOKEN: metrics',
    domainKey: '/metrics',
    domain: 'metrics',
  },
  {
    method: 'GET',
    fullPath: '/internal/ops/circuit-breakers',
    access: 'TOKEN: metrics',
    domainKey: '/internal/ops',
    domain: 'ops',
  },
  {
    method: 'POST',
    fullPath: '/internal/ops/circuit-breakers/:circuit_name/reset',
    access: 'TOKEN: metrics',
    domainKey: '/internal/ops',
    domain: 'ops',
  },
];
