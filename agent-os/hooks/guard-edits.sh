#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "guard-edits" "PreToolUse"
# Claude Code PreToolUse hook (Edit | Write | MultiEdit).
#
# BLOCKS edits that introduce a hard-rule violation documented in CLAUDE.md and
# already enforced by global tests / CI — moving enforcement left from "you find
# out at pre-commit/CI" to an instant denial at the keystroke.
#
# Rules (deliberately conservative — only unambiguous, mechanically-checkable
# violations, so a normal edit is never blocked):
#   R1  getRequestDatabase() inside *.worker.ts | *.processor.ts
#   R2  a `../` relative import/require added under src/
#   R3  hand-editing a generated / do-not-edit file
#   R4  NODE_ENV set/compared to a removed value (test|staging) — enum is local|development|production
#   R5  editing the enforcement wiring itself (hook manifest / platform hook
#       configs / guard scripts) escalates to explicit user confirmation
#       ("ask") — the guard layer must not be silently disarmable by a session
#
# Fails OPEN: any parsing hiccup, or a missing `jq`, allows the edit. A hook bug
# must never be able to brick a session.

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE" ]] && exit 0

# The text being written: Write.content, Edit.new_string, MultiEdit.edits[].new_string.
CONTENT=$(printf '%s' "$INPUT" | jq -r '
  [ .tool_input.content, .tool_input.new_string, ( .tool_input.edits // [] | .[].new_string ) ]
  | map(select(. != null)) | join("\n")' 2>/dev/null || echo "")

base=${FILE##*/}

deny() {
  telemetry_fired
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

ask() {
  telemetry_fired
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

# R3 — generated / do-not-edit files (change the source + run the generator instead).
case "$FILE" in
  *pnpm-lock.yaml | *docs/routes.txt | *docs/openapi/openapi*.json | *docs/postman-collection.json | *project-identity.constants.ts | *docs/database/core-be.dbml | *.codex/hooks.json | *agent-os/platforms/codex/hooks.json)
    deny "'$base' is generated — do not hand-edit it. Change the source and run the generator (see agent-os/docs/skill-triggers.md / CLAUDE.md)." ;;
esac

# R5 — config self-protection: the enforcement wiring (hook manifest, platform
# hook configs, capability registry, guard scripts) must not be silently
# rewritten by a session — a compromised or confused agent could disarm every
# guard in one edit. Escalate to an explicit user confirmation instead of deny,
# so legitimate hook work proceeds with the user's eyes on it.
case "$FILE" in
  *agent-os/hooks/hooks.json | *agent-os/platforms/targets.json | *agent-os/platforms/claude/settings.json | *.claude/settings.json | *.claude/settings.local.json | *.cursor/hooks.json | *agent-os/platforms/cursor/hooks.json | *agent-os/hooks/guard-edits.sh | *agent-os/hooks/guardrails.mjs | *agent-os/hooks/cursor-shell-guard.mjs | *agent-os/hooks/cursor-edit-guard.mjs | *agent-os/hooks/cursor-read-guard.mjs | *agent-os/hooks/cursor-mcp-guard.mjs | *agent-os/hooks/injection-scan.mjs)
    ask "'$base' is part of the agent-guard enforcement wiring. Confirm this change is user-requested — hooks/guards must never be weakened or disabled without explicit approval (agent-os/hooks/README.md)." ;;
esac

# R1 — workers/processors must not call getRequestDatabase() (it returns the GUC-less pool and
# throws in worker runtime). Importing DB-handle types / setLocalDatabaseConfig from
# database-context-runtime is allowed — workers bind their handle via a context wrapper, matching
# no-direct-db-in-services.global.test.ts (which only forbids getRequestDatabase / database / sql).
case "$FILE" in
  *.worker.ts | *.processor.ts)
    if printf '%s' "$CONTENT" | grep -Eq 'getRequestDatabase'; then
      deny "Workers/processors must not call getRequestDatabase() (RLS — it returns the GUC-less pool). Bind a handle via a context wrapper — withAppDatabaseContext / runTenantScopedWorkerJob (CLAUDE.md → Organization context / RLS; enforced by global tests)."
    fi ;;
esac

# R2 — no `../` parent-relative imports under src/ (use the @/ alias).
case "$FILE" in
  */src/*.ts | */src/*.tsx | src/*.ts | src/*.tsx)
    if printf '%s' "$CONTENT" | grep -Eq "(from|require|import)[[:space:]]*\(?[[:space:]]*['\"]\.\./"; then
      deny "Relative parent import ('../') is banned under src/ — use the '@/' alias (import-paths.mdc; enforced by import-paths.global.test.ts)."
    fi ;;
esac

# R4 — the NODE_ENV enum is `local` | `development` | `production`. Never set/compare it to a REMOVED
# value (test|staging): the enum rejects them and the Vitest suite runs as `development`. `local` IS a
# valid runtime (the developer's machine; primary file `.env.local`, default when NODE_ENV is unset), so
# it is NOT blocked. Requires an actual `:`/`=` after NODE_ENV so prose isn't blocked. Docs
# (.md/.mdc/.txt) may quote the pattern to explain the rule, so they are exempt (nor are they scanned by
# the global guard).
case "$FILE" in
  *.md | *.mdc | *.txt) : ;;
  *)
    if printf '%s' "$CONTENT" | grep -Eiq "NODE_ENV[[:space:]]*[:=]+[[:space:]]*['\"\`]?(test|staging)\b"; then
      deny "NODE_ENV must never be 'test' or 'staging' (the enum is 'local' | 'development' | 'production'; the Vitest suite runs as 'development'). Drive environment-varying behaviour via an explicit env flag with a static default + production .refine() (agent-os/skills/env-schema-add/SKILL.md; enforced by no-nodeenv-branching.global.test.ts)."
    fi ;;
esac

exit 0
