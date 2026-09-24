#!/usr/bin/env bash
# Claude Code PostToolUseFailure hook (Bash).
#
# When a known core-be *sync / validation gate* fails, inject a concise hint with
# the fix command and the owning skill — turning a raw non-zero exit into a fix
# path. Scoped to gates only: an ordinary failed command (a grep with no match, a
# test mid-TDD) produces no output, so this never nags.
#
# Adds context via hookSpecificOutput.additionalContext (PostToolUseFailure cannot
# block — the command already ran). Fails OPEN: a missing jq, no command, or no
# gate match exits 0 silently.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "gate-failure-hint" "PostToolUseFailure"

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[[ -z "$COMMAND" ]] && exit 0

lower=$(printf '%s' "$COMMAND" | tr '[:upper:]' '[:lower:]')
HINTS=()

case "$lower" in *validate:domain*)
  HINTS+=("domain structure → fix layout per CLAUDE.md › Domain Structure (be-domain-generator / be-structure-maintainer); details: pnpm validate:domain:strict") ;;
esac
case "$lower" in *routes:catalog*)
  HINTS+=("route catalog drift → pnpm routes:catalog to regenerate docs/routes.txt") ;;
esac
case "$lower" in *tsdoc:check*)
  HINTS+=("TSDoc coverage → add summary + @remarks on new exports; budget tooling/tsdoc-coverage/budget.json (be-tsdoc-export-guard); details: pnpm tsdoc:check:report") ;;
esac
case "$lower" in *db:migrate:lint*)
  HINTS+=("migration safety → align with be-db-migration-maintainer (IF NOT EXISTS, no blocking DDL)") ;;
esac
case "$lower" in *agent-os:check*)
  HINTS+=("agent-os drift → pnpm agent-os:check:report; fix dead path refs / counts / hook portability (be-structure-maintainer)") ;;
esac
case "$lower" in *docs:check*)
  HINTS+=("OpenAPI out of sync → pnpm docs:generate; ensure route schema blocks (be-route-schema-doc-guard)") ;;
esac
case "$lower" in *sync-env-example*)
  HINTS+=("env drift → pnpm tool:sync-env-example --fix; keep env-schema + .env.example in sync (be-env-schema-add)") ;;
esac
case "$lower" in *validate:route*)
  HINTS+=("route status policy → align declared vs observed statuses (be-api-contract-guard; docs/reference/api/response-codes.md)") ;;
esac
# Generic lint/format gate (`pnpm validate` / `pnpm lint`) — but NOT the validate:* subcommands above.
if printf '%s' "$lower" | grep -Eq '(pnpm|biome)[^:]*(lint|format)|validate([^:]|$)'; then
  HINTS+=("lint/format → pnpm lint:fix for autofixable; warnings via be-code-smells-and-best-practices / be-lint-warnings-handler")
fi
if printf '%s' "$lower" | grep -Eq 'typecheck|tsc --noemit'; then
  HINTS+=("type errors → pnpm typecheck for the full list")
fi

[[ "${#HINTS[@]}" -eq 0 ]] && exit 0

context="⚡ core-be gate failed — likely fix:"
for hint in "${HINTS[@]}"; do
  context="${context}"$'\n'"  • ${hint}"
done
context="${context}"$'\n'"Skill map: agent-os/docs/skill-triggers.md"

telemetry_fired
jq -cn --arg c "$context" \
  '{hookSpecificOutput:{hookEventName:"PostToolUseFailure",additionalContext:$c}}'
exit 0
