---
name: be-lint-warnings-handler
description: Detail guide for resolving Biome lint warnings. Invoked by be-code-smells-and-best-practices only — not a separate auto-trigger. Handle warnings yourself; prefer fixing over disabling.
indexNote: detail; via code-smells
---

# Lint warnings handler (core-be)

## Purpose

**Detail guide** for Biome lint warnings. The **be-code-smells-and-best-practices** skill owns quality for `src/` edits; read this file when you need per-rule fix patterns. **Do not ask the user** how to handle a warning—apply the guidance below.

## Rule

**Zero new warnings in files you edited.** Pre-commit (`lint-staged`) and CI (`pnpm validate`) enforce the full repo; fix warnings inline in touched files without re-running full lint unless the hook failed.

## How to resolve each warning type

### 1. Duplicate string literals (extract to a named constant instead — no direct Biome equivalent)

- **Prefer:** Extract the repeated string to a named constant at module or function scope.
- **Where:** At the top of the file (after imports) or in a small `const` block.
- **Example:** If `/api/v1/auth` appears 4+ times, add `const AUTH_PREFIX = '/api/v1/auth' as const;` and use `AUTH_PREFIX`.
- **Exception:** If the literal appears only in one test and extracting would hurt readability, fix the underlying duplication rather than suppressing.

### 2. `noExcessiveLinesPerFunction (complexity)` (Function has too many lines)

- **Prefer:** Split the function into smaller helpers (same file or extracted module). Keep route handlers under ~80 lines when possible.
- **Exception:** Route aggregators (`*Routes` that register many sub-routes), large test `describe` callbacks, and CLI script entry functions may use:
  `// biome-ignore lint/complexity/noExcessiveLinesPerFunction: route aggregator` (or `test suite`, `CLI entry`).

### 3. Generic Object Injection Sink (validate input explicitly — no Biome equivalent)

- **Prefer:** Use a typed map, `Record<KnownKey, T>`, or allowlist of keys. Avoid `obj[userInput]` when userInput is untrusted.
- **When safe:** Keys are from an enum, validated schema, or static list (e.g. parsing OpenAPI spec). Add a comment explaining why the access is safe.
- **Never suppress** when the key is raw request input without validation.

### 4. `noConsole (suspicious)` (Only warn, error allowed)

- **Prefer:** Use `logger` from `@/shared/utils/infrastructure/logger.util.js` (e.g. `logger.info`, `logger.warn`, `logger.error`).
- **Exception:** Standalone CLI scripts (e.g. `validate-domain.ts`, `upload-postman-collection.ts`) that run outside the app and need stdout:
  `// biome-ignore lint/suspicious/noConsole: CLI script output`

### 5. `noExcessiveCognitiveComplexity (complexity)`

- **Prefer:** Simplify conditionals, extract helpers, use early returns or lookup tables.
- **Exception:** Complex but stable logic (e.g. OpenAPI field mapping) may use:
  `// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: structured mapping`

### 6. Identical functions (extract shared function — no Biome equivalent)

- **Prefer:** Extract shared logic into one function and call it from both places, or factor a small helper.

### 7. `useCollapsedIf (style)`

- **Prefer:** Collapse nested `if` statements into a single `if` with a combined condition, as the rule suggests.
- **Exception:** When the two conditions have logically distinct concerns and collapsing would hurt readability:
  `// biome-ignore lint/style/useCollapsedIf: <explain why>`

### 8. Single boolean return (simplify manually — no Biome equivalent)

- **Prefer:** Return a single boolean expression directly instead of `if (x) return true; return false;`.

## Biome suppression comment format

When a suppress comment is truly necessary (fix is always preferred), use the following format:

```typescript
// biome-ignore lint/<category>/<rule>: <reason>
const result = someExpression;
```

Examples:

```typescript
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: structured OpenAPI field mapping
function mapOpenApiFields(spec: OpenApiSpec) { ... }

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: CLI entry point
async function main() { ... }

// biome-ignore lint/suspicious/noConsole: CLI script output
console.log(result);

// biome-ignore lint/style/useCollapsedIf: conditions guard distinct concerns
if (isAuthenticated) {
  if (hasPermission) { ... }
}
```

## Checklist before finishing

1. Run `pnpm lint` and ensure no **new** warnings in modified files.
2. If you added a `biome-ignore` comment, the comment must state the **reason** (e.g. `route aggregator`, `CLI script`, `structured mapping`).
3. Do not introduce new `any` or unsafe regex; those remain errors.

## Scope

- Applies to all TypeScript under `src/`.
- When in doubt, fix the cause rather than disabling the rule.
