export type RouteAccess =
  | 'PUBLIC'
  | 'AUTH'
  | `ROLE: ${string}`
  | `PERM: ${string}`
  | `TOKEN: ${string}`;

export type RegistryAccess =
  | 'public'
  | 'authenticated'
  | 'global-role'
  | 'organization-permission'
  | 'bearer-token';

/** Whether a route works for any organization (`both`) or rejects a personal organization with 422 (`team`). */
export type OrgScope = 'both' | 'team';

export type ParsedRoute = {
  method: string;
  fullPath: string;
  access: RouteAccess;
  domainKey: string;
  domain: string;
  subDomain?: string;
  subDomainLabel?: string;
  /** Declared happy-path success status (from route-success-statuses.json). */
  successStatus?: number;
  /** True when the route is registered with `config.idempotencyRequired = true`. */
  idempotencyRequired?: boolean;
  /** Organization scope (from route-organization-scope.json): `both` or team-only. */
  organizationScope?: OrgScope;
};
