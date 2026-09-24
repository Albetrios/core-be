---
name: be-code-smells-and-best-practices
description: When adding or modifying code in src/, fix Biome lint issues in touched files. Full validate runs on pre-commit and CI — do not duplicate. Uses be-lint-warnings-handler for warning details.
indexNote: fix Biome issues in touched src/ files while implementing
---

# Code smells and best practices (core-be)

## Purpose

Single owner for **code quality** under `src/`. Fix issues in files you change. Pre-commit and CI enforce full-repo lint, format, and types — do not run `pnpm lint` + `pnpm typecheck` on every small edit unless the hook failed or you are closing a large task.

## Rule

**Zero new lint errors or warnings in files you edited.** Resolve issues before finishing the task.

## Checklist

1. **Fix Biome lint issues** in touched files (errors always; warnings per guidance below and in `agent-os/skills/be-lint-warnings-handler/SKILL.md`).
2. **Full-repo checks** — only when:
   - Pre-commit or CI failed → use **be-before-commit-guard**
   - Large PR-sized change before handoff → `pnpm validate`
3. **Do not ask the user** how to fix warnings — apply guidance and move on.

## Code smells and fixes

### Lint errors (must fix)

- **useImportType**: Use `import type` for type-only imports (e.g. `import type { z } from 'zod'`).
- **Unsafe regex / dynamic keys**: Use bounded patterns or typed maps; add `biome-ignore` with justification when keys are from validated schema or server-controlled data.

### Lint warnings (prefer fixing)

- **noExcessiveLinesPerFunction**: Split long functions; use `biome-ignore` with reason only for route aggregators, test suites, CLI entry.
- **noExcessiveCognitiveComplexity**: Simplify conditionals, extract helpers.
- **noConsole**: Use `logger` from `@/shared/utils/infrastructure/logger.util.js`; allow console only in standalone CLI scripts (`src/scripts/**` overrides allow it).

### Best practices

- Prefer `import type` for type-only imports.
- **Import paths**: use `@/` in `src/` and `@tooling/` in tooling for cross-folder imports; same-folder `./` only. Never `../` (CI: `import-paths.global.test.ts`).
- Avoid unnecessary `as` type assertions; use proper typing or Zod schemas where possible.
- Use Zod `parse()` instead of `safeParse` + `as` in validators when the function always throws on invalid input.
- Keep functions under ~100 lines; extract helpers when logic grows.

## Relation to other skills

- **be-lint-warnings-handler**: Per-warning resolution guide (detail only — not a separate trigger).
- **be-before-commit-guard**: When `git commit` or CI fails.
- **be-structure-maintainer**: When adding/renaming files or directories.
- **be-route-catalog**: When adding/removing routes (`pnpm routes:catalog` once; CI `routes:catalog:check` verifies).

## Scope

- Applies to all TypeScript under `src/`.
