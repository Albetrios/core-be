# Authorization coverage & gap map (all routes)

> Point-in-time analysis derived from `docs/routes.txt` + `tooling/openapi/route-catalog/route-authorization-model.json`. Generated 2026-06-15.

Answers "is every route — organization-level included — covered, and what is **not** in the codebase/tests yet?" Companion to [`authorization-testing-plan.md`](./authorization-testing-plan.md).

**Total routes: 131.** Every route is classified into one authorization bucket below; the "Gap" column states what is missing.

---

## Coverage at a glance

| Bucket | Count | Guard (in code) | Tested by | Gap |
| --- | --- | --- | --- | --- |
| `auth-by-id` | 12 | Ownership filter / user RLS / email-match | object-ownership + invitation-email (Phase 2 matrix) | ✅ cross-user/email BOLA e2e for every by-id route |
| `org-by-id` | 28 | Org permission + organization RLS | permission-route-matrix (BFLA) + cross-organization-resource/cross-organization-mutation (Phase 2) | ✅ cross-organization BOLA e2e for every by-id route (read + write) |
| `org-collection` | 20 | Org permission middleware | permission-route-matrix (every PERM route) | ✅ BFLA; grant-grantability on creates only partially asserted |
| `global-role` | 9 | JWT global role claim | admin-only (every `/users/:user_id` route) + privilege-escalation | ✅ all 5 user-by-id admin routes asserted; collection `/users`, audit, mcp still sampled |
| `auth-self-mutation` | 24 | Auth; acts on caller (/me) | auth-enforcement (401), mass-assignment (subset) | ⚠ caller-scoped; no per-route assertion |
| `auth-self-list` | 11 | Auth; results scoped to caller | auth-enforcement (401) | ✅ low risk (caller-scoped list) |
| `public` | 20 | None (some need X-Captcha-Token / Stripe-Signature) | public-routes, captcha, oauth-callback, stripe-webhook | ⚠ business-flow abuse (API6) not systematically tested |
| `bearer-token` | 3 | Service/metrics token | api-key-auth, ops route tests | ✅ low |

---

## What is NOT in the codebase / tests yet

