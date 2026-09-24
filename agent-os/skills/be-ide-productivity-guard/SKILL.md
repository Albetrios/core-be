---
name: be-ide-productivity-guard
description: Keeps workspace extensions and settings backend-relevant and productive. Use when editing .vscode/extensions.json or .vscode/settings.json, when the user asks for IDE or productivity recommendations, or when adding/changing project tooling (test runner, linter, ORM, queue) that has a well-known VS Code extension.
trigger: .vscode/extensions.json, .vscode/settings.json
triggerNote: Backend-relevant IDE tooling
indexNote: keep .vscode extensions/settings backend-relevant
---

# IDE productivity guard (core-be)

Run this skill when **any** of the following apply:

1. **`.vscode/extensions.json`** or **`.vscode/settings.json`** is created or modified.
2. The user asks for IDE or productivity recommendations (extensions, settings).
3. You add or change project tooling (e.g. new test framework, linter, ORM, queue) — check if a well-known VS Code extension exists and add it to recommendations if missing.
4. Optionally when running **be-structure-maintainer** or after significant codebase/tooling changes, to ensure `.vscode` is still aligned.

## Trigger summary

| Trigger                                                                                                    | Action                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Edit `.vscode/extensions.json` or `.vscode/settings.json`                                                  | Apply checklist below; keep extensions backend-only, settings aligned.                          |
| User asks for productivity/IDE recommendations                                                             | Suggest from curated list; add to `.vscode` if user agrees.                                     |
| Add or change dependency/config with a popular extension (Vitest, Drizzle, BullMQ, Biome, etc.) | Consider adding that extension to `extensions.json` and any useful settings to `settings.json`. |

## Curated extensions (core-be)

Backend-only. Do **not** add: Tailwind, React snippets, Playwright UI, or HTML/JSX-only extensions.

- `biomejs.biome` — Biome (lint + format)
- `ms-vscode.vscode-typescript-next` — TypeScript (workspace)
- `vitest.explorer` — Vitest
- `christian-kohler.path-intellisense` — Path Intellisense
- `streetsidesoftware.code-spell-checker` — Code Spell Checker
- `usernamehw.errorlens` — Error Lens
- `gruntfuggly.todo-tree` — Todo Tree
- `eamodio.gitlens` — GitLens
- `mhutchie.git-graph` — Git Graph
- `EcksDy.env-switcher` — .ENV Switcher

## Curated settings (core-be)

Keep these aligned in `.vscode/settings.json`:

- **Editor:** format on save, tab size 2, rulers [90], bracket pairs, sticky scroll, quickSuggestions.strings, codeActionsOnSave (`source.fixAll.biome`, organizeImports never).
- **Files:** eol `\n`, trimTrailingWhitespace, insertFinalNewline, exclude (node_modules, dist, .git, coverage), watcherExclude.
- **TypeScript:** workspace TS SDK, importModuleSpecifier non-relative (aligns with `agent-os/rules/be-import-paths.mdc` — `@/` in `src/`, `@tooling/` in tooling), importModuleSpecifierEnding `js`, autoImports, updateImportsOnFileMove always.
- **Biome:** `editor.defaultFormatter` = `biomejs.biome` for `[typescript]`, `[json]`, `[jsonc]` (markdown: markdownlint for lint; optional Biome format in editor).
- **Search exclude:** node_modules, dist, .git, coverage, pnpm-lock.yaml.
- **Terminal:** defaultProfile.osx zsh, scrollback 5000.
- **Explorer:** fileNesting enabled, patterns: tsconfig → `tsconfig._.json`, package.json → pnpm-lock.yaml + biome.json + .biomeignore, .env → `.env._`.
- **envSwitcher:** glob.target `.env`, glob.presets `.env*`.
- **Vitest (multi-config):** `vitest.workspaceConfig` → `.vscode/vitest.workspace.ts` (editor only; do **not** add root `vitest.workspace.ts` — that changes default `vitest run` / `pnpm test` behavior).
- **cSpell.words:** Merge existing backend list; do not add frontend-only words (e.g. oklch, POSTHOG, signups, VITE).

## Git tracking (`.gitignore`)

`.gitignore` ignores `.vscode/*` by default. Un-ignore shared team files:

```gitignore
.vscode/*
!.vscode/settings.json
!.vscode/extensions.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/vitest.workspace.ts
```

`extensions.json` must be committed so teammates get recommended-extensions prompts. Optional: `tasks.json`, `launch.json`, and `.vscode/vitest.workspace.ts` for pnpm tasks, debug profiles, and Vitest Explorer multi-project support.

## Vitest workspace (editor only)

When the repo has multiple Vitest configs (`vitest.config.ts`, `tooling/vitest/contract.config.ts`, `tooling/vitest/chaos.config.ts`, `tooling/vitest/stryker.config.ts`), use **`.vscode/vitest.workspace.ts`** (not at repo root) plus:

```json
"vitest.workspaceConfig": ".vscode/vitest.workspace.ts"
```

in `settings.json`. List all config paths as a default export array (Vitest 4: no `defineWorkspace`). CLI scripts keep using per-script `--config` flags unchanged.

## When adding new tooling

When you add or change a dependency or config that has a popular VS Code extension (e.g. Vitest, Drizzle, BullMQ, Biome), consider adding that extension to `.vscode/extensions.json` and any useful settings to `.vscode/settings.json`. Document briefly why (e.g. "Vitest Explorer for test run/debug from editor").

## Checklist

- [ ] Extensions in `extensions.json` are backend-relevant only (no Tailwind, React snippets, Playwright UI, HTML/JSX-only).
- [ ] Settings match the curated list above; no frontend-only blocks (Tailwind, typescriptreact formatters, files.associations for tailwindcss).
- [ ] cSpell.words merged; no frontend-only words.
- [ ] envSwitcher globs present (target `.env`, presets `.env*`).
- [ ] `.gitignore` allowlists `extensions.json` (and optional `tasks.json`, `launch.json`, `vitest.workspace.ts`).
- [ ] Multi-config Vitest: `.vscode/vitest.workspace.ts` + `vitest.workspaceConfig` (no root workspace file).
- [ ] `unwantedRecommendations` lists frontend-only extensions when `extensions.json` is updated.
