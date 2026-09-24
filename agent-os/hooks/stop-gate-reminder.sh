#!/usr/bin/env bash
# Claude Code Stop hook for core-be.
#
# At end of turn, look at the uncommitted working-tree changes and surface the
# SPECIFIC gate(s) those files imply — reusing the same file→skill map as
# [`skill-reminder.sh`](skill-reminder.sh) / [`gate-failure-hint.sh`](gate-failure-hint.sh)
# and [`agent-os/docs/skill-triggers.md`](../docs/skill-triggers.md). This turns the
# old static end-of-turn echo into a targeted, proactive checklist so a required
# gate (migration lint, route catalog, RLS, env sync) is not forgotten before
# commit/handoff. When nothing relevant changed (or the tree is clean — gates
# already ran at commit), it falls back to the generic quick-checks reminder.
#
# Plain stdout, NON-blocking (never returns decision:block, so it cannot loop the
# turn). Fails OPEN: any error exits 0.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "stop-gate-reminder" "Stop"

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" 2>/dev/null || exit 0

# Uncommitted (staged + unstaged + untracked) paths, status prefix stripped.
changed="$(git status --porcelain 2>/dev/null | sed 's/^...//')" || changed=""

REMINDERS=()
match() { printf '%s\n' "$changed" | grep -Eq "$1"; }

match '\.routes\.ts$' && \
  REMINDERS+=("routes changed → pnpm routes:catalog:check + be-route-schema-doc-guard (be-api-contract-guard)")
match '\.schema\.ts$' && \
  REMINDERS+=("schema changed → be-db-migration-maintainer + pnpm db:migrate:lint + be-rls-tenant-isolation-guard")
match 'migrations/.*\.sql$' && \
  REMINDERS+=("migration SQL → pnpm db:migrate:lint (be-db-migration-maintainer)")
match 'env-schema\.ts$|\.env\.example$' && \
  REMINDERS+=("env changed → pnpm tool:sync-env-example (be-env-schema-add)")
match '/locales/.*\.json$' && \
  REMINDERS+=("i18n changed → be-i18n-message-guard")
match '\.(validator|serializer)\.ts$' && \
  REMINDERS+=("validator/serializer → be-test-generator (add/refresh tests)")
match '/(events|workers|queues)/.*\.ts$' && \
  REMINDERS+=("events/workers/queues → be-workers-events")
match '\.worker\.ts$|/database/contexts/' && \
  REMINDERS+=("tenant data path → be-rls-tenant-isolation-guard (RLS + GUC + context wrappers)")
match 'idempotency|stripe\.client\.ts$' && \
  REMINDERS+=("idempotency/stripe writes → be-idempotency-guard")
match '\.mdc$|^agent-os/|agent-os/|CLAUDE\.md$' && \
  REMINDERS+=("agent-os, rules or docs changed → pnpm agent-os:check (be-structure-maintainer)")

echo ""
if [[ "${#REMINDERS[@]}" -gt 0 ]]; then
  telemetry_fired
  echo "📋 Before you finish — gates implied by your uncommitted changes:"
  for r in "${REMINDERS[@]}"; do
    echo "  • $r"
  done
  echo "  Then: pnpm validate (lint + format + typecheck). Full map: agent-os/docs/skill-triggers.md"
else
  echo "📋 Done. Quick checks: pnpm validate:domain --strict && pnpm tsdoc:check"
  echo "   Skill map: agent-os/docs/skill-triggers.md"
fi
exit 0
