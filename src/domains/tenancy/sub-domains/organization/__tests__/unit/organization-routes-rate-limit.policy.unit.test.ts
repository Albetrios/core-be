import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * sec-r4-I2 regression — organization mutation endpoints must each carry a
 * rate-limit preset so a hijacked session or member cannot churn the organization row,
 * mint unbounded logo objects, flap settings, or delete tenants in bulk.
 *
 * Anchored per-route so a silent regression on any single path fails.
 */
describe('organization routes rate-limit policy (sec-r4-I2)', () => {
  const organizationRoutesPath = join(
    process.cwd(),
    'src/domains/tenancy/sub-domains/organization/organization.routes.ts',
  );
  const source = readFileSync(organizationRoutesPath, 'utf8');

  function findRouteBlock(httpMethod: string, urlLiteral: string): string {
    const escapedUrl = urlLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow optional generic args (e.g. zodApplication.delete<{ Params: ... }>(...))
    const pattern = new RegExp(
      `zodApplication\\.${httpMethod}(?:<[^>]*>)?\\(\\s*'${escapedUrl}',\\s*\\{([\\s\\S]*?)\\n\\s{4,6}\\},\\n\\s{4,6}\\w`,
      'm',
    );
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`route block not found: ${httpMethod.toUpperCase()} ${urlLiteral}`);
    }
    return match[1] ?? '';
  }

  it('PATCH /organization has ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT', () => {
    expect(findRouteBlock('patch', '/organization')).toContain(
      '...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT',
    );
  });

  it('DELETE /organization has EXPENSIVE_AUTHED_RATE_LIMIT (irreversible)', () => {
    expect(findRouteBlock('delete', '/organization')).toContain('...EXPENSIVE_AUTHED_RATE_LIMIT');
  });

  it('PUT /organization/logo has ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT (S3 write)', () => {
    expect(findRouteBlock('put', '/organization/logo')).toContain(
      '...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT',
    );
  });

  it('DELETE /organization/logo has ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT (S3 delete)', () => {
    expect(findRouteBlock('delete', '/organization/logo')).toContain(
      '...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT',
    );
  });

  it('PATCH /organization/settings has ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT', () => {
    expect(findRouteBlock('patch', '/organization/settings')).toContain(
      '...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT',
    );
  });
});
