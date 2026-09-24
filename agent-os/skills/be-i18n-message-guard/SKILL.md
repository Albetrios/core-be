---
name: be-i18n-message-guard
description: When a user-facing message is added or changed in the codebase, ensure it uses a translation key and that the key exists in src/shared/locales/en/. Do not allow raw user-facing strings in errors, success payloads, or error-handler copy.
trigger: src/shared/locales/**/*.json
triggerNote: User-facing copy / translation keys
indexNote: user-facing copy uses translation keys present in locales/en
---

# i18n message guard (core-be)

Run this skill when **any** of the following are created or modified:

- **Error and validation**: `src/shared/errors/*.ts`, `src/shared/middlewares/core/error-handler.middleware.ts`, any `*.validator.ts` under `src/domains/`
- **Services/controllers that can return messages**: `src/domains/**/*.service.ts`, `src/domains/**/*.controller.ts` when the change touches `throw` statements, return values with `message`, or response payloads
- **Constants that hold user-facing text**: `src/shared/constants/*.ts` (e.g. message constants)
- **Locale files**: `src/shared/locales/**/*.json` when keys are added or renamed

## What to do

### After code change (errors, validators, services, controllers)

1. **If the change introduces or edits a user-facing string** (e.g. in `throw new XError('...')`, `return { message: '...' }`, or constants used in responses):
   - Use a **translation key** (e.g. `errors:notFound`, `success:emailVerified`) and, in the error handler or controller, use `request.t(key, params)`.
   - Add or update the key in **`src/shared/locales/en/errors.json`** or **`src/shared/locales/en/success.json`** (or **common.json**) with the English string.
   - If other locales exist (e.g. `src/shared/locales/es/`), add or update the same key in `src/shared/locales/es/` (and other locales).

2. **If the change introduces a new translation key in code** (e.g. `request.t('errors:newKey')` or `throw new NotFoundError('errors:newKey', ...)`):
   - Ensure **`src/shared/locales/en/`** contains that key. Optionally update other locale files.

### After locale file change

- If a key is **added or renamed** in `src/shared/locales/en/` or `src/shared/locales/es/`:
  - Ensure at least one code path uses that key (error constructor, error handler, or controller with `request.t()`).
- If a key was **removed or renamed**:
  - Ensure no code still references the old key.

## Checklist to enforce

- [ ] No raw user-facing message strings in `throw new AppError(...)`, `throw new ValidationError(...)`, or subclasses (use **messageKey** + **messageParams**).
- [ ] No hardcoded user-facing strings in the error handler’s `detail` or `errors[].message` (use `request.t()` with keys).
- [ ] No `return { message: '...' }` with a raw string from services that reach the client; use **messageKey** and controller-side `request.t()`.
- [ ] Every key used in code exists in **`src/shared/locales/en/`** (and in other locales if they exist).
- [ ] New keys are added to **`src/shared/locales/en/`** first, then to other locales.

## The raw-key trap: `detail` is resolved copy, never a stable key

`error-handler.middleware.ts → translateDetail` resolves a messageKey to human copy
in three tiers: **per-request `request.t`** (honours `Accept-Language`) → the
**initialised i18next singleton** (default language, for errors thrown *before* the
i18n hook decorates the request — e.g. the captcha / disposable-email guards) → the
messageKey as a last-resort fallback. So a response `detail` is **localized copy**,
NOT a raw `errors:*` key — and it can change with wording or locale.

Two hard rules follow:

- **Client code and tests MUST NOT depend on the human `detail`/`message` text** — not
  equality, not substring. Branch on the **stable machine fields**: `error.reason`
  (snake_case sub-code) or `error.code` (status-class slug), plus the HTTP status.
  A test asserting `body...includes('disposable')` or `detail === 'errors:foo'` only
  passes while the raw key *leaks*; the moment the serializer resolves it, the test
  flakes/breaks (this is exactly what a raw-key-leaking test did after the singleton
  fallback landed — 4 disposable-email security tests went non-deterministic).
- **When a 4xx error is a distinct cause the FE may branch on, tag it** with
  `.withReason('<snake_case_slug>')` at the throw site and register the slug in
  [`docs/reference/api/response-codes.md`](../../../docs/reference/api/response-codes.md)
  (see the **be-api-contract-guard** skill). Then assert on `error.reason` in tests.

### Checklist additions

- [ ] No test asserts on a raw `errors:*` key or a human-copy substring in a response body — assert `error.reason` / `error.code` / status instead.
- [ ] A new FE-relevant 4xx cause carries `.withReason('<slug>')`; the slug is added to the `response-codes.md` reason registry.

## Reference

- **`docs/reference/runtime/internationalization.md`** — i18n conventions and key format (`namespace:key`).
- **`CLAUDE.md`** — Key Patterns bullet on i18n.
