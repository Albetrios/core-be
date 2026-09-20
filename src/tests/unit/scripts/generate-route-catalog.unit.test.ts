import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyAccess,
  collectAllParsedRoutes,
  inferDomainSlug,
  inferSubDomain,
  inferSubDomainLabel,
  loadDomainPrefixMap,
  toRegistryAccess,
} from '@/scripts/codegen/generate-route-catalog.js';

const ROUTES_TS_PATH = join(process.cwd(), 'src', 'routes.ts');

describe('generate-route-catalog', () => {
  it('loadDomainPrefixMap maps domain folders to API prefixes from routes.ts', () => {
    const routesTsContent = readFileSync(ROUTES_TS_PATH, 'utf-8');
    const prefixByDomainFolder = loadDomainPrefixMap(routesTsContent);

    expect(prefixByDomainFolder.get('auth')).toBe('/api/v1/auth');
    expect(prefixByDomainFolder.get('user')).toBe('/api/v1/users');
    expect(prefixByDomainFolder.get('upload')).toBe('/api/v1/uploads');
    expect(prefixByDomainFolder.get('billing')).toBe('/api/v1/billing');
    expect(prefixByDomainFolder.get('notify')).toBe('/api/v1/notify');
  });

  it('inferSubDomain returns nested folder name for sub-domain route files', () => {
    expect(inferSubDomain('billing/plan/plan.routes.ts')).toBe('plan');
    expect(inferSubDomain('tenancy/organization/organization.routes.ts')).toBe('organization');
    expect(inferSubDomain('auth/auth.routes.ts')).toBeUndefined();
  });

  it('inferSubDomainLabel title-cases kebab-case folder names', () => {
    expect(inferSubDomainLabel('member-roles')).toBe('Member Roles');
  });

  it('classifyAccess detects public, auth, role, and permission guards', () => {
    const permissionMap = new Map<string, string>([
      ['TENANCY_PERMISSIONS.ORGANIZATION_UPDATE', 'organization:update'],
    ]);

    expect(classifyAccess("app.get('/', handler)", permissionMap)).toBe('PUBLIC');
    expect(
      classifyAccess("app.get('/', { preHandler: [app.authenticate] }, handler)", permissionMap),
    ).toBe('AUTH');
    expect(
      classifyAccess(
        "app.get('/', { preHandler: [app.authenticate, requireRole(GLOBAL_ROLES.SUPER_ADMIN)] }, handler)",
        permissionMap,
      ),
    ).toBe('ROLE: super_admin');
    expect(
      classifyAccess(
        "app.patch('/', { preHandler: [app.authenticate, requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_UPDATE)] }, handler)",
        permissionMap,
      ),
    ).toBe('PERM: organization:update');
  });

  it('classifyAccess treats logout as manually bearer-token guarded', () => {
    expect(
      classifyAccess(
        "zodApplication.post('/logout', { schema: {} }, controller.logout)",
        new Map(),
      ),
    ).toBe('TOKEN: access-token');
  });

  it('classifyAccess treats refresh as session-cookie guarded, never PUBLIC', () => {
    const snippet =
      "zodApplication.post('/refresh', { ...REFRESH_RATE_LIMIT, schema: {} }, controller.refreshToken);";
    expect(classifyAccess(snippet, new Map())).toBe('TOKEN: session-cookie');
  });

  it('toRegistryAccess maps catalog labels to registry access enum', () => {
    expect(toRegistryAccess('PUBLIC')).toBe('public');
    expect(toRegistryAccess('AUTH')).toBe('authenticated');
    expect(toRegistryAccess('ROLE: admin')).toBe('global-role');
    expect(toRegistryAccess('PERM: organization:update')).toBe('organization-permission');
    expect(toRegistryAccess('TOKEN: metrics')).toBe('bearer-token');
  });

  it('inferDomainSlug normalizes API path segments', () => {
    expect(inferDomainSlug('user', '/api/v1/users/me')).toBe('user');
    expect(inferDomainSlug('upload', '/api/v1/uploads/')).toBe('upload');
    expect(inferDomainSlug('billing', '/api/v1/billing/plans')).toBe('billing');
    expect(inferDomainSlug('health', '/readyz')).toBe('health');
    expect(inferDomainSlug('ops', '/internal/ops/circuit-breakers')).toBe('ops');
  });

  it('collectAllParsedRoutes includes billing, notify, health, and MCP routes', () => {
    const routes = collectAllParsedRoutes();
    const paths = routes.map((route) => `${route.method} ${route.fullPath}`);

    expect(paths).toContain('GET /api/v1/billing/plans');
    expect(paths).toContain('GET /api/v1/notify/notifications');
    expect(paths).toContain('GET /livez');
    expect(paths).toContain('GET /readyz');
    expect(paths).toContain('POST /api/v1/mcp');
    expect(paths).toContain('GET /metrics');
    expect(paths).toContain('GET /internal/ops/circuit-breakers');
    expect(routes.length).toBeGreaterThan(100);
  });
});
