---
description: Run the local validate gate (Biome lint + format + typecheck) and fix issues you introduced
argument-hint: (no arguments)
allowed-tools: Bash(pnpm validate*), Bash(pnpm lint*), Bash(pnpm typecheck*), Bash(pnpm format*)
---

Run `pnpm validate` (Biome lint + format check + TypeScript typecheck).

If it passes, report green and stop.

If it fails:

1. Show the failing output.
2. Fix only the issues introduced by the current working-tree changes — do not
   mass-reformat or "fix" unrelated files.
3. Re-run `pnpm validate` until green.

Report the final status and what you changed.
