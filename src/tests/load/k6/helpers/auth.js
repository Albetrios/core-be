import http from 'k6/http';
import { API_PREFIX } from './config.js';

/**
 * Perform login and return the access token.
 *
 * The token is a signed JWT whose `org` claim is the user's default active organization.
 * Organization-scoped routes resolve the tenant from this claim — there is no `{organization_id}`
 * path segment and no organization id header for the flat routes. To act in a different
 * organization, re-mint the token with `switchToOrganization` / `switchToPersonal`.
 */
export function login(email, password) {
  const response = http.post(`${API_PREFIX}/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });

  if (response.status === 200) {
    const body = JSON.parse(response.body);
    return body.data?.access_token || body.data?.token || null;
  }
  return null;
}

/**
 * Re-mint the access token scoped to a specific team organization the user belongs to
 * (`POST /auth/switch-to-organization`). Use the returned token for subsequent organization-scoped calls —
 * the active organization rides its `org` claim. Returns the new token, or null on failure.
 */
export function switchToOrganization(token, organizationPublicId) {
  const response = http.post(
    `${API_PREFIX}/auth/switch-to-organization`,
    JSON.stringify({ organization_id: organizationPublicId }),
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );
  if (response.status === 200 || response.status === 200) {
    const body = JSON.parse(response.body);
    return body.data?.access_token || null;
  }
  return null;
}

/**
 * Re-mint the access token scoped to the caller's personal organization
 * (`POST /auth/switch-to-personal`). Returns the new token, or null on failure.
 */
export function switchToPersonal(token) {
  const response = http.post(`${API_PREFIX}/auth/switch-to-personal`, null, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (response.status === 200 || response.status === 200) {
    const body = JSON.parse(response.body);
    return body.data?.access_token || null;
  }
  return null;
}

/**
 * Convenience: log in, then switch the active organization so the returned token is scoped to
 * `organizationPublicId`. Falls back to the plain login token when no organization is given or the switch
 * fails. Returns the (organization-scoped) token, or null when login itself fails.
 */
export function loginScopedToOrganization(email, password, organizationPublicId) {
  const token = login(email, password);
  if (!(token && organizationPublicId)) return token;
  return switchToOrganization(token, organizationPublicId) || token;
}

/**
 * Build authorization headers for authenticated requests.
 *
 * The active organization comes from the token's `org` claim — do NOT add an organization id
 * header for organization-scoped routes (it is ignored by the flat routes; only the upload domain reads it).
 */
export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}
