import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RouteEntry } from '@/tests/helpers/route-catalog-registry.js';

const SRC_DIR = resolve(process.cwd(), 'src');
const DOMAINS_DIR = join(SRC_DIR, 'domains');

const HTTP_TEST_SUFFIXES = ['.integration.test.ts', '.e2e.test.ts', '.security.test.ts'];

/** Catalog domain slug (from routes.txt) → `src/domains/<folder>/`. */
export const CATALOG_DOMAIN_TO_FOLDER: Record<string, string> = {
  users: 'user',
  uploads: 'upload',
};

/**
 * Catalog domains served from `src/infrastructure` / `src/shared` rather than a
 * `src/domains/<domain>/` folder. Their HTTP coverage lives in cross-cutting test
 * locations, so the domain-scoped Tier-D / Tier-E scans must also read these files.
 */
export const INFRASTRUCTURE_DOMAIN_TEST_FILES: Record<string, string[]> = {
  mcp: ['src/tests/security/auth/mcp-auth.security.test.ts'],
};

/**
 * Domains with no mutating-route body-validation matrix requirement.
 * - health: liveness/readiness probes carry no body.
 * - mcp: JSON-RPC proxy; auth/role is the gate, not body shape.
 * - ops: the only mutating route's sole input is a path param whose invalid value
 *   is correctly a 404 (NotFoundError), never a body-validation 422.
 */
export const DOMAINS_EXEMPT_FROM_VALIDATION_STATUS = new Set(['health', 'mcp', 'ops']);

/** HTTP methods treated as mutating; only these require 400/422 validation coverage in domain tests. */
export const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Sub-domains without `*.routes.ts` that still expose HTTP handlers on a parent routes file.
 * Each must have at least one `__tests__/integration/*.integration.test.ts`.
 * Keep in sync with CLAUDE.md § Domain → sub-domain map (without routes).
 */
export const SUBDOMAIN_HTTP_INTEGRATION_WITHOUT_ROUTES: ReadonlyArray<{
  domain: string;
  resource: string;
}> = [
  { domain: 'auth', resource: 'auth-method' },
  { domain: 'auth', resource: 'auth-session' },
  { domain: 'auth', resource: 'mfa' },
  { domain: 'auth', resource: 'webauthn' },
  { domain: 'user', resource: 'user-settings' },
  { domain: 'user', resource: 'user-notification-preferences' },
  { domain: 'user', resource: 'user-data-export' },
  { domain: 'tenancy', resource: 'organization-settings' },
  { domain: 'tenancy', resource: 'organization-notification-policy' },
  { domain: 'tenancy', resource: 'organization-api-key' },
  { domain: 'tenancy', resource: 'member-invitation' },
  { domain: 'tenancy', resource: 'member-role-permission' },
  { domain: 'notify', resource: 'webhook-event' },
];

/** One method/path pair allowed to be missing from coverage (e.g. legacy routes scheduled for removal). */
export type RouteHttpCoverageAllowlistEntry = { method: string; path: string };

/** Discovered sub-domain folder containing a `*.routes.ts` file. */
export type SubdomainRouteFolder = {
  domain: string;
  resource: string;
  folder: string;
};

/** Maps a routes-catalog domain slug to its `src/domains/<folder>/` directory name. */
export function resolveDomainFolder(catalogDomain: string): string {
  return CATALOG_DOMAIN_TO_FOLDER[catalogDomain] ?? catalogDomain;
}

/** Returns true when `actualPath` matches `pattern`, treating `:param` segments in the pattern as wildcards. */
export function pathMatchesPattern(actualPath: string, pattern: string): boolean {
  const patternParts = pattern.split('/').filter((part) => part.length > 0);
  const actualParts = actualPath.split('/').filter((part) => part.length > 0);
  if (patternParts.length !== actualParts.length) return false;
  for (let index = 0; index < patternParts.length; index++) {
    const patternPart = patternParts[index];
    const actualPart = actualParts[index];
    if (!(patternPart && actualPart)) return false;
    if (patternPart.startsWith(':')) continue;
    if (patternPart !== actualPart) return false;
  }
  return true;
}

/** Returns true when (`method`, `path`) is in the coverage allowlist (exact match or wildcard pattern match). */
export function isAllowlisted(
  method: string,
  path: string,
  allowlist: RouteHttpCoverageAllowlistEntry[],
): boolean {
  return allowlist.some(
    (entry) =>
      entry.method === method && (entry.path === path || pathMatchesPattern(path, entry.path)),
  );
}

/** Recursively reads every HTTP test file under `directory` (`*.integration.test.ts`, `*.e2e.test.ts`, `*.security.test.ts`) into `sources`. */
export function collectHttpTestSources(directory: string, sources: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectHttpTestSources(fullPath, sources);
      continue;
    }
    if (!HTTP_TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    sources.push(readFileSync(fullPath, 'utf-8'));
  }
}

