import type { GlobalRole } from '@/shared/constants/roles.constants.js';
import type { OrganizationOutput } from '@/domains/tenancy/sub-domains/organization/organization.types.js';

/** Subset of an `auth_methods` row that is safe to return to the owning user. */
interface AuthMethodResponseInput {
  public_id: string;
  method_type: string;
  provider: string | null;
  is_primary: boolean;
  verified_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

/**
 * Allowlist an auth-method row for the API response. NEVER emits credential material
 * (`encrypted_secret` — the AES-GCM TOTP seed), PII (`phone_number`, `provider_user_id`) or
 * internal sequential ids (`id`, `user_id`, `created_by_user_id`). The emitted `id` is the stable
 * opaque identifier accepted by `DELETE /me/auth-methods/{auth_method_id}` (sec-new-B4).
 */
function serializeAuthMethod(item: AuthMethodResponseInput) {
  return {
    id: item.public_id,
    method_type: item.method_type,
    provider: item.provider,
    is_primary: item.is_primary,
    verified_at: item.verified_at,
    last_used_at: item.last_used_at,
    created_at: item.created_at,
  };
}

/** Function-based serializers that shape HTTP response bodies for the auth domain (access token, MFA challenge, magic-link confirmation, etc.). */
export const AuthSerializer = {
  accessToken(data: { access_token: string; session_public_id?: string }) {
    return {
      access_token: data.access_token,
      ...(data.session_public_id !== undefined ? { session_id: data.session_public_id } : {}),
    };
  },
  /**
   * Access token plus the active-organization delta returned by the organization-switch endpoints
   * (`switch-to-organization` / `switch-to-personal`): the newly active organization
   * (with capabilities) and the caller's resolved permissions in it, so the client
   * repaints the dashboard without a follow-up `GET /auth/me/context`.
   */
  accessTokenWithActiveOrganization(
    token: { access_token: string },
    context: {
      active_organization: OrganizationOutput;
      my_permissions: string[];
      global_role: GlobalRole | null;
    },
  ) {
    return {
      access_token: token.access_token,
      active_organization: context.active_organization,
      my_permissions: context.my_permissions,
      global_role: context.global_role,
    };
  },
  mfaRequired(data: { mfa_required: true; mfa_session_token: string }) {
    return data;
  },
  verificationCodeSent(data: {
    message: string;
    expires_in_minutes: number;
    debug_verification_code?: string;
  }) {
    return {
      message: data.message,
      expires_in_minutes: data.expires_in_minutes,
      // TEST_MODE-only: present only when the service echoed a code (env.TEST_MODE on, never in prod).
      ...(data.debug_verification_code
        ? { debug_verification_code: data.debug_verification_code }
        : {}),
    };
  },
  mfaVerified(data: { verified: boolean }) {
    return data;
  },
  authMethodList(items: AuthMethodResponseInput[]) {
    return items.map(serializeAuthMethod);
  },
  authMethod(item: AuthMethodResponseInput) {
    return serializeAuthMethod(item);
  },
  message(data: { message: string }) {
    return data;
  },
  mfaEnroll(data: { secret: string; provisioning_uri: string }) {
    return {
      secret: data.secret,
      provisioning_uri: data.provisioning_uri,
    };
  },
  mfaEnrollConfirm(data: { recovery_codes: string[]; method_public_id: string }) {
    return {
      recovery_codes: data.recovery_codes,
      mfa_method_id: data.method_public_id,
    };
  },
  oauthProviders(data: { providers: string[] }) {
    return data;
  },
};
