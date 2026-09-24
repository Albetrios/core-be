#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "skill-reminder" "PostToolUse"
# Claude Code PostToolUse hook.
# Reads Edit/Write tool JSON from stdin, extracts the edited file path,
# prints relevant skill reminders based on file pattern matching.

INPUT=$(cat)
FILE=$(echo "$INPUT" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" \
  2>/dev/null || echo "")

[[ -z "$FILE" ]] && exit 0

REMINDERS=()

[[ "$FILE" == *".routes.ts" ]] && \
  REMINDERS+=("routes → be-route-schema-doc-guard + be-route-catalog + be-seed-maintainer")

[[ "$FILE" == *".schema.ts" ]] && \
  REMINDERS+=("schema → be-schema-generator + be-sql-design-guard + be-db-migration-maintainer + be-rls-tenant-isolation-guard")

[[ "$FILE" == *"env-schema.ts"* || "$FILE" == *".env.example"* ]] && \
  REMINDERS+=("env → be-env-schema-add")

[[ "$FILE" == *"/locales/"*".json" ]] && \
  REMINDERS+=("i18n → be-i18n-message-guard")

[[ "$FILE" == *".validator.ts" || "$FILE" == *".serializer.ts" ]] && \
  REMINDERS+=("validator/serializer → be-test-generator")

[[ "$FILE" == *"/events/"*".ts" || "$FILE" == *"/workers/"*".ts" || \
   "$FILE" == *"/queues/"*".ts" ]] && \
  REMINDERS+=("events/workers/queues → be-workers-events skill")

[[ "$FILE" == *"/database/contexts/"*".ts" || "$FILE" == *".worker.ts" || "$FILE" == *".processor.ts" ]] && \
  REMINDERS+=("tenant data path → be-rls-tenant-isolation-guard (RLS + GUC + context wrappers)")

[[ "$FILE" == *"idempotency"* || "$FILE" == *"stripe.client.ts" ]] && \
  REMINDERS+=("idempotency / stripe writes → be-idempotency-guard")

[[ "$FILE" == *".container.ts" ]] && \
  REMINDERS+=("container → be-domain-generator (check DI wiring)")

if [[ "${#REMINDERS[@]}" -gt 0 ]]; then
  telemetry_fired
  echo ""
  echo "⚡ Skill reminders for $(basename "$FILE"):"
  for r in "${REMINDERS[@]}"; do
    echo "  • $r"
  done
  echo "  Full map: agent-os/docs/skill-triggers.md"
fi

exit 0
