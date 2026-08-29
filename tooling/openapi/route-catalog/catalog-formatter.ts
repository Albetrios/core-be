import { loadConfig } from '@tooling/setup/common/config.js';
import { DOMAIN_LABELS, METHOD_ORDER } from './constants.js';
import { loadPermissionConstantMap } from './prefix-map.js';
import type { ParsedRoute } from './types.js';

const SEPARATOR =
  '================================================================================';

/** Order permission-code groups by domain familiarity; unknown groups sort last, then alphabetically. */
const PERMISSION_DOMAIN_ORDER = ['Tenancy', 'Billing', 'Notify', 'Audit', 'Upload'];

function formatRouteLine(route: ParsedRoute): string {
  const methodColumn = route.method.padEnd(6, ' ');
  const pathColumn = route.fullPath.padEnd(55, ' ');
  const statusColumn = (
    route.successStatus !== undefined ? String(route.successStatus) : '???'
  ).padEnd(3, ' ');
  const idempotencyColumn = (route.idempotencyRequired ? 'req' : '-').padEnd(3, ' ');
  const organizationScopeColumn = (route.organizationScope ?? '???').padEnd(4, ' ');
  return `  ${methodColumn} ${pathColumn}  ${statusColumn}  ${idempotencyColumn}  ${organizationScopeColumn}  ${route.access}`;
}

function permissionDomainLabel(objectName: string): string {
  const base = objectName.replace(/_PERMISSIONS$/, '');
  return base.length > 0 ? base.charAt(0) + base.slice(1).toLowerCase() : objectName;
}

function buildPermissionCodesSection(permissionMap: Map<string, string>): string[] {
  const codesByDomain = new Map<string, Set<string>>();
  for (const [constantKey, code] of permissionMap) {
    const objectName = constantKey.split('.')[0] ?? '';
    const label = permissionDomainLabel(objectName);
    const codes = codesByDomain.get(label) ?? new Set<string>();
    codes.add(code);
    codesByDomain.set(label, codes);
  }

  const orderedLabels = [...codesByDomain.keys()].sort((left, right) => {
    const leftIndex = PERMISSION_DOMAIN_ORDER.indexOf(left);
    const rightIndex = PERMISSION_DOMAIN_ORDER.indexOf(right);
    return (
      (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex) ||
      left.localeCompare(right)
    );
  });

  const lines: string[] = [SEPARATOR, '  PERMISSION CODES REFERENCE', SEPARATOR, ''];
  for (const label of orderedLabels) {
    lines.push(`  ${label}:`);
    const codes = [...(codesByDomain.get(label) ?? new Set<string>())].sort();
    for (let index = 0; index < codes.length; index += 3) {
      const row = codes
        .slice(index, index + 3)
        .map((code) => code.padEnd(30, ' '))
        .join('')
        .trimEnd();
      lines.push(`    ${row}`);
    }
    lines.push('');
  }
  lines.push('  Global Roles:');
  lines.push('    super_admin                   admin                          user');
  lines.push('');
  return lines;
}

function buildIdempotencySection(routes: ParsedRoute[]): string[] {
  const required = routes
    .filter((route) => route.idempotencyRequired)
    .map((route) => `    ${route.method} ${route.fullPath}`);
  return [
    SEPARATOR,
    `  IDEMPOTENCY-REQUIRED WRITES (${required.length}) — X-Idempotency-Key required`,
    SEPARATOR,
    '',
    '  Routes flagged I = req reject a missing or reused key (422); every other write',
    '  accepts an optional key (24h Redis cache).',
    '',
    ...required,
    '',
    '  See docs/reference/reliability/idempotency.md and OpenAPI operation descriptions.',
    '',
  ];
}

export function buildCatalogContent(routes: ParsedRoute[]): string {
  const permissionMap = loadPermissionConstantMap();

  const sortedRoutes = [...routes].sort((left, right) => {
    if (left.domainKey !== right.domainKey) return left.domainKey.localeCompare(right.domainKey);
    if ((left.subDomainLabel ?? '') !== (right.subDomainLabel ?? '')) {
      return (left.subDomainLabel ?? '').localeCompare(right.subDomainLabel ?? '');
    }
    if (left.fullPath !== right.fullPath) return left.fullPath.localeCompare(right.fullPath);
    return (
      METHOD_ORDER.indexOf(left.method as (typeof METHOD_ORDER)[number]) -
      METHOD_ORDER.indexOf(right.method as (typeof METHOD_ORDER)[number])
    );
  });

  const lines: string[] = [
    SEPARATOR,
    `  ROUTE CATALOG — ${loadConfig().project.displayName}`,
    `  Total routes: ${sortedRoutes.length}`,
    SEPARATOR,
    '',
    'Legend:',
    '  PUBLIC  = No authentication required',
    '  AUTH    = JWT authentication required',
    '  ROLE    = Global role required (super_admin, admin, user)',
    '  PERM    = Organization-scoped permission required',
    '  TOKEN   = Credential enforced in-handler (non-JWT bearer token or session cookie)',
    '  Columns after the path: S = success status · I = idempotency (req | -) · O = organization scope (both | team-only, 422 on personal)',
    '',
  ];

  const flushDomainHeader = (domain: string, count: number) => {
    const label = DOMAIN_LABELS[domain] ?? domain;
    lines.push(SEPARATOR);
    lines.push(`  DOMAIN: ${label} (${domain})`);
    lines.push(`  Routes: ${count}`);
    lines.push(SEPARATOR);
    lines.push('');
  };

  const routesByDomain = new Map<string, ParsedRoute[]>();
  for (const route of sortedRoutes) {
    const list = routesByDomain.get(route.domainKey) ?? [];
    list.push(route);
    routesByDomain.set(route.domainKey, list);
  }

  for (const [domainKey, domainRoutes] of [...routesByDomain.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    flushDomainHeader(domainKey, domainRoutes.length);

    let lastSubDomain = '';
    for (const route of domainRoutes) {
      if (route.subDomainLabel && route.subDomainLabel !== lastSubDomain) {
        lines.push(`  — ${route.subDomainLabel} —`);
        lastSubDomain = route.subDomainLabel;
      }
      lines.push(formatRouteLine(route));
    }
    lines.push('');
  }

  const publicCount = sortedRoutes.filter((route) => route.access === 'PUBLIC').length;
  const authCount = sortedRoutes.filter((route) => route.access === 'AUTH').length;
  const roleCount = sortedRoutes.filter((route) => route.access.startsWith('ROLE:')).length;
  const permCount = sortedRoutes.filter((route) => route.access.startsWith('PERM:')).length;
  const tokenCount = sortedRoutes.filter((route) => route.access.startsWith('TOKEN:')).length;
  const teamScopedCount = sortedRoutes.filter((route) => route.organizationScope === 'team').length;

  lines.push(
    SEPARATOR,
    '  SUMMARY',
    SEPARATOR,
    '',
    `  Total routes    : ${sortedRoutes.length}`,
    `  Public          : ${publicCount}`,
    `  Authenticated   : ${authCount}`,
    `  Role-guarded    : ${roleCount}`,
    `  Perm-guarded    : ${permCount}`,
    `  Token-guarded   : ${tokenCount}`,
    `  Team-only (O)   : ${teamScopedCount}`,
    '',
  );

  lines.push(...buildIdempotencySection(sortedRoutes));
  lines.push(...buildPermissionCodesSection(permissionMap));

  return lines.join('\n');
}
