#!/usr/bin/env bash
# Claude Code SessionStart hook for core-be.
#
# Two jobs:
#   1. (web) Make the env usable: verify Node, switch to a new-enough Node when
#      needed (pinned for the session via $CLAUDE_ENV_FILE), and install deps so
#      `pnpm validate` / tests / linters work.
#   2. Inject session context: the agent-os skill-trigger routing map plus a
#      short env/commands summary, as SessionStart additionalContext.
#
#   stderr -> install logs / diagnostics (NOT added to context)
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "session-start" "SessionStart"
telemetry_fired  # SessionStart always emits the session briefing

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" || exit 0

# --- Required Node major (from .nvmrc, fallback 24) --------------------------
required_major="24"
if [ -f .nvmrc ]; then
  parsed="$(tr -dc '0-9.' < .nvmrc | cut -d. -f1)"
  [ -n "$parsed" ] && required_major="$parsed"
fi
current_major="$(node -v 2>/dev/null | tr -dc '0-9.' | cut -d. -f1)"
[ -z "$current_major" ] && current_major="0"
node_ok="yes"; [ "$current_major" -lt "$required_major" ] 2>/dev/null && node_ok="no"

# --- If Node is too old, find a new-enough one and pin it for the session ----
if [ "$node_ok" = "no" ]; then
  for candidate in \
    "/opt/node${required_major}/bin" \
    /opt/node"${required_major}"*/bin \
    "${HOME}/.nvm/versions/node/v${required_major}"*/bin \
    /usr/local/node"${required_major}"*/bin; do
    [ -x "${candidate}/node" ] || continue
    cand_major="$("${candidate}/node" -v 2>/dev/null | tr -dc '0-9.' | cut -d. -f1)"
    if [ -n "$cand_major" ] && [ "$cand_major" -ge "$required_major" ] 2>/dev/null; then
      export PATH="${candidate}:${PATH}"
      [ -n "${CLAUDE_ENV_FILE:-}" ] && printf 'export PATH=%s:$PATH\n' "$candidate" >> "$CLAUDE_ENV_FILE"
      current_major="$cand_major"; node_ok="yes"
      echo "session-start: switched to $(node -v) at ${candidate} (persisted for the session)." >&2
      break
    fi
  done
fi

# --- Install deps on remote (web) sessions when Node is adequate -------------
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  if [ "$node_ok" = "no" ]; then
    echo "session-start: Node $(node -v 2>/dev/null) is below required v${required_major} (.nvmrc) — skipping pnpm install." >&2
  elif [ ! -x node_modules/.bin/biome ]; then
    echo "session-start: installing dependencies (pnpm install)…" >&2
    corepack enable >/dev/null 2>&1 || true
    pnpm install --prefer-offline >&2 || pnpm install >&2 || echo "session-start: pnpm install failed (see log above)." >&2
  else
    echo "session-start: dependencies already present — skipping install." >&2
  fi
fi

# --- Readiness check: agent-os integrity only (fast, no DB) ------------------
# The ONLY gate at startup. Heavy work (compose:up, db:migrate, db:seed, tests,
# pnpm dev) is intentionally left to run on demand per prompt — not bootstrapped
# here. Fail-open: never blocks the session; output goes to stderr (diagnostics).
agent_os_status="skipped"
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ -x node_modules/.bin/biome ]; then
  if pnpm agent-os:check >&2; then
    agent_os_status="passed"
  else
    agent_os_status="see: pnpm agent-os:check"
  fi
fi

# --- Best-effort: ensure the Docker daemon is up on remote (web) sessions ----
# DB / Redis / chaos work needs `docker compose`, but the cloud image ships
# dockerd without starting it. Start it best-effort so `compose:up` works when
# invoked on demand; never block or fail the session. No-op locally (Docker
# Desktop owns the daemon), when the daemon is already reachable, when dockerd is
# absent, or when passwordless sudo is unavailable. compose:up / migrations /
# seeds remain on-demand per prompt — only the daemon is started here.
docker_status="n/a"
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    docker_status="up"
  elif command -v dockerd >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo "session-start: Docker daemon down — starting dockerd (best-effort)…" >&2
    setsid sudo -n dockerd >/tmp/dockerd-session-start.log 2>&1 </dev/null & disown 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do docker info >/dev/null 2>&1 && break; sleep 1; done
    if docker info >/dev/null 2>&1; then docker_status="started"; else docker_status="start-failed (run: sudo dockerd)"; fi
  else
    docker_status="down (start manually: sudo dockerd)"
  fi
fi

# --- Self-heal: ensure gitleaks is present for the pre-commit secret scan ----
# The pre-commit guard's "Staged secrets scan" shells out to `gitleaks` and
# hard-errors when it is missing, so a web session cannot commit without it. The
# cached Setup script installs it (tooling/setup/agent/install-gitleaks.sh), but
# an older cached image can predate that wiring — install on demand when absent
# so commits never block. No-op when already present (the common case): just a
# `command -v`, so startup stays light. Best-effort and fail-open, like above.
gitleaks_status="absent"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks_status="present"
elif [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ -f tooling/setup/agent/install-gitleaks.sh ]; then
  echo "session-start: gitleaks missing — installing for the pre-commit secret scan (best-effort)…" >&2
  bash tooling/setup/agent/install-gitleaks.sh >&2 || true
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks_status="installed"
  else
    gitleaks_status="install-failed (run: bash tooling/setup/agent/install-gitleaks.sh)"
  fi
