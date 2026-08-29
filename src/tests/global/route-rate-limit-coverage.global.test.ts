/**
 * Policy: every route registration in every domain must make a DELIBERATE
 * rate-limit decision.
 *
 * The per-domain `*routes-rate-limit.policy.unit.test.ts` suites pin the exact
 * preset chosen for specific high-risk routes; this global net closes the gap
 * they leave for FUTURE routes: a brand-new endpoint added without any
 * `..._RATE_LIMIT` preset spread previously sailed through CI on the global
 * limiter alone (that is exactly how `GET /permissions` shipped preset-less).
 *
 * A route may legitimately rely on the global limiter only, but that choice
 * must be visible in the reviewed allowlist below rather than silent.
 *
 * Enforced textually against the route files (like the per-domain suites)
 * because Fastify's per-route `config` is buried behind plugin encapsulation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const DOMAINS_ROOT = join(PROJECT_ROOT, 'src/domains');

/**
 * Reviewed registrations that intentionally ride the GLOBAL rate limiter only.
 * Adding an entry here must be a deliberate, reviewed decision — say why.
 */
const GLOBAL_LIMITER_ONLY_ALLOWLIST = new Set<string>([
  // ── Authenticated cheap reads (repo convention: only mutating/expensive
  //    routes carry presets; plain authed GET reads ride the global limiter).
  'src/domains/billing/sub-domains/subscription/subscription.routes.ts → GET /subscriptions',
  'src/domains/billing/sub-domains/subscription/subscription.routes.ts → GET /invoices',
  'src/domains/billing/sub-domains/subscription/subscription.routes.ts → GET /payment-methods',
  'src/domains/notify/sub-domains/notification/notification.routes.ts → GET /notifications',
  'src/domains/notify/sub-domains/notification/notification.routes.ts → GET /notifications/unread-count',
  'src/domains/notify/sub-domains/webhook/webhook.routes.ts → GET /webhook-events',
  'src/domains/notify/sub-domains/webhook/webhook.routes.ts → GET /webhooks',
  'src/domains/tenancy/sub-domains/member-roles/member-role.routes.ts → GET /organization/roles',
  'src/domains/tenancy/sub-domains/membership/membership.routes.ts → GET /organization/memberships',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts → GET /organizations',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts → GET /organization',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts → GET /organizations/by-slug/:slug',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts → GET /organization/audit-logs',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts → GET /organization/settings',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts → GET /organization/api-keys',
  'src/domains/tenancy/sub-domains/organization/organization.routes.ts → GET /organization/notification-policies',
  'src/domains/tenancy/sub-domains/permission/permission.routes.ts → GET /permissions',
  'src/domains/user/user.routes.ts → GET /',
  'src/domains/user/user.routes.ts → GET /:user_id',
  'src/domains/user/user.routes.ts → GET /me',
  'src/domains/user/user.routes.ts → GET /me/settings',
  'src/domains/user/user.routes.ts → GET /me/notification-preferences',
  // (The organization-switch POSTs previously lived here as a flagged follow-up; they now carry
  //  MODERATE_AUTHED_RATE_LIMIT, so they are enforced by the preset check below, not allowlisted.)
]);

/** Marker every deliberate per-route rate-limit choice carries (preset spread). */
const RATE_LIMIT_PRESET_MARKER = /_RATE_LIMIT/;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface RouteRegistration {
  file: string;
  method: string;
  url: string;
  /** Brace-balanced route-options object source, or null when the 2-arg form omitted options. */
  options: string | null;
}

function collectRouteFiles(directory: string, accumulator: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__' || entry === 'seed') continue;
      collectRouteFiles(fullPath, accumulator);
      continue;
    }
    if (entry.endsWith('.routes.ts')) accumulator.push(relative(PROJECT_ROOT, fullPath));
  }
  return accumulator;
}

/** Returns the brace-balanced object literal starting at `openingBraceIndex`. */
function extractBalancedObject(source: string, openingBraceIndex: number): string {
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBraceIndex, index + 1);
    }
  }
  throw new Error('unbalanced route options object');
}

function parseRegistrations(file: string, source: string): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  const header = new RegExp(
    String.raw`zodApplication\.(${HTTP_METHODS.join('|')})\(\s*'([^']+)'\s*,\s*(\{)?`,
    'g',
  );
  for (const match of source.matchAll(header)) {
    const [, method, url, openingBrace] = match;
    if (method === undefined || url === undefined) continue;
    const options =
      openingBrace === undefined
        ? null
        : extractBalancedObject(source, match.index + match[0].length - 1);
    registrations.push({ file, method: method.toUpperCase(), url, options });
  }
  return registrations;
}

describe('Global: route rate-limit coverage', () => {
  const routeFiles = collectRouteFiles(DOMAINS_ROOT);
  const registrations = routeFiles.flatMap((file) =>
    parseRegistrations(file, readFileSync(join(PROJECT_ROOT, file), 'utf8')),
  );

  it('finds the route registrations it is meant to guard', () => {
    // Route-file count and a floor on registrations: if the registration idiom
    // ever changes (e.g. away from `zodApplication.<method>('url', {…}`), this
    // canary fails BEFORE the coverage assertions silently scan nothing.
    expect(routeFiles.length).toBeGreaterThanOrEqual(16);
    expect(registrations.length).toBeGreaterThanOrEqual(60);
  });

  it('every route registration carries a rate-limit preset or a reviewed allowlist entry', () => {
    const violations: string[] = [];
    for (const registration of registrations) {
      const key = `${registration.file} → ${registration.method} ${registration.url}`;
      const hasPreset =
        registration.options !== null && RATE_LIMIT_PRESET_MARKER.test(registration.options);
      if (hasPreset) continue;
      if (GLOBAL_LIMITER_ONLY_ALLOWLIST.has(key)) continue;
      violations.push(key);
    }
    expect(
      violations,
      'Route registered without a rate-limit preset. Spread a preset from ' +
        'src/shared/middlewares/rate-limit/rate-limit-presets.constants.ts into the route options, ' +
        'or (deliberate global-limiter-only routes) add the registration to ' +
        'GLOBAL_LIMITER_ONLY_ALLOWLIST with a reviewed justification.',
    ).toEqual([]);
  });

  it('every allowlist entry still matches a real preset-less registration (no stale entries)', () => {
    const presetlessKeys = new Set(
      registrations
        .filter(
          (registration) =>
            registration.options === null || !RATE_LIMIT_PRESET_MARKER.test(registration.options),
        )
        .map((registration) => `${registration.file} → ${registration.method} ${registration.url}`),
    );
    const stale = [...GLOBAL_LIMITER_ONLY_ALLOWLIST].filter((entry) => !presetlessKeys.has(entry));
    expect(
      stale,
      'Allowlist entry no longer matches a preset-less registration — remove it.',
    ).toEqual([]);
  });
});
