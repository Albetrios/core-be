---
name: be-tsdoc-export-guard
description: Ensures every public TypeScript export under src/ has a TSDoc summary, and every public export in service/worker/processor/policy files has an additional @remarks block (Algorithm / Failure modes / Side effects / Notes). Use when adding or renaming exported symbols, when MISSING_DESCRIPTION or MISSING_REMARKS counts regress against `pnpm tsdoc:check`, or when authoring a policy constant.
trigger: src/**/*.ts
triggerNote: Public export added/renamed — TSDoc summary (+ @remarks on service/worker/policy)
indexNote: TSDoc summary (+ @remarks on service/worker/policy exports) on public exports
---

# TSDoc export guard (core-be)

Owns symbol-level documentation: the TSDoc comment that sits immediately above every public `export <kind> <name>` declaration. TSDoc is the canonical per-symbol documentation in this codebase — IDE hover, [TypeDoc](https://typedoc.org/), and the `pnpm tsdoc:check` coverage gate all read directly from it.

## When to run

Run this skill when:

- You add or rename an exported symbol under `src/`.
- `pnpm tsdoc:check` reports a `MISSING_DESCRIPTION` regression.
- `pnpm tsdoc:check` reports a `MISSING_REMARKS` regression on a service-like or policy-like file.
- You add a new policy constant under `src/shared/constants/`.

## What "service-like" and "policy-like" mean

The classifier inside [`tooling/tsdoc-coverage/check-coverage.ts`](../../../tooling/tsdoc-coverage/check-coverage.ts) decides which files require `@remarks` blocks:

- **Service-like**: matches `\.(service|worker|processor)\.ts$`. Every public export needs `summary` **plus** `@remarks`.
- **Policy-like**: matches `\.policy\.ts$`. Every public export needs `summary` **plus** `@remarks`.
- **Everything else**: every public export needs `summary` only.

Additionally, **policy constants** under `src/shared/constants/` (TTLs, limits, security thresholds, billing windows) require `@remarks` even though their files don't end in `.policy.ts`. The convention is enforced by review (and surfaced in `src/POLICIES.md`); the validator does not detect these automatically today.

## Required content

### Summary (every public export)

A 1-3 sentence description, written in present tense ("Persists an audit log row...", not "This function persists an audit log row..."). Use TSDoc inline links (`{@link Name}`) when referencing other exports.

```ts
/**
 * Resolves "is user X allowed to perform permission P in organization O?"
 * — backed by a Redis cache for read performance.
 */
export class AuthorizationService { ... }
```

### `@remarks` (service-like and policy-like exports)

A structured block with the following sub-sections (use plain text headings, not extra `@` tags):

```ts
/**
 * <one-line summary>
 *
 * @remarks
 * Algorithm:
 * 1. Step-by-step description of what the function does.
 * 2. Reference {@link OtherService.method} when the algorithm crosses files.
 *
 * Failure modes:
 * - <error class> → <HTTP status / observable behavior>.
 * - <another failure path>.
 *
 * Side effects:
 * - <DB writes>: which tables, which transactions.
 * - <event emissions>: event type and consumer.
 * - <cache invalidations>: which Redis keys.
 *
 * Notes:
 * - <invariant or trade-off worth knowing>.
 */
```

Real example from [`src/domains/auth/sub-domains/auth-method/email-login.service.ts`](../../../src/domains/auth/sub-domains/auth-method/email-login.service.ts):

```ts
/**
 * Issues and verifies email verification codes for the unified passwordless login + auto-signup flow.
 *
 * @remarks
 * Algorithm:
 * - {@link EmailLoginService.sendCode} validates the email, blocks disposable domains, then
 *   find-or-creates the user (unknown email → auto-signup of a passwordless user + `EMAIL_CODE`
 *   auth-method). It issues a fresh alphanumeric code under the concurrent-code cap, persists only a
 *   keyed user-scoped HMAC of it, and emits `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` with the
 *   raw code in the payload. The response is a uniform 200 for known and unknown emails.
 * - {@link EmailLoginService.login} resolves the user, applies a per-user attempt cap, atomically
 *   consumes a matching code scoped to `(user_id, EMAIL_CODE)`, invalidates the user's remaining live
 *   codes (single-use across the set), flips `is_email_verified`, and mints a JWT + session (or an
 *   MFA challenge).
 *
 * Failure modes:
 * - Disposable email → 400 errors:disposableEmail from `sendCode`.
 * - Unknown email on `login`, wrong/expired/used code, or attempt cap exceeded → 401
 *   errors:invalidOrExpiredVerificationCode.
 *
 * Side effects:
 * - `sendCode` may auto-create a user + `EMAIL_CODE` auth-method and emits a domain event whose
 *   handler enqueues an outbound email.
 * - `login` writes a single auth_sessions row and invalidates the user's other live codes.
 *
 * Notes: raw codes never flow back to HTTP callers — only via the email handler.
 */
```

### Policy-constant `@remarks`

Required structure (mirrors `src/POLICIES.md` rows):

```ts
/**
 * <one-line summary describing what the constant controls>
 *
 * @remarks
 * Rationale: <why this number was picked>.
 *
 * Consequences of change:
 * - Decreasing → <what breaks or tightens>.
 * - Increasing → <what relaxes or what risk grows>.
 *
 * Last reviewed: YYYY-MM-DD.
 */
export const VERIFICATION_CODE_TTL_MINUTES = 15;
```

Cross-link from `src/POLICIES.md`. The skill **be-system-narrative-maintainer** owns the `src/POLICIES.md` row and cross-pings this skill when a constant is added.

## TSDoc tags

Use:

- `@remarks` — required on service-like / policy-like / policy-constant exports.
- `{@link Name}` — inline cross-reference. Resolves to other TSDoc-extracted symbols. Avoid raw markdown links inside TSDoc.
- `@public` — explicitly marks an export public when the default detection might infer otherwise.
- `@internal` — explicitly marks an export internal so the renderer skips it. Useful for re-exports of internal helpers.
- `@deprecated <reason>` — flag a symbol for removal.

Avoid:

- `@param` / `@returns` — the type signature carries the contract; descriptive prose belongs in `@remarks` Algorithm.
- `@throws` — capture failure modes in `@remarks` instead so they appear inline with the symbol's behaviour contract.

## Workflow

1. Identify every public `export` declaration in the touched file. Run `pnpm tsdoc:check:report` and grep for the file path to see which ones are missing.
2. For each declaration:
   - If service-like / policy-like / policy-constant → write `summary` + `@remarks` per the structure above.
   - Otherwise → write a `summary` only.
3. For nested exports (methods inside an exported class), TSDoc the methods in addition to the class. The coverage gate pairs only with top-level `export <kind> <name>` declarations, but method-level TSDoc still appears in IDE hover and TypeDoc — write it anyway.
4. Run `pnpm tsdoc:check` to confirm no regression vs the locked budget.
5. If counts dropped, run `pnpm tsdoc:check:refresh-budget` and commit the new lower [`tooling/tsdoc-coverage/budget.json`](../../../tooling/tsdoc-coverage/budget.json).

## Anti-patterns

- ❌ TSDoc that just restates the symbol name ("`getUser` — gets a user"). Add the contract: what the input shape is, what the output guarantees, what the failure modes are.
- ❌ `@remarks` with empty sub-sections. If there's no Side effects, write "Side effects: none." Don't omit the heading.
- ❌ Auto-generated TODO placeholders. The gate flags missing summaries; a placeholder summary like `// TODO` is technically present but reviewers will reject it.
- ❌ Disabling the gate (`--no-verify` on commit, skipping CI step) instead of authoring the doc.

## Cross-skill triggers

- New policy constant → also invoke **be-system-narrative-maintainer** (add the row to `src/POLICIES.md`).

## Related references

- Coverage gate: [`tooling/tsdoc-coverage/check-coverage.ts`](../../../tooling/tsdoc-coverage/check-coverage.ts)
- Coverage README: [`tooling/tsdoc-coverage/README.md`](../../../tooling/tsdoc-coverage/README.md)
- Worked examples: every `*.service.ts` under `src/domains/audit/`, `src/domains/auth/sub-domains/auth-method/`.