/** Reads every HTTP test file under a single domain and concatenates them as one searchable string. */
export function collectDomainHttpSources(catalogDomain: string): string {
  const folder = resolveDomainFolder(catalogDomain);
  const sources: string[] = [];
  collectHttpTestSources(join(DOMAINS_DIR, folder), sources);
  for (const relativePath of INFRASTRUCTURE_DOMAIN_TEST_FILES[catalogDomain] ?? []) {
    const fullPath = resolve(process.cwd(), relativePath);
    if (existsSync(fullPath)) sources.push(readFileSync(fullPath, 'utf-8'));
  }
  return sources.join('\n');
}

/** Returns true when the domain's HTTP tests reference a 403 status or `assertRouteSmokeForbidden` helper. */
export function domainHasForbiddenStatusCoverage(catalogDomain: string): boolean {
  const combined = collectDomainHttpSources(catalogDomain);
  return combined.includes('403') || combined.includes('assertRouteSmokeForbidden');
}

/** Returns true when the domain's HTTP tests reference a 400/422 status or `ValidationError`. */
export function domainHasValidationStatusCoverage(catalogDomain: string): boolean {
  const combined = collectDomainHttpSources(catalogDomain);
  return (
    combined.includes('400') || combined.includes('422') || combined.includes('ValidationError')
  );
}

/** Routes guarded by organization-permission or global-role authorization must exercise the 403 path in domain tests. */
export function requiresForbiddenStatusCoverage(route: RouteEntry): boolean {
  return route.access === 'organization-permission' || route.access === 'global-role';
}

/** Mutating routes (POST/PUT/PATCH/DELETE) must exercise body validation (400/422) in domain tests. */
export function requiresValidationStatusCoverage(route: RouteEntry): boolean {
  return MUTATING_HTTP_METHODS.has(route.method);
}

/** Returns true when the literal route path appears (in any quoting) inside the combined HTTP test sources. */
export function routeLiteralFoundInTests(combined: string, pathLiteral: string): boolean {
  return (
    combined.includes(`'${pathLiteral}'`) ||
    combined.includes(`"${pathLiteral}"`) ||
    combined.includes(`\`${pathLiteral}\``) ||
    combined.includes(pathLiteral)
  );
}

/**
 * For mutating methods, returns true when a `method: 'METHOD'` literal appears
 * within ±400 characters of a `pathLiteral` occurrence — a heuristic that the
 * tests actually exercise that method against the path.
 */
export function mutatingMethodReferencedForPath(
  combined: string,
  method: string,
  pathLiteral: string,
): boolean {
  if (!MUTATING_HTTP_METHODS.has(method)) return true;

  const methodNeedle = `method: '${method}'`;
  const methodNeedleDouble = `method: "${method}"`;
  const pathIndex = combined.indexOf(pathLiteral);
  if (pathIndex === -1) return false;

  const windowStart = Math.max(0, pathIndex - 400);
  const windowEnd = Math.min(combined.length, pathIndex + pathLiteral.length + 400);
  const window = combined.slice(windowStart, windowEnd);

  return window.includes(methodNeedle) || window.includes(methodNeedleDouble);
}

