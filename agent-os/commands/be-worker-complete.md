---
description: Complete an events / queues / workers change end-to-end (the worker-change chain)
argument-hint: (no arguments)
allowed-tools: Bash(pnpm test*), Bash(pnpm validate*)
---

Run the **worker-change** chain (`agent-os/skills/chains.json`), in order:

1. **be-workers-events** — event emission/handlers, BullMQ queues/jobs, worker processors, graceful shutdown and retries. Keep worker DB isolation: use context wrappers, never call `getRequestDatabase()` under `*.worker.ts` / `*.processor.ts` (importing DB-handle types / `setLocalDatabaseConfig` from `database-context-runtime` is fine); tenant jobs carry `organizationPublicId`.
2. **be-test-generator** — unit + integration coverage for the queue/worker.
3. **be-tsdoc-export-guard** — TSDoc summary + `@remarks` (Algorithm / Failure modes / Side effects) on new worker/processor exports.

Finish green: `pnpm validate` + `pnpm test:unit`. Report the queues/workers touched.
