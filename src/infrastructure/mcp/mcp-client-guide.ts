import {
  MCP_OPENAPI_RESOURCE_URI,
  MCP_ROUTES_RESOURCE_URI,
  PROJECT_DISPLAY_NAME,
} from '@/shared/constants/project-identity.constants.js';

/**
 * Canonical client integration guide served as the `{slug}://client-guide` MCP
 * resource. It tells any frontend or API client how to authenticate, how the
 * active organization is carried (the signed `org` JWT claim — never a URL path
 * segment or the legacy `X-Organization-Id` header), how to switch the active
 * organization, and how to call the flat organization-scoped routes.
 *
 * @remarks
 * Keep this in sync with the auth routes (`auth.routes.ts`), the active-organization token
 * model (`docs/reference/architecture/personal-vs-team-organizations.md`), and the
 * API-contract rule. It is intentionally a hand-written narrative — the machine-
 * readable surface lives in the OpenAPI and route-catalog MCP resources, which
 * clients should read alongside this guide. Resource URIs are built from the
 * generated project identity, so a rebrand reaches them automatically.
 */
export const MCP_CLIENT_GUIDE = `# ${PROJECT_DISPLAY_NAME} — client integration guide

How a frontend or API client should authenticate and call this API. Read this
alongside \`${MCP_OPENAPI_RESOURCE_URI}\` (full spec) and \`${MCP_ROUTES_RESOURCE_URI}\` (route list).

## 1. Authentication

- **Password login:** \`POST /api/v1/auth/login\` with \`{ email, password }\` →
  \`{ data: { access_token, ... } }\`. Public auth forms must send an
  \`X-Captcha-Token\` header.
- **Alternatives:** email verification-code login (\`POST /api/v1/auth/email/send-code\`
  then \`/auth/email/login\`), OAuth (\`/api/v1/auth/oauth/...\`), and MFA / WebAuthn
  step-up for sensitive actions.
- The \`access_token\` is a short-lived RS256 JWT. Send it as
  \`Authorization: Bearer <access_token>\` on every authenticated request. It
  carries the **active organization** as the \`org\` claim and a session-version
  \`sv\` claim — the client never parses it; treat it as opaque.
- **Refresh:** \`POST /api/v1/auth/refresh\` (cookie session + \`X-CSRF-Token\`
  header) returns a fresh access token. **Logout:** \`POST /api/v1/auth/logout\`.

## 2. The active organization (no path param, no header)

- Every user has exactly one **personal** organization (auto-provisioned on
  signup) plus zero or more **team** organizations they are a member of.
- The active organization is the signed \`org\` JWT claim. It is **NOT** a URL
  path segment and **NOT** the \`X-Organization-Id\` header. Organization-scoped
  routes resolve the tenant from the token — the client sends nothing extra
  per request. Membership and Row-Level Security are re-checked on every call.
- **Switch the active organization** (this re-mints the access token — use the
  returned token for subsequent calls):
  - \`POST /api/v1/auth/switch-to-personal\` (no body) → personal organization.
  - \`POST /api/v1/auth/switch-to-organization\` with \`{ organization_id }\` →
    a team organization the user belongs to.
- On login the token defaults to the user's last-active organization (or their
  personal organization).

## 3. Identity & organizations

- \`GET /api/v1/users/me\` → profile plus \`personal_organization_id\` (the
  account-level "Personal" workspace). Use it to render the organization switcher.
- \`GET /api/v1/tenancy/organizations\` → the team organizations the user belongs
  to (for the switcher). The personal organization is account-level (always
  present); list + personal together to populate the switcher.

## 4. Calling organization-scoped APIs (flat routes)

The active organization is implicit (from the token), so routes are flat:

- **Active-organization resource (singular):**
  \`GET|PATCH|DELETE /api/v1/tenancy/organization\` plus its sub-resources
  \`/settings\`, \`/logo\`, \`/audit-logs\`, \`/api-keys\`,
  \`/notification-policies\`, \`/memberships\`, \`/roles\`, \`/invitations\`,
  \`/leave\`, \`/transfer-ownership\`.
- **Other domains (top-level under the claim):**
  \`/api/v1/billing/subscriptions\`, \`/api/v1/notify/webhooks\`.
- **Account-level (NOT organization-scoped, stay plural):**
  \`GET|POST /api/v1/tenancy/organizations\` (list / create a team organization),
  \`GET /api/v1/tenancy/organizations/by-slug/{slug}\`, and the cross-organization
  invitation actions \`POST /api/v1/tenancy/invitations/{invitation_id}/accept|decline\`.
- A **personal** organization supports every feature EXCEPT people-sharing
  (memberships, roles, invitations, transfer-ownership) — those return a 4xx on a
  personal organization. Switch to (or create) a team organization to collaborate.

## 5. Required headers

- \`Authorization: Bearer <access_token>\` — all authenticated routes.
- \`X-Idempotency-Key: <unique, min 16 chars>\` — REQUIRED on the idempotent writes
  (team-organization create, membership create, transfer-ownership, invitation create,
  subscription create / change-plan / cancel / resume).
- \`X-CSRF-Token\` — required on \`POST /api/v1/auth/refresh\`.
- \`X-Captcha-Token\` — required on public auth forms (login, register, magic link).
- \`X-Organization-Id\` — LEGACY. Only the upload domain still reads it; it is NOT
  the organization selector for the flat routes. Do not use it to scope tenancy/billing/
  notify calls — switch the token instead.

## 6. Status codes

- \`401\` unauthenticated · \`403\` forbidden (missing permission OR no active-organization
  context) · \`404\` not found, including another tenant's resource (invisible
  under RLS) · \`409\`/\`422\` conflict / validation · \`429\` rate limited.

## 7. Recommended client flow

1. Login → store the access token (and refresh via cookie + CSRF).
2. \`GET /users/me\` + \`GET /tenancy/organizations\` → render the organization switcher.
3. To act in a different organization, call a switch endpoint, replace the stored token
   with the returned one, then call the flat organization-scoped routes.
4. Discover exact request/response shapes from \`${MCP_OPENAPI_RESOURCE_URI}\`.
`;
