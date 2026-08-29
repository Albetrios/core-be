import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteEntry } from '@/tests/helpers/route-catalog-registry.js';

/**
 * Authorization model governing who may legitimately access a route's object.
 *
 * @remarks
 * - `user` — user-owned resource; a different user must get 404 (BOLA).
 * - `email` — invitation addressed to an email; a different caller must get 403.
 * - `organization` — organization-owned; a member of another organization must get 403/404 (cross-tenant BOLA).
 * - `tier:owner` — owner-tier protected; a non-owner / lower tier acting on the owner must get 403.
 * - `grant` — grant-grantability; granting a permission the caller lacks must get 403.
 * - `global-role` — global admin surface; a regular user must get 401/403 (BFLA).
 */
export type AuthorizationModel =
  | 'user'
  | 'email'
  | 'organization'
  | 'tier:owner'
  | 'grant'
  | 'global-role';

/** Per-route authorization declaration recorded in `route-authorization-model.json`. */
export type RouteAuthorizationEntry = {
  model: AuthorizationModel;
  /** When true, the matrix must read state back and assert the attack changed nothing. */
  verifyNoMutation?: boolean;
};

/** Map of `"<METHOD> <path>"` → its declared authorization entry. */
export type RouteAuthorizationModel = Record<string, RouteAuthorizationEntry>;

/** Every authorization model value the coverage gate and matrix understand. */
export const AUTHORIZATION_MODELS = [
  'user',
  'email',
  'organization',
  'tier:owner',
  'grant',
  'global-role',
] as const satisfies readonly AuthorizationModel[];

/** Expected attacker-facing status code(s) per authorization model (consumed by the Phase 2 matrix). */
export const MODEL_EXPECTED_ATTACKER_STATUS: Record<AuthorizationModel, readonly number[]> = {
  user: [404],
  email: [403],
  organization: [403, 404],
  'tier:owner': [403],
  grant: [403],
  'global-role': [401, 403],
};

const ROUTE_AUTHORIZATION_MODEL_PATH = join(
  process.cwd(),
  'tooling',
  'openapi',
  'route-catalog',
  'route-authorization-model.json',
);

/** Builds the canonical `"<METHOD> <path>"` key used by the model file. */
export function routeModelKey(route: Pick<RouteEntry, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

/**
 * Returns true when a catalog route must declare an authorization model.
 *
 * @remarks
 * The Phase 1 surface is every object-addressing route (carries a `:param`) that
 * is gated by authentication, an organization permission, or a global role — i.e.
 * the BOLA/BFLA object surface. Public and bearer-token routes are excluded
 * because they have no per-object ownership to assert.
 */
export function requiresAuthorizationModel(route: RouteEntry): boolean {
  const isProtected =
    route.access === 'authenticated' ||
    route.access === 'organization-permission' ||
    route.access === 'global-role';
  return isProtected && route.path.includes(':');
}

/** Loads and parses `tooling/openapi/route-catalog/route-authorization-model.json`. */
export function loadRouteAuthorizationModel(
  modelPath: string = ROUTE_AUTHORIZATION_MODEL_PATH,
): RouteAuthorizationModel {
  return JSON.parse(readFileSync(modelPath, 'utf-8')) as RouteAuthorizationModel;
}
