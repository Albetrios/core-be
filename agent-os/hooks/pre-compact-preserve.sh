#!/usr/bin/env bash
# Claude Code PreCompact hook for core-be.
#
# Before the conversation is compacted, emit a small, high-signal "resume card"
# so the essentials survive: the current branch + uncommitted-change count, any
# in-progress autonomous build under docs/builds/, and a pointer to the agent-os
# skill-routing map + definition-of-done. This keeps a long unattended build from
# losing the thread (requirement spec / current step / routing) across auto-compaction.
#
# Output: PreCompact additionalContext envelope (jq); plain stdout fallback.
# Fail-open: any error exits 0 and never blocks compaction.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "pre-compact-preserve" "PreCompact"

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" 2>/dev/null || exit 0

branch="$(git branch --show-current 2>/dev/null || echo '?')"
changed_count="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
build_dir="$(ls -dt docs/builds/*/ 2>/dev/null | head -1)"

telemetry_fired
card="$(
  echo "RESUME CARD (preserve across compaction)"
  echo "- Branch: ${branch} · uncommitted files: ${changed_count}"
  [ -n "$build_dir" ] && echo "- In-progress build: ${build_dir} — reload its build-manifest to resume the requirement."
  echo "- agent-os: consult agent-os/docs/skill-triggers.md + be-skill-index FIRST for any file you change."
  echo "- Definition of done: pnpm validate + pnpm agent-os:check green, then pnpm verify:base + /be-pre-merge-review clean."
)"

if command -v jq >/dev/null 2>&1; then
  jq -cn --arg c "$card" '{hookSpecificOutput:{hookEventName:"PreCompact",additionalContext:$c}}'
else
  printf '%s\n' "$card"
fi
exit 0
