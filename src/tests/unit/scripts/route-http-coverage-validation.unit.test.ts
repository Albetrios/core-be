import { describe, expect, it } from 'vitest';
import type { RouteEntry } from '@/tests/helpers/route-catalog-registry.js';
import { join, resolve } from 'node:path';
import {
  DOMAINS_EXEMPT_FROM_VALIDATION_STATUS,
  domainHasForbiddenStatusCoverage,
  domainHasValidationStatusCoverage,
  evaluateRouteHttpCoverage,
  findMissingSubdomainIntegrationTests,
  isAllowlisted,
  mutatingMethodReferencedForPath,
  pathMatchesPattern,
  requiresForbiddenStatusCoverage,
  requiresValidationStatusCoverage,
  resolveDomainFolder,
  routeLiteralFoundInTests,
  subdomainFolderHasHttpIntegrationTest,
} from '@/scripts/validators/routes/route-http-coverage-validation.util.js';

const DOMAINS_DIR = resolve(process.cwd(), 'src/domains');

const sampleRoute = (overrides: Partial<RouteEntry>): RouteEntry => ({
  method: 'GET',
  path: '/api/v1/tenancy/organization',
  domain: 'tenancy',
  access: 'organization-permission',
  description: 'sample',
  ...overrides,
});

describe('route-http-coverage-validation.util', () => {
  it('detects mcp 403 coverage from its real infrastructure test location', () => {
    expect(domainHasForbiddenStatusCoverage('mcp')).toBe(true);
  });

  it('exempts ops from Tier-E validation (param-not-found is a 404, not a body 422)', () => {
    expect(DOMAINS_EXEMPT_FROM_VALIDATION_STATUS.has('ops')).toBe(true);
  });

  it('maps catalog domain slugs to domain folders', () => {
    expect(resolveDomainFolder('users')).toBe('user');
    expect(resolveDomainFolder('uploads')).toBe('upload');
    expect(resolveDomainFolder('tenancy')).toBe('tenancy');
  });

  it('matches allowlist patterns with path parameters', () => {
    expect(isAllowlisted('POST', '/api/v1/mcp', [{ method: 'POST', path: '/api/v1/mcp' }])).toBe(
      true,
    );
    expect(pathMatchesPattern('/api/v1/foo/bar', '/api/v1/:id/bar')).toBe(true);
    expect(pathMatchesPattern('/api/v1/foo/other', '/api/v1/:id/bar')).toBe(false);
  });

  it('detects missing 403 coverage for domains with permission routes', () => {
    const registry = [
      sampleRoute({ domain: 'coverage-test-no-forbidden', access: 'organization-permission' }),
      sampleRoute({ domain: 'billing', access: 'authenticated' }),
    ];
    const result = evaluateRouteHttpCoverage(
      registry,
      'loadRoutesForDomain("billing")\n',
      [],
      DOMAINS_DIR,
    );
    expect(
      result.missingForbiddenByDomain.some((line) => line.startsWith('coverage-test-no-forbidden')),
    ).toBe(true);
    expect(result.missingForbiddenByDomain.some((line) => line.startsWith('billing'))).toBe(false);
  });

  it('detects missing 400/422 validation coverage for mutating-route domains', () => {
    const registry = [
      sampleRoute({
        domain: 'coverage-test-no-validation',
        method: 'POST',
        path: '/api/v1/coverage-test',
        access: 'authenticated',
      }),
    ];
    const result = evaluateRouteHttpCoverage(registry, '', [], DOMAINS_DIR);
    expect(
      result.missingValidationByDomain.some((line) =>
        line.startsWith('coverage-test-no-validation'),
      ),
    ).toBe(true);
  });

  it('exempts health and mcp from validation status tier', () => {
    expect(
      requiresValidationStatusCoverage(sampleRoute({ method: 'POST', domain: 'health' })),
    ).toBe(true);
    const registry = [sampleRoute({ method: 'POST', domain: 'mcp', access: 'authenticated' })];
    const result = evaluateRouteHttpCoverage(registry, '', [], DOMAINS_DIR);
    expect(result.missingValidationByDomain).toHaveLength(0);
  });

  it('flags missing route literals and mutating method references', () => {
    const registry = [
      sampleRoute({
        path: '/api/v1/tenancy/organization/memberships/:membership_id/missing',
        method: 'PATCH',
      }),
    ];
    const combined =
      "inject({ method: 'GET', url: '/api/v1/tenancy/organization/memberships/:membership_id' })";
    const result = evaluateRouteHttpCoverage(registry, combined, [], DOMAINS_DIR);
    expect(result.missingRouteLiterals[0]).toContain('missing');
    expect(
      mutatingMethodReferencedForPath(
        combined,
        'PATCH',
        '/api/v1/tenancy/organization/memberships/:membership_id/missing',
      ),
    ).toBe(false);
  });

  it('requires forbidden coverage for organization-permission and global-role routes', () => {
    expect(
      requiresForbiddenStatusCoverage(sampleRoute({ access: 'organization-permission' })),
    ).toBe(true);
    expect(requiresForbiddenStatusCoverage(sampleRoute({ access: 'global-role' }))).toBe(true);
    expect(requiresForbiddenStatusCoverage(sampleRoute({ access: 'authenticated' }))).toBe(false);
  });

  it('reads live domain HTTP tests for tenancy and user folders', () => {
    expect(domainHasForbiddenStatusCoverage('tenancy')).toBe(true);
    expect(domainHasForbiddenStatusCoverage('users')).toBe(true);
    expect(domainHasValidationStatusCoverage('billing')).toBe(true);
    expect(routeLiteralFoundInTests("url: '/api/v1/foo'", '/api/v1/foo')).toBe(true);
  });

  it('detects sub-domains with routes but no integration folder', () => {
    const folder = join(DOMAINS_DIR, 'coverage-test', 'sub-domains', 'missing-integration');
    expect(subdomainFolderHasHttpIntegrationTest(folder)).toBe(false);
  });

  it('reports no missing subdomain integration for the live repo', () => {
    expect(findMissingSubdomainIntegrationTests(DOMAINS_DIR)).toEqual([]);
  });
});
