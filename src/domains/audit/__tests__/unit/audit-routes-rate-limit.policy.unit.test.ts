import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Route-policy regression for the audit domain — the sibling of the files that already pin
 * auth, user, billing/subscription, tenancy/membership, tenancy/organization, and upload.
 *
 * Audit was the last routed domain whose route file carried no `config` block at all: its one
 * registration declared `onRequest`, `preHandler`, and `schema` and fell back to the global
 * limiter. `GET /logs` is a cursor-paginated read over an append-only, unbounded-growth ledger
 * with an opt-in `include_total` count(*) — cheap to issue, expensive to serve, and reachable
 * in a loop by any holder of a valid SUPER_ADMIN / ADMIN token.
 *
 * Enforced textually against the route file rather than at runtime because Fastify's per-route
 * `config` is buried behind plugin encapsulation. The check is brace-balanced rather than
 * regex-terminated so a nested `schema: { ... }` block cannot truncate the extracted options
 * object and hide a dropped preset.
 */
describe('audit routes rate-limit + authorization policy', () => {
  const auditRoutesPath = join(process.cwd(), 'src/domains/audit/audit.routes.ts');
  const source = readFileSync(auditRoutesPath, 'utf8');

  const RATE_LIMIT_PRESET = '...MODERATE_AUTHED_RATE_LIMIT';

  /** Returns the full, brace-balanced route-options object for a registration. */
  function findRouteOptions(httpMethod: string, urlLiteral: string): string {
    const escapedUrl = urlLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const header = new RegExp(`zodApplication\\.${httpMethod}\\(\\s*'${escapedUrl}',\\s*\\{`, 'm');
    const match = header.exec(source);
    if (!match) {
      throw new Error(`route registration not found: ${httpMethod.toUpperCase()} ${urlLiteral}`);
    }

    const openingBraceIndex = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = openingBraceIndex; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{') depth += 1;
      if (character === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(openingBraceIndex, index + 1);
      }
    }
    throw new Error(`unbalanced route options: ${httpMethod.toUpperCase()} ${urlLiteral}`);
  }

  it('GET /logs has MODERATE_AUTHED_RATE_LIMIT applied (cursor read over an unbounded ledger)', () => {
    expect(findRouteOptions('get', '/logs')).toContain(RATE_LIMIT_PRESET);
  });

  /**
   * The preset is only safe because it runs on the `preHandler` hook: fastify-rate-limit appends
   * its hook AFTER the route's own `preHandler` array, so `requireRole` rejects a non-admin before
   * the bucket key is derived. Pinning the gate here means a refactor cannot drop the role check
   * and leave the rate limit as the only thing standing between a plain user and the ledger.
   */
  it('GET /logs keeps requireRole(SUPER_ADMIN, ADMIN) ahead of the limiter', () => {
    const options = findRouteOptions('get', '/logs');
    expect(options).toContain('requireRole(GLOBAL_ROLES.SUPER_ADMIN)');
    expect(options).toContain('onRequest: [app.authenticate]');
  });

  /**
   * `/logs` is the whole domain-owned HTTP surface. The organization-scoped twin
   * (`GET /api/v1/tenancy/organization/audit-logs`) is deliberately registered in tenancy's route
   * file under `audit-log:read`, not here. A second registration appearing in this file is either
   * an un-capped new route or the tenancy twin being moved without its permission gate — both
   * worth failing on.
   */
  it('audit registers exactly one route', () => {
    const registrations = source.match(/zodApplication\.(get|post|put|patch|delete)\(/g) ?? [];
    expect(registrations).toEqual(['zodApplication.get(']);
  });
});
