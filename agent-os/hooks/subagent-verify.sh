#!/usr/bin/env bash
# Claude Code SubagentStop hook for core-be.
#
# When a subagent finishes, remind the main agent that a subagent's final
# message is a REPORT, not proof: verify load-bearing claims (run the named
# gate, read the cited file) before acting on them, and remember that files a
# subagent edited route through the same skill-triggers map as your own edits.
#
# Deliberately NON-blocking (plain stdout, never decision:block) — the Stop
# family must not be able to loop the turn; enforcement stays with the
# PreToolUse guards and the CI gates. Fails OPEN: any error exits 0.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_telemetry.sh"
telemetry_init "subagent-verify" "SubagentStop"

telemetry_fired
cat <<'EOF'
Subagent finished — its output is a report, not proof. Before relying on it:
- verify load-bearing claims (run the gate it names, read the file it cites);
- if it edited files, those files route through agent-os/docs/skill-triggers.md like your own edits (run the listed skills/gates);
- prefer the be-verifier agent before declaring a task complete.
EOF
exit 0