/** Extracts every domain that route-smoke helpers cover (`loadRoutesForDomain('foo')`) from the combined sources. */
export function extractDomainRouteSmokeCoverage(combinedSources: string): Set<string> {
  const coveredDomains = new Set<string>();
  const domainSmokePattern = /loadRoutesForDomain\(\s*['"]([\w-]+)['"]\s*\)/g;
  let match = domainSmokePattern.exec(combinedSources);
  while (match !== null) {
    const domain = match[1];
    if (domain) coveredDomains.add(domain);
    match = domainSmokePattern.exec(combinedSources);
  }
  return coveredDomains;
}

/** Walks `domainsDir` and returns every sub-domain folder that contains a `*.routes.ts` file. */
export function discoverSubdomainFoldersWithRoutes(domainsDir: string): SubdomainRouteFolder[] {
  const folders: SubdomainRouteFolder[] = [];
  if (!existsSync(domainsDir)) return folders;

  for (const domainEntry of readdirSync(domainsDir, { withFileTypes: true })) {
    if (!domainEntry.isDirectory()) continue;
    const subDomainsDir = join(domainsDir, domainEntry.name, 'sub-domains');
    if (!existsSync(subDomainsDir)) continue;

    for (const subEntry of readdirSync(subDomainsDir, { withFileTypes: true })) {
      if (!subEntry.isDirectory()) continue;
      const folder = join(subDomainsDir, subEntry.name);
      const hasRoutesFile = readdirSync(folder).some((fileName) => fileName.endsWith('.routes.ts'));
      if (!hasRoutesFile) continue;
      folders.push({ domain: domainEntry.name, resource: subEntry.name, folder });
    }
  }

  return folders;
}

/** Returns true when a sub-domain folder has at least one `__tests__/integration/*.integration.test.ts` file. */
export function subdomainFolderHasHttpIntegrationTest(subdomainFolder: string): boolean {
  const integrationDir = join(subdomainFolder, '__tests__', 'integration');
  if (!existsSync(integrationDir)) return false;
  return readdirSync(integrationDir).some((fileName) => fileName.endsWith('.integration.test.ts'));
}

/**
 * Combined check: every sub-domain that owns a routes file (or that
 * {@link SUBDOMAIN_HTTP_INTEGRATION_WITHOUT_ROUTES} declares as routed by a
 * parent file) must have at least one HTTP integration test.
 */
export function findMissingSubdomainIntegrationTests(domainsDir: string): string[] {
  const missing: string[] = [];

  for (const { domain, resource, folder } of discoverSubdomainFoldersWithRoutes(domainsDir)) {
    if (subdomainFolderHasHttpIntegrationTest(folder)) continue;
    missing.push(
      `${domain}/sub-domains/${resource} (*.routes.ts → missing __tests__/integration/*.integration.test.ts)`,
    );
  }

  for (const { domain, resource } of SUBDOMAIN_HTTP_INTEGRATION_WITHOUT_ROUTES) {
    const folder = join(domainsDir, domain, 'sub-domains', resource);
    if (!existsSync(folder)) continue;
    if (subdomainFolderHasHttpIntegrationTest(folder)) continue;
    missing.push(
      `${domain}/sub-domains/${resource} (HTTP on parent routes → missing __tests__/integration/*.integration.test.ts)`,
    );
  }

  return missing;
}

/** Aggregated result of {@link evaluateRouteHttpCoverage}; each array is empty when the rule passes. */
export type RouteHttpCoverageValidationResult = {
  missingSubdomainIntegration: string[];
  missingRouteLiterals: string[];
  missingMutatingMethodRefs: string[];
  missingForbiddenByDomain: string[];
  missingValidationByDomain: string[];
};

/**
 * Cross-references the live route catalog against domain HTTP test sources
 * and returns every coverage gap: missing path literals, missing
 * method-on-path references, missing 403 status assertions for guarded
 * routes, missing 400/422 validation assertions for mutating routes, and
 * sub-domain folders missing an integration test entirely.
 */
export function evaluateRouteHttpCoverage(
  registry: RouteEntry[],
  combinedHttpSources: string,
  allowlist: RouteHttpCoverageAllowlistEntry[],
  domainsDir: string,
): RouteHttpCoverageValidationResult {
  const domainSmokeCoverage = extractDomainRouteSmokeCoverage(combinedHttpSources);
  const missingRouteLiterals: string[] = [];
  const missingMutatingMethodRefs: string[] = [];
  const domainsRequiringForbidden = new Set<string>();
  const domainsRequiringValidation = new Set<string>();

  for (const route of registry) {
    if (isAllowlisted(route.method, route.path, allowlist)) continue;

    if (requiresForbiddenStatusCoverage(route)) {
      domainsRequiringForbidden.add(route.domain);
    }
    if (
      requiresValidationStatusCoverage(route) &&
      !DOMAINS_EXEMPT_FROM_VALIDATION_STATUS.has(route.domain)
    ) {
      domainsRequiringValidation.add(route.domain);
    }

    if (domainSmokeCoverage.has(route.domain)) continue;

    const pathLiteral = route.path;
    const found = routeLiteralFoundInTests(combinedHttpSources, pathLiteral);

    if (!found) {
      missingRouteLiterals.push(`${route.method} ${route.path} (${route.domain})`);
      continue;
    }

    if (!mutatingMethodReferencedForPath(combinedHttpSources, route.method, pathLiteral)) {
      missingMutatingMethodRefs.push(`${route.method} ${route.path} (${route.domain})`);
    }
  }

  const missingSubdomainIntegration = findMissingSubdomainIntegrationTests(domainsDir);

  const missingForbiddenByDomain: string[] = [];
  for (const catalogDomain of domainsRequiringForbidden) {
    if (!domainHasForbiddenStatusCoverage(catalogDomain)) {
      missingForbiddenByDomain.push(
        `${catalogDomain} (organization-permission/global-role routes require 403 or assertRouteSmokeForbidden in domain HTTP tests)`,
      );
    }
  }

  const missingValidationByDomain: string[] = [];
  for (const catalogDomain of domainsRequiringValidation) {
    if (!domainHasValidationStatusCoverage(catalogDomain)) {
      missingValidationByDomain.push(
        `${catalogDomain} (mutating routes require 400/422 validation coverage in domain HTTP tests)`,
      );
    }
  }

  return {
    missingSubdomainIntegration,
    missingRouteLiterals,
    missingMutatingMethodRefs,
    missingForbiddenByDomain,
    missingValidationByDomain,
  };
}
