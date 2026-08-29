/** Internal Drizzle row for `tenancy.api_keys` (includes the secret `key_hash` and audit columns). */
export interface OrganizationApiKeyRow {
  id: number;
  public_id: string;
  organization_id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: Date | null;
  expires_at: Date | null;
  status: string;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
}

/** Public API-key shape returned by the API — never exposes the hash, scopes, or audit fields. */
export interface OrganizationApiKeyOutput {
  id: string;
  organization_id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Result of `OrganizationApiKeyService.create` / `rotate` — pairs the public output with the one-time raw secret. */
export interface CreateOrganizationApiKeyResult {
  api_key: OrganizationApiKeyOutput;
  raw_key: string;
}

/** Successful authentication match returned by `OrganizationApiKeyService.authenticate` (carries the organization and granted scopes). */
export interface OrganizationApiKeyAuthMatch {
  public_id: string;
  organization_public_id: string;
  scopes: string[];
}

/**
 * Candidate row returned by the `tenancy.resolve_api_key_for_authentication` SECURITY DEFINER
 * resolver — enough to verify the secret and establish tenancy without reading `tenancy.api_keys`
 * or `tenancy.organizations` directly (both are FORCE RLS and the auth phase has no organization context).
 */
export interface OrganizationApiKeyAuthenticationCandidate {
  public_id: string;
  organization_id: number;
  organization_public_id: string;
  key_hash: string;
  scopes: string[];
  status: string;
  expires_at: Date | null;
}
