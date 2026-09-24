#!/usr/bin/env bash
# Claude Code PostToolUse hook (Read | Grep).
#
# Token-efficiency nudge: when the agent reads a LARGE file whole, or runs a
# repo-wide content Grep, inject a one-line reminder to prefer the code index
# (codegraph), a ranged Read, or a delegated Explore subagent — and to compress
# large output with headroom. Operationalizes agent-os/rules/be-token-efficient-navigation.mdc.
#
# Non-blocking (PostToolUse can only add context — the tool already ran). Fires
# only on the wasteful shapes, so an ordinary scoped read/grep is silent. Adds
# context via hookSpecificOutput.additionalContext. Fails OPEN: missing jq / no
# input / any error exits 0.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "large-read-nudge" "PostToolUse"

command -v jq >/dev/null 2>&1 || exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
INPUT=$(cat)

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
LARGE_FILE_BYTES=25000  # ~600 lines: below this a whole-file read is cheap enough

hint=""
case "$TOOL" in
  Read)
    file=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
    has_limit=$(printf '%s' "$INPUT" | jq -r '.tool_input | (has("limit") or has("offset"))' 2>/dev/null || echo "true")
    # Whole-file read (no offset/limit) of a large file → nudge.
    if [[ -n "$file" && "$has_limit" == "false" && -f "$file" ]]; then
      size=$(wc -c <"$file" 2>/dev/null | tr -d ' ' || echo 0)
      if [[ "$size" -gt "$LARGE_FILE_BYTES" ]]; then
        hint="Read a large file whole (${size} bytes). For \"where/who/what\" prefer codegraph (codegraph_search / callers / impact) or a ranged Read (offset/limit); if you must load it all, compress with headroom_compress. (be-token-efficient-navigation)"
      fi
    fi
    ;;
  Grep)
    mode=$(printf '%s' "$INPUT" | jq -r '.tool_input.output_mode // "files_with_matches"' 2>/dev/null || echo "")
    scoped=$(printf '%s' "$INPUT" | jq -r '.tool_input | (has("path") or has("glob"))' 2>/dev/null || echo "true")
    # Repo-wide CONTENT grep (no path/glob scope) → nudge.
    if [[ "$mode" == "content" && "$scoped" == "false" ]]; then
      hint="Repo-wide content grep with no path/glob scope. Prefer codegraph_search for symbols/usages, or scope the grep; for a broad sweep delegate to a read-only Explore subagent (skill: be-delegate-search) so the reads stay out of your context."
    fi
    ;;
esac

[[ -z "$hint" ]] && exit 0

# Record what was flagged (bytes for a whole-file read, "grep=unscoped" for a
# repo-wide grep) so `pnpm agent-os:hooks:report` can quantify the flagged
# volume — turning the compression advice into a measurable feedback loop.
detail="grep=unscoped"
[[ "$TOOL" == "Read" ]] && detail="bytes=${size:-0}"
telemetry_fired "$detail"
jq -cn --arg c "⚡ token-efficiency: ${hint}" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
exit 0
