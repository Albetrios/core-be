---
name: be-openapi-multilingual
description: Maintain and generate multilingual OpenAPI documentation. Use when adding a locale, changing OpenAPI copy (info, tags, responses), or adding routes that need translated operation text.
trigger: src/shared/locales/*/openapi.json
triggerNote: Multilingual OpenAPI copy
indexNote: generate/maintain multilingual OpenAPI from locale openapi.json
---

# OpenAPI multilingual (core-be)

## Purpose

Keep **multilingual OpenAPI documentation** in sync with the API. The generator produces locale-specific specs (`docs/openapi/openapi.{locale}.json`) from `src/shared/locales/{locale}/openapi.json`. Use this skill when you add a locale, change API doc copy, or add new tags/response keys.

## When to Use

- **After route changes** — run **be-route-schema-doc-guard** first to add `schema: { summary, description, tags }` on the Fastify registration; use this skill for locale file parity and generation.
- **Adding or changing OpenAPI documentation** for a new locale (e.g. add `src/shared/locales/<locale>/openapi.json` for `fr`)
- **Adding or editing** strings in `src/shared/locales/*/openapi.json` (info, tags, components, responses)
- **Adding a new tag** used in route metadata — add the tag key and description to all `src/shared/locales/*/openapi.json` files so translated specs stay complete
- **Adding a new response key** used in `buildResponses` — add the key to all locale files with the same structure as `responses` in `src/shared/locales/en/openapi.json`

## How It Works

1. **Locale files**: Each supported locale has `src/shared/locales/{locale}/openapi.json` with:
   - **info**: `title`, `description` (API title and top-level description)
   - **servers**: `local` (description for the default server)
   - **tags**: object mapping tag name → description (e.g. `"Health": "Server health and readiness probes"`)
   - **components**: `bearerAuthDescription` (security scheme description)
   - **responses**: common response description keys: `success`, `created`, `noContent`, `validationError`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `internalError`

2. **Generation**:
   - `pnpm docs:generate` — uses default locale `en`; writes `docs/openapi/openapi.json` and `docs/openapi/openapi.en.json`
   - `OPENAPI_LOCALE=es pnpm docs:generate` — uses Spanish; writes `docs/openapi/openapi.es.json`
   - `pnpm docs:generate:multilang` — runs the generator for each locale (en, es) in sequence

3. **Operation summaries and descriptions**: Route-level summary, description, and tags come from the Fastify `schema` block on the route registration in `*.routes.ts` (read by `tooling/openapi/extractors/route-schema-metadata.ts`). Those are currently English-only. To support per-locale operation text later, you could add a `routes` object in each `src/shared/locales/{locale}/openapi.json` mapping route key (e.g. `"GET /readyz"`) to `{ "summary": "...", "description": "..." }` and have the generator prefer locale routes when present.

## How to Run (checklist)

1. **Add a new locale** (e.g. French):
   - Copy `src/shared/locales/en/openapi.json` to `src/shared/locales/<locale>/openapi.json` (e.g. `fr`).
   - Translate all values (info, tags, components, responses). Keep keys unchanged.
   - Add `fr` to the `docs:generate:multilang` script in `package.json` (e.g. `OPENAPI_LOCALE=fr pnpm docs:generate`).
   - Run `pnpm docs:generate:multilang` and confirm `docs/openapi/openapi.fr.json` is generated.

2. **Add a new tag** (used in route metadata):
   - Add the tag name and English description to `src/shared/locales/en/openapi.json` under `tags`.
   - Add the same tag key and translated description to every other locale file (`src/shared/locales/es/openapi.json`, etc.).

3. **Add a new response description key**:
   - If the generator is updated to use a new key in `buildResponses`, add that key to all `src/shared/locales/*/openapi.json` under `responses` with the same structure as existing keys.

4. **Regenerate after changes**:
   - After editing any `src/shared/locales/*/openapi.json`, run `pnpm docs:generate` (single locale) or `pnpm docs:generate:multilang` (all locales).

## File Reference

| File                                                           | Purpose                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/shared/locales/en/openapi.json`                           | English OpenAPI strings (info, tags, components, responses)            |
| `src/shared/locales/es/openapi.json`                           | Spanish OpenAPI strings                                                |
| `src/scripts/codegen/generate-openapi.ts`                              | Loads locale, builds spec, writes `docs/openapi/openapi.{locale}.json` |
| `docs/openapi/openapi.json`                                    | Default spec (generated when locale is `en`)                           |
| `docs/openapi/openapi.en.json`, `docs/openapi/openapi.es.json` | Locale-specific specs from `pnpm docs:generate:multilang`              |

## Dependencies

- **be-i18n-message-guard**: Not required for OpenAPI locale files; OpenAPI uses its own namespace (`openapi.json` per locale). If you later add shared keys between API errors and OpenAPI, keep both in sync.
- **be-route-catalog**: When you add routes, the new `schema: { summary, description, tags }` block on each Fastify registration must use tag names that already exist in `src/shared/locales/*/openapi.json` under `tags`.

## Maintaining This Skill

If the generator adds new string sources (e.g. per-operation summary/description from locale files, or new component keys), update this skill to describe the new keys and the checklist so all locales stay in sync.
