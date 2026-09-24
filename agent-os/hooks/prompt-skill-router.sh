#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook for core-be.
#
# When a prompt describes a build/change task, inject the relevant skill chain —
# plus the "consult be-skill-index FIRST" rule and the requirement-intake checklist —
# as additionalContext. This operationalizes CLAUDE.md's skill-first workflow at
# PROMPT time; the PostToolUse skill-reminder ([`skill-reminder.sh`](skill-reminder.sh))
# only fires reactively, AFTER an edit. The keyword→skill map mirrors
# [`agent-os/docs/skill-triggers.md`](../docs/skill-triggers.md).
#
# Conservative by design: requires a build/change verb AND a domain noun, so
# ordinary prompts (questions, "run the tests", "explain this") produce nothing
# and never nag. Adds context via hookSpecificOutput.additionalContext. Fails
# OPEN: a missing jq, no prompt, or no match exits 0 silently.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "prompt-skill-router" "UserPromptSubmit"

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null || echo "")
[[ -z "$PROMPT" ]] && exit 0

lower=$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]')

# Gate on a build/change intent verb to avoid nagging on questions / read-only asks.
printf '%s' "$lower" \
  | grep -Eq '\b(add|create|new|implement|build|introduce|scaffold|generate|wire|register|expose|rename)\b' \
  || exit 0

HINTS=()

printf '%s' "$lower" | grep -Eq '\b(route|routes|endpoint|endpoints)\b' && \
  HINTS+=("route/endpoint → be-api-contract-guard → be-route-schema-doc-guard → be-route-catalog → be-seed-maintainer")

printf '%s' "$lower" | grep -Eq '\b(domain|sub-domain|subdomain)\b' && \
  HINTS+=("domain/sub-domain → be-domain-generator (start at docs/getting-started/requirement-intake.md)")

printf '%s' "$lower" | grep -Eq '\b(schema|table|tables|column|columns|migration|migrations)\b' && \
  HINTS+=("schema/table/migration → be-schema-generator → be-sql-design-guard → be-db-migration-maintainer → be-rls-tenant-isolation-guard")

printf '%s' "$lower" | grep -Eq '\b(worker|workers|queue|queues|job|jobs|bullmq)\b|event handler' && \
  HINTS+=("worker/queue/event → be-workers-events")

printf '%s' "$lower" | grep -Eq 'env var|environment variable|env-schema|\.env\b' && \
  HINTS+=("env var → be-env-schema-add")

printf '%s' "$lower" | grep -Eq '\b(i18n|translation|translations|locale|locales)\b' && \
  HINTS+=("i18n/locale → be-i18n-message-guard")

printf '%s' "$lower" | grep -Eq '\b(validator|serializer|serialiser)\b' && \
  HINTS+=("validator/serializer → be-test-generator")

printf '%s' "$lower" | grep -Eq '\b(seed|seeds|seeder|seeding)\b' && \
  HINTS+=("seed → be-seed-maintainer")

[[ "${#HINTS[@]}" -eq 0 ]] && exit 0

context="🧭 core-be skill routing — consult agent-os/skills/be-skill-index/SKILL.md FIRST, then run:"
for h in "${HINTS[@]}"; do
  context="${context}"$'\n'"  • ${h}"
done
context="${context}"$'\n'"New requirement? docs/getting-started/requirement-intake.md · Full map: agent-os/docs/skill-triggers.md"

telemetry_fired
jq -cn --arg c "$context" \
  '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$c}}'
exit 0