fi

# --- MCP config: declare the default server pair before the first prompt ------
# Claude Code reads `.mcp.json` at startup (a tracked symlink → the gitignored
# agent-os/mcp/mcp.json, shared with .cursor/mcp.json). On local sessions, scaffold
# the canonical target from the committed `.mcp.default.json` (the default auto-start
# pair — codegraph + headroom, zero-config, no token) when it is absent, mirroring how
# setup:local does. Write the target directly — GNU cp refuses to write through a
# dangling symlink, so `cp … .mcp.json` would fail on a fresh Linux clone. The other
# hosted servers (in `.mcp.example.json`) are opt-in via `pnpm mcp:setup` (most need a
# provider token). Web sessions load MCP from the platform environment settings (web
# UI), NOT this file, so we only report there. Best-effort and fail-open.
mcp_status="n/a"
if [ -f .mcp.json ]; then
  if command -v jq >/dev/null 2>&1; then
    mcp_status="$(jq -r '.mcpServers | keys | length' .mcp.json 2>/dev/null || echo '?') declared"
  else
    mcp_status="declared"
  fi
elif [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ -f .mcp.default.json ]; then
  if cp .mcp.default.json agent-os/mcp/mcp.json 2>/dev/null; then
    mcp_status="scaffolded default pair (codegraph + headroom)"
    echo "session-start: scaffolded .mcp.json from .mcp.default.json (codegraph + headroom); add the rest with \`pnpm mcp:setup\`." >&2
  else
    mcp_status="template only (run: pnpm mcp:setup:default)"
  fi
else
  mcp_status="platform-managed on web (configure in the environment MCP settings); local: pnpm mcp:setup"
fi

# --- Hook-health: surface pruning candidates from telemetry ------------------
# The README's "monthly ritual" (prune hooks silent 30+ days) previously relied
# on someone remembering to run `pnpm agent-os:hooks:report`. Enforce it
# passively instead: at session start, name any hook with recorded runs whose
# last `fired` entry is >30 days old (or that has NEVER fired across 50+ runs).
# Best-effort + fail-open; empty when telemetry is absent (fresh clone).
hook_health=""
telemetry_log="$ROOT/agent-os/hooks/.telemetry.log"
if [ -f "$telemetry_log" ]; then
  # ISO-8601 timestamps sort lexicographically, so "last fired before the
  # 30-day cutoff" is a plain string compare — portable across BSD/GNU awk.
  cutoff="$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
  hook_health="$(awk -F, -v cutoff="$cutoff" '
    NF >= 4 {
      runs[$2]++
      if ($4 == "fired" && $1 > lastFired[$2]) lastFired[$2] = $1
    }
    END {
      for (hook in runs) {
        if (lastFired[hook] == "" && runs[hook] >= 50) printf "%s (never fired, %d runs) ", hook, runs[hook]
        else if (cutoff != "" && lastFired[hook] != "" && lastFired[hook] < cutoff) printf "%s (silent >30d) ", hook
      }
    }' "$telemetry_log" 2>/dev/null || echo "")"
fi
[ -n "$hook_health" ] && hook_health="
- Hook pruning candidates (silent 30+ days / never fired): ${hook_health}— review with \`pnpm agent-os:hooks:report\` (agent-os/hooks/README.md)"

# --- Build session context: skill routing map + env/commands summary --------
node_version="$(node -v 2>/dev/null || echo unknown)"
deps="missing"; [ -x node_modules/.bin/biome ] && deps="installed"
codegraph="absent"; [ -f .codegraph/codegraph.db ] && codegraph="present"
gh_cli="absent"; command -v gh >/dev/null 2>&1 && gh_cli="$(gh --version 2>/dev/null | head -1 | awk '{print $3}')"
[ -n "$gh_cli" ] || gh_cli="absent"
# "provisioned" = the cached toolchain the Setup script builds (Node >=required + installed deps) is live in this session.
provisioned="no"; { [ "$node_ok" = "yes" ] && [ "$deps" = "installed" ]; } && provisioned="yes"
node_note=""; [ "$node_ok" = "no" ] && node_note="  (switch to Node >=${required_major} from .nvmrc, then pnpm install)"

map_file="$ROOT/agent-os/docs/skill-triggers.md"
map_section=""
[ -f "$map_file" ] && map_section="$(cat "$map_file")"

context="$(printf 'core-be session ready — environment provisioned: %s.\n- Node %s (need >=%s) · deps %s · gh %s · codegraph %s · mcp %s · gitleaks %s · agent-os %s · docker %s%s%s\n- Startup is light: Node + deps + agent-os:check + (web) Docker daemon — run compose:up / db:migrate / db:seed / tests on demand per prompt.\n- Gates: pnpm validate · pnpm ci:local   (pre-commit: pnpm guard:pre-commit)\n- Custom commands: /be-validate · /be-ci-local · /be-new-domain · /be-routes-sync\n\nagent-os skill routing — consult be-skill-index FIRST, then run the listed skill(s) for the files you change:\n\n%s' \
  "$provisioned" "$node_version" "$required_major" "$deps" "$gh_cli" "$codegraph" "$mcp_status" "$gitleaks_status" "$agent_os_status" "$docker_status" "$node_note" "$hook_health" "$map_section")"

# Prefer the structured additionalContext envelope; fall back to plain stdout
# (also injected as context) when jq is unavailable. Fail-open either way.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg c "$context" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
else
  printf '%s\n' "$context"
fi
