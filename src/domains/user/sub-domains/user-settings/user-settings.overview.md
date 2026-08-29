`src/domains/user/sub-domains/user-settings/`

# User settings

Parent: [user](../../user.overview.md)

## Purpose

Per-user feature toggles and presentation preferences (locale override, theme, dashboard widgets, etc.). The row is optional: if a user has no settings row, the API serializes the platform default. Writes upsert.

## Key invariants

- **Default-on semantics**: a missing row implies the platform default, never "feature disabled".
- **One row per user**: `user_id` is unique; writes upsert.
- **Settings are user-private**: nothing here is organization-scoped or visible to other users.
- **Locale override is the auth source for i18n**: when set, it overrides `Accept-Language` for response translation.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> default: user has no row → API returns platform defaults
  default --> customized: PATCH /users/me/settings (upsert row)
  customized --> customized: subsequent PATCH updates fields
  customized --> default: explicit reset (DELETE row)
```

## Failure modes

- **Unknown setting key** → 400 Validation error.
- **Locale value not in supported list** → 400.