> **Reconciliation with integration tests:** the per-domain `*.integration` suites already cover more than the dedicated `security/` suite. For example `membership.integration` asserts cross-organization `404` (invitation revoke/resend, membership-permission lookup), owner-tier `403` (`transfer-ownership`, owner-cannot-leave), and email-match `403` (decline someone else's invitation). The gaps below are what remains **after** counting those.

1. ~~**Cross-user (intra-tenant) BOLA — `auth-by-id`.**~~ **RESOLVED (Phase 2).** `object-ownership.security.test.ts` denies User B every User A object (uploads, notifications, data-export, sessions/MFA/auth-methods under step-up) with `verifyNoMutation`; `invitation-email.security.test.ts` covers the email-bound accept.
2. ~~**Cross-organization BOLA e2e — `org-by-id` resources.**~~ **RESOLVED (Phase 2).** `cross-organization-resource.security.test.ts` (reads → 404 + same-organization 200) and `cross-organization-mutation.security.test.ts` (writes → 404, incl. subscription/api-key/notification-policy/webhook/role/membership/invitation) cover every organization-by-id route.
3. **Grant-grantability on create paths.** The role-permission **PUT** is now e2e-asserted (`tier-and-grant.security.test.ts`: a manager cannot grant a permission they do not hold, and cannot reach across organizations). Residual: create paths (`POST roles`, `POST invitations`, api-key scopes) are not all asserted at the route level.
4. **Global-role denial — `global-role`.** **RESOLVED for the by-id surface (Phase 2):** `admin-only.security.test.ts` asserts a regular user is denied on all five `/users/:user_id` admin routes (GET/PATCH/DELETE/suspend/unsuspend). Residual: the collection `GET /users`, `audit/logs`, and `mcp` admin routes are still only sampled.
5. **Caller-scope on `auth-self-mutation` (24 routes).** Guarded by auth + `/me` scoping, but there is no per-route assertion that the body cannot redirect the action to another user (mass-assignment covers a subset only).
6. **Business-flow abuse (OWASP API6) on `public`/auth flows.** Rate-limit + captcha exist; multi-step flow abuse (e.g. invitation/checkout sequencing) is not systematically tested.
7. **Spec validity.** The generated OpenAPI sets `example`+`examples` together and uses PCRE-lookahead `pattern`s — invalid for strict (RE2) parsers. Worth fixing in the spec generator so the spec is portable to strict tooling, not just Swagger UI.

---

## Full route inventory

> The Status column reflects **dedicated** authorization coverage; per-domain `*.integration` tests add further cross-organization/tier/email assertions (see Reconciliation above).

### AUDIT (1)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/audit/logs` | ROLE: super_admin, admin | `global-role` | ⚠ partial (admin-deny) |

### AUTH (30)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/logout` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/email/send-code` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/email/login` | PUBLIC | `public` | — (n/a authz) |
| GET | `/api/v1/auth/me/auth-methods` | AUTH | `auth-self-list` | ✅ caller-scoped |
| POST | `/api/v1/auth/me/auth-methods` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| DELETE | `/api/v1/auth/me/auth-methods/:auth_method_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| GET | `/api/v1/auth/me/sessions` | AUTH | `auth-self-list` | ✅ caller-scoped |
| DELETE | `/api/v1/auth/me/sessions` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| DELETE | `/api/v1/auth/me/sessions/:session_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| GET | `/api/v1/auth/mfa` | AUTH | `auth-self-list` | ✅ caller-scoped |
| DELETE | `/api/v1/auth/mfa/:mfa_method_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| POST | `/api/v1/auth/mfa/enroll` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/auth/mfa/enroll/confirm` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/auth/mfa/login` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/mfa/verify` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| GET | `/api/v1/auth/oauth/:provider` | PUBLIC | `public` | — (n/a authz) |
| GET | `/api/v1/auth/oauth/:provider/callback` | PUBLIC | `public` | — (n/a authz) |
| GET | `/api/v1/auth/oauth/providers` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/password/change` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/auth/password/forgot` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/password/reset` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/refresh` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/step-up` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/auth/switch-to-organization` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/auth/switch-to-personal` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/auth/webauthn/authenticate/options` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/webauthn/authenticate/verify` | PUBLIC | `public` | — (n/a authz) |
| POST | `/api/v1/auth/webauthn/register/options` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/auth/webauthn/register/verify` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |

### BILLING (11)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/billing/plans` | PUBLIC | `public` | — (n/a authz) |
| GET | `/api/v1/billing/plans/:plan_id` | PUBLIC | `public` | — (n/a authz) |
| GET | `/api/v1/billing/subscriptions` | PERM: subscription:read | `org-collection` | ✅ BFLA (matrix) |
| POST | `/api/v1/billing/subscriptions` | PERM: subscription:manage | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/billing/subscriptions/:subscription_id` | PERM: subscription:read | `org-by-id` | ✅ BFLA + cross-organization |
| PATCH | `/api/v1/billing/subscriptions/:subscription_id` | PERM: subscription:manage | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/billing/subscriptions/:subscription_id/cancel` | PERM: subscription:manage | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/billing/subscriptions/:subscription_id/change-plan` | PERM: subscription:manage | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/billing/subscriptions/:subscription_id/resume` | PERM: subscription:manage | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/billing/webhook` | PUBLIC | `public` | — (n/a authz) |

### MCP (2)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/mcp` | ROLE: super_admin, admin | `global-role` | ⚠ partial (admin-deny) |
| POST | `/api/v1/mcp` | ROLE: super_admin, admin | `global-role` | ⚠ partial (admin-deny) |

### NOTIFY (14)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/notify/notifications` | AUTH | `auth-self-list` | ✅ caller-scoped |
| GET | `/api/v1/notify/notifications/:notification_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| DELETE | `/api/v1/notify/notifications/:notification_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| PATCH | `/api/v1/notify/notifications/:notification_id/read` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| POST | `/api/v1/notify/notifications/mark-all-read` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| GET | `/api/v1/notify/notifications/unread-count` | AUTH | `auth-self-list` | ✅ caller-scoped |
| GET | `/api/v1/notify/webhook-events` | PERM: webhook:read | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/notify/webhooks` | PERM: webhook:read | `org-collection` | ✅ BFLA (matrix) |
| POST | `/api/v1/notify/webhooks` | PERM: webhook:manage | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/notify/webhooks/:webhook_id` | PERM: webhook:read | `org-by-id` | ✅ BFLA + cross-organization |
| PATCH | `/api/v1/notify/webhooks/:webhook_id` | PERM: webhook:manage | `org-by-id` | ✅ BFLA + cross-organization |
| DELETE | `/api/v1/notify/webhooks/:webhook_id` | PERM: webhook:manage | `org-by-id` | ✅ BFLA + cross-organization |
| GET | `/api/v1/notify/webhooks/:webhook_id/delivery-attempts` | PERM: webhook:read | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/notify/webhooks/:webhook_id/test` | PERM: webhook:manage | `org-by-id` | ✅ BFLA + cross-organization |

### TENANCY (41)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/tenancy/invitations/:invitation_id/accept` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| GET | `/api/v1/tenancy/organization` | AUTH | `auth-self-list` | ✅ caller-scoped |
| PATCH | `/api/v1/tenancy/organization` | PERM: organization:update | `org-collection` | ✅ BFLA (matrix) |
| DELETE | `/api/v1/tenancy/organization` | PERM: organization:delete | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/tenancy/organization/api-keys` | PERM: api-key:read | `org-collection` | ✅ BFLA (matrix) |
| POST | `/api/v1/tenancy/organization/api-keys` | PERM: api-key:manage | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/tenancy/organization/api-keys/:api_key_id` | PERM: api-key:read | `org-by-id` | ✅ BFLA + cross-organization |
| PATCH | `/api/v1/tenancy/organization/api-keys/:api_key_id` | PERM: api-key:manage | `org-by-id` | ✅ BFLA + cross-organization |
| DELETE | `/api/v1/tenancy/organization/api-keys/:api_key_id` | PERM: api-key:manage | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/tenancy/organization/api-keys/:api_key_id/rotate` | PERM: api-key:manage | `org-by-id` | ✅ BFLA + cross-organization |
| GET | `/api/v1/tenancy/organization/audit-logs` | PERM: audit-log:read | `org-collection` | ✅ BFLA (matrix) |
| DELETE | `/api/v1/tenancy/organization/invitations/:invitation_id` | PERM: invitation:manage | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/tenancy/organization/invitations/:invitation_id/resend` | PERM: invitation:manage | `org-by-id` | ✅ BFLA + cross-organization |
| POST | `/api/v1/tenancy/organization/leave` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| PUT | `/api/v1/tenancy/organization/logo` | PERM: organization:update | `org-collection` | ✅ BFLA (matrix) |
| DELETE | `/api/v1/tenancy/organization/logo` | PERM: organization:update | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/tenancy/organization/memberships` | PERM: membership:read | `org-collection` | ✅ BFLA (matrix) |
| POST | `/api/v1/tenancy/organization/memberships` | PERM: membership:manage | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/tenancy/organization/memberships/:membership_id` | PERM: membership:read | `org-by-id` | ✅ BFLA + cross-organization |
| PATCH | `/api/v1/tenancy/organization/memberships/:membership_id` | PERM: membership:manage | `org-by-id` | ✅ BFLA + cross-organization |
| DELETE | `/api/v1/tenancy/organization/memberships/:membership_id` | PERM: membership:manage | `org-by-id` | ✅ BFLA + cross-organization |
| GET | `/api/v1/tenancy/organization/memberships/:membership_id/permissions` | PERM: membership:read | `org-by-id` | ✅ BFLA + cross-organization |
| GET | `/api/v1/tenancy/organization/notification-policies` | PERM: notification-policy:read | `org-collection` | ✅ BFLA (matrix) |
| POST | `/api/v1/tenancy/organization/notification-policies` | PERM: notification-policy:manage | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/tenancy/organization/notification-policies/:notification_policy_id` | PERM: notification-policy:read | `org-by-id` | ✅ BFLA + cross-organization |
| PATCH | `/api/v1/tenancy/organization/notification-policies/:notification_policy_id` | PERM: notification-policy:manage | `org-by-id` | ✅ BFLA + cross-organization |
| DELETE | `/api/v1/tenancy/organization/notification-policies/:notification_policy_id` | PERM: notification-policy:manage | `org-by-id` | ✅ BFLA + cross-organization |
| GET | `/api/v1/tenancy/organization/roles` | PERM: role:read | `org-collection` | ✅ BFLA (matrix) |
| POST | `/api/v1/tenancy/organization/roles` | PERM: role:manage | `org-collection` | ✅ BFLA (matrix) |
| GET | `/api/v1/tenancy/organization/roles/:role_id` | PERM: role:read | `org-by-id` | ✅ BFLA + cross-organization |
| PATCH | `/api/v1/tenancy/organization/roles/:role_id` | PERM: role:manage | `org-by-id` | ✅ BFLA + cross-organization |
| DELETE | `/api/v1/tenancy/organization/roles/:role_id` | PERM: role:manage | `org-by-id` | ✅ BFLA + cross-organization |
| GET | `/api/v1/tenancy/organization/roles/:role_id/permissions` | PERM: role:read | `org-by-id` | ✅ BFLA + cross-organization |
| PUT | `/api/v1/tenancy/organization/roles/:role_id/permissions` | PERM: role:manage | `org-by-id` | ✅ BFLA + cross-organization |
| GET | `/api/v1/tenancy/organization/settings` | PERM: organization:read | `org-collection` | ✅ BFLA (matrix) |
| PATCH | `/api/v1/tenancy/organization/settings` | PERM: organization:update | `org-collection` | ✅ BFLA (matrix) |
| POST | `/api/v1/tenancy/organization/transfer-ownership` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| GET | `/api/v1/tenancy/organizations` | AUTH | `auth-self-list` | ✅ caller-scoped |
| POST | `/api/v1/tenancy/organizations` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| GET | `/api/v1/tenancy/organizations/by-slug/:slug` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| GET | `/api/v1/tenancy/permissions` | AUTH | `auth-self-list` | ✅ caller-scoped |

### UPLOAD (4)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/uploads` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| GET | `/api/v1/uploads/:upload_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| DELETE | `/api/v1/uploads/:upload_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| POST | `/api/v1/uploads/:upload_id/confirm` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |

### USER (17)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/users` | ROLE: super_admin, admin | `global-role` | ⚠ partial (admin-deny) |
| GET | `/api/v1/users/:user_id` | ROLE: super_admin, admin | `global-role` | ✅ admin-deny e2e (Phase 2) |
| PATCH | `/api/v1/users/:user_id` | ROLE: super_admin, admin | `global-role` | ✅ admin-deny e2e (Phase 2) |
| DELETE | `/api/v1/users/:user_id` | ROLE: super_admin, admin | `global-role` | ✅ admin-deny e2e (Phase 2) |
| POST | `/api/v1/users/:user_id/suspend` | ROLE: super_admin, admin | `global-role` | ✅ admin-deny e2e (Phase 2) |
| POST | `/api/v1/users/:user_id/unsuspend` | ROLE: super_admin, admin | `global-role` | ✅ admin-deny e2e (Phase 2) |
| GET | `/api/v1/users/me` | AUTH | `auth-self-list` | ✅ caller-scoped |
| PATCH | `/api/v1/users/me` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| DELETE | `/api/v1/users/me` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| PUT | `/api/v1/users/me/avatar` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| DELETE | `/api/v1/users/me/avatar` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| POST | `/api/v1/users/me/data-export` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| GET | `/api/v1/users/me/data-export/:data_export_id` | AUTH | `auth-by-id` | ✅ e2e attack test (Phase 2) |
| GET | `/api/v1/users/me/notification-preferences` | AUTH | `auth-self-list` | ✅ caller-scoped |
| PUT | `/api/v1/users/me/notification-preferences` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |
| GET | `/api/v1/users/me/settings` | AUTH | `auth-self-list` | ✅ caller-scoped |
| PATCH | `/api/v1/users/me/settings` | AUTH | `auth-self-mutation` | ⚠ self; not asserted |

### OPS (2)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/internal/ops/circuit-breakers` | TOKEN: metrics | `bearer-token` | ✅ token-auth |
| POST | `/internal/ops/circuit-breakers/:circuit_name/reset` | TOKEN: metrics | `bearer-token` | ✅ token-auth |

### HEALTH (2)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/livez` | PUBLIC | `public` | — (n/a authz) |
| GET | `/readyz` | PUBLIC | `public` | — (n/a authz) |

### METRICS (1)

| Method | Path | Access | Bucket | Status |
| --- | --- | --- | --- | --- |
| GET | `/metrics` | TOKEN: metrics | `bearer-token` | ✅ token-auth |

---

## How the gaps close

- **Phase 1 (done):** `route-authorization-model.json` (49 entries) declares the model for every object-by-id protected route; `authz-model-coverage.global.test.ts` fails CI if a by-id route is added without a model entry.
- **Phase 2 (done):** the matrix in `src/tests/security/authz/` (80 tests, 7 suites) asserts attacker outcomes e2e (cross-user, cross-organization read + write, tier, grant, email, global-role) with `verifyNoMutation`. `authz-runtime-coverage.global.test.ts` now fails CI if a modelled route lacks a mapped runtime attack test — so gaps 1, 2, 4 cannot silently reappear. Closes gaps 1–2 and 4 (by-id surface).
- **Phase 3 (next):** caller-scope assertions for `auth-self-mutation` (gap 5), grant-grantability on create paths (gap 3 residual), and business-flow abuse (gap 6).
