#!/usr/bin/env bash
# Phased local health orchestrator.
#
# Unlike `pnpm ci:local` (a fail-fast `&&` chain that stops at the first red),
# this runs EVERY phase, CONTINUES through failures, and prints a single PASS/FAIL
# table at the end — so one run shows you every problem, not just the first.
#
#   pnpm health        # run all phases read-only
#   pnpm health:fix    # auto-repair the fixable surface (lint + format) first
#
# It complements, and does not replace, the merge gates: `pnpm ci:local` is the
# authoritative pre-PR gate; this is the developer-loop diagnostic. DB-bound e2e /
# integration tests are intentionally excluded (they need Postgres + Redis); run
# `pnpm test` for those.
set -uo pipefail

cd "$(dirname "$0")/../.."

FIX=0
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    *)
      echo "unknown argument: $arg (supported: --fix)" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  GREEN=$(tput setaf 2); RED=$(tput setaf 1); BOLD=$(tput bold); RESET=$(tput sgr0)
else
  GREEN=""; RED=""; BOLD=""; RESET=""
fi

FAILS=0
SUMMARY=""

# phase "<label>" <script-name> — runs `pnpm -s <script-name>`, never aborts.
phase() {
  label="$1"
  shift
  printf '%s▶ %s%s\n' "$BOLD" "$label" "$RESET"
  if pnpm -s "$@"; then
    SUMMARY="${SUMMARY}${GREEN}PASS${RESET}  ${label}\n"
  else
    SUMMARY="${SUMMARY}${RED}FAIL${RESET}  ${label}\n"
    FAILS=$((FAILS + 1))
  fi
}

if [ "$FIX" -eq 1 ]; then
  echo "── auto-fix pass (lint + format) ──"
  pnpm -s lint:fix || true
  pnpm -s format || true
  echo ""
fi

echo "── health check ──"
phase "Format check"             format:check
phase "Lint (Biome)"             lint
phase "Typecheck"                typecheck
phase "Domain structure"         validate:domain:strict
phase "Scripts layout"           validate:scripts-layout
phase "Constants centralization" validate:constants
phase "Route catalog drift"      routes:catalog:check
phase "Route HTTP coverage"      validate:route-http-coverage
phase "Route success statuses"   validate:route-success-statuses
phase "Route schema docs"        validate:route-schema-docs
phase "Route param schemas"      validate:route-param-schemas
phase "Route organization scope"          validate:route-organization-scope
phase "Test naming"              validate:test-naming
phase "TSDoc coverage"           tsdoc:check
phase "Env example sync"         tool:sync-env-example
phase "Structure tree drift"     tool:project-structure-tree:check
phase "Migration lint"           db:migrate:lint
phase "OpenAPI / Postman sync"   docs:check
phase "Docs links + cited paths" docs:links:check
phase "Knip (dead code)"         knip
phase "agent-os integrity"       agent-os:check
phase "agent-os triggers"        agent-os:triggers:strict
phase "agent-os generate drift"  agent-os:generate:check
phase "agent-os skills lock"     agent-os:lock:check
phase "Fast tests (unit+property+global)" test:fast
phase "Build"                    build
phase "Build alias check"        build:check

echo ""
echo "${BOLD}Health summary${RESET}"
printf "%b" "$SUMMARY"
if [ "$FAILS" -gt 0 ]; then
  echo "${RED}✗ ${FAILS} phase(s) failed.${RESET}"
  exit 1
fi
echo "${GREEN}✓ all phases passed.${RESET}"
