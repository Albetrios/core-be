`src/domains/tenancy/sub-domains/organization/organization-settings/`

# Organization settings (nested resource)

Parent: [organization](../organization.overview.md)

## Purpose

Read/write service for the per-organization settings row — default locale and the MFA-required flag — exposed under the active-organization resource (`/tenancy/organization/settings`). Also provides two unscoped helpers consumed during authentication, before any tenant context exists.

## Layout

- `organization-settings.controller.ts` / `organization-settings.service.ts` — thin HTTP + application layer
- `organization-settings.repository.ts` / `organization-settings.schema.ts` — persistence for the settings row
- `organization-settings.dto.ts` / `organization-settings.validator.ts` / `organization-settings.serializer.ts` / `organization-settings.types.ts` — request/response shaping
- `i18n-locale.cache.ts` — cached default-locale lookup used by the i18n middleware
- `seed/` — seed contribution for settings rows
- `__tests__/unit/` — validator/serializer/service unit suites

## Key invariants

- PATCH semantics: only provided fields change (`omitUndefined` in the service); the settings row is lazily upserted on first write, so an organization without a row behaves as all-defaults.
- `resolveDefaultLocaleForOrganization` (falls back to `'en'`) and `userHasOrganizationRequiringMfa` intentionally run **without** organization RLS context — they execute at login/i18n time before the tenant GUC is set; every other read/write is organization-scoped.
