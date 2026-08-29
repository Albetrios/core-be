/**
 * Route HTTP coverage gate — three-tier matrix (see below).
 *
 * ## Coverage matrix
 *
 * | Tier | Signal | Satisfies route when |
 * | ---- | ------ | -------------------- |
 * | **A — domain smoke** | `loadRoutesForDomain('<domain>')` in `*-route-smoke.integration.test.ts` | Route's domain has domain-level smoke (unauthenticated / public probe per catalog route) |
 * | **B — sub-domain integration** | `sub-domains/<resource>/__tests__/integration/*.integration.test.ts` exists | Required for every sub-domain `*.routes.ts` and listed without-routes HTTP handlers |
 * | **C — route literal** | Catalog `path` appears quoted in HTTP test sources | Direct reference in integration, e2e, or security tests |
 * | **D — forbidden (403)** | Domain HTTP tests include `403` or `assertRouteSmokeForbidden` | Required when catalog lists organization-permission / global-role routes |
 * | **E — validation (400/422)** | Domain HTTP tests include `400`, `422`, or validation assertions | Required for domains with mutating routes (except health/mcp) |
 *
 * A route passes tier C when **A or C** holds (and is not allowlisted).
 * Tiers **D** and **E** are enforced per catalog domain slug.
 *
 * Usage: `pnpm validate:route-http-coverage`
 */
import { resolve, join } from 'node:path';
import { loadRouteRegistryFromCatalog } from '@/tests/helpers/route-catalog-registry.js';
import {
  collectHttpTestSources,
  evaluateRouteHttpCoverage,
} from '@/scripts/validators/routes/route-http-coverage-validation.util.js';
import { ROUTE_HTTP_COVERAGE_ALLOWLIST } from './route-http-coverage.allowlist.js';

const SRC_DIR = resolve(process.cwd(), 'src');
const DOMAINS_DIR = join(SRC_DIR, 'domains');

function main(): void {
  const registry = loadRouteRegistryFromCatalog();
  const sources: string[] = [];
  collectHttpTestSources(SRC_DIR, sources);
  const combined = sources.join('\n');

  const result = evaluateRouteHttpCoverage(
    registry,
    combined,
    ROUTE_HTTP_COVERAGE_ALLOWLIST,
    DOMAINS_DIR,
  );

  const failures = [
    ...result.missingSubdomainIntegration,
    ...result.missingForbiddenByDomain,
    ...result.missingValidationByDomain,
    ...result.missingRouteLiterals,
    ...result.missingMutatingMethodRefs,
  ];

  if (failures.length > 0) {
    console.error('validate-route-http-coverage failed:\n');
    if (result.missingSubdomainIntegration.length > 0) {
      console.error('Tier B — sub-domain integration files:\n');
      for (const line of result.missingSubdomainIntegration) console.error(`  - ${line}`);
    }
    if (result.missingForbiddenByDomain.length > 0) {
      console.error('\nTier D — forbidden (403) coverage by domain:\n');
      for (const line of result.missingForbiddenByDomain) console.error(`  - ${line}`);
    }
    if (result.missingValidationByDomain.length > 0) {
      console.error('\nTier E — validation (400/422) coverage by domain:\n');
      for (const line of result.missingValidationByDomain) console.error(`  - ${line}`);
    }
    if (result.missingRouteLiterals.length > 0) {
      console.error('\nTier C — route path literals in HTTP tests:\n');
      for (const line of result.missingRouteLiterals.slice(0, 50)) console.error(`  - ${line}`);
      if (result.missingRouteLiterals.length > 50) {
        console.error(`  ... and ${result.missingRouteLiterals.length - 50} more`);
      }
    }
    if (result.missingMutatingMethodRefs.length > 0) {
      console.error('\nTier C — mutating HTTP method near path in tests:\n');
      for (const line of result.missingMutatingMethodRefs.slice(0, 30))
        console.error(`  - ${line}`);
      if (result.missingMutatingMethodRefs.length > 30) {
        console.error(`  ... and ${result.missingMutatingMethodRefs.length - 30} more`);
      }
    }
    process.exit(1);
  }

  console.log(
    `✅ validate-route-http-coverage passed (${registry.length} routes; tiers B–E including 403/400 gates)`,
  );
}

main();
