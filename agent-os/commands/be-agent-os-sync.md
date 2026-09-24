---
description: Regenerate agent-os adapters from common and fix any drift
argument-hint: (no arguments)
allowed-tools: Bash(pnpm agent-os*)
---

Keep the agent-os bundle in sync after editing skills, agents, rules, hooks, or the registry:

1. Regenerate per-agent wiring from common: `pnpm agent-os:generate` (writes `.claude`/`.cursor` from `agent-os/hooks/hooks.json` + `agent-os/platforms/targets.json`).
2. Integrity gate: `pnpm agent-os:check` (counts, read-only agents, manifests, skill groups/chains, referenced paths).
3. Routing gate: `pnpm agent-os:triggers:strict`.
4. Drift gate: `pnpm agent-os:generate:check` — must report in-sync.

Fix anything the gates flag, then report what regenerated and the final gate status.
