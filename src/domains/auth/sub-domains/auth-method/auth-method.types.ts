/** Input shape accepted by {@link AuthMethodRepository.create} when inserting a new row into `auth.auth_methods`. */
export interface AuthMethodCreateData {
  user_id: number;
  method_type: string;
  provider?: string;
  provider_user_id?: string;
  encrypted_secret?: string;
  is_primary?: boolean;
  created_by_user_id?: number;
}

/**
 * Row returned by the `auth.resolve_auth_method_by_provider` SECURITY DEFINER resolver — the linked
 * credential plus the owning user's `public_id`, so the pre-session OAuth callback can enter
 * `withAppDatabaseContext (user scope)` for any follow-up owner-scoped work under FORCE RLS.
 */
export interface AuthMethodProviderLookup {
  id: number;
  user_id: number;
  user_public_id: string;
  method_type: string;
  provider: string | null;
  provider_user_id: string | null;
  is_primary: boolean;
  verified_at: Date | null;
  last_used_at: Date | null;
  created_at: Date | null;
  revoked_at: Date | null;
}
