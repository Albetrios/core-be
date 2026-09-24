#!/usr/bin/env node
// Cursor `afterFileEdit` guardrail for core-be (Cursor agent hooks, beta).
//
// Cursor cannot veto a file edit before it lands, so this is the after-the-fact
// mirror of the Claude `guard-edits.sh` PreToolUse rules: when an edit that just
// landed violates a hard rule (R1 worker getRequestDatabase, R2 `../` import
// under src/, R3 generated file, R4 removed NODE_ENV value, R5 enforcement
// wiring), it tells the agent to revert/fix NOW instead of at pre-commit/CI.
//
// Reads the hook payload on stdin; prints { agentMessage } when a rule is hit
// (advisory — Cursor applies no permission semantics to afterFileEdit).
// Fail-open: any error exits 0 silently.
import { readFileSync } from "node:fs";
import { recordTelemetry } from "./_telemetry.mjs";

function done(status, message) {
  recordTelemetry("cursor-edit-guard", "afterFileEdit", status);
  if (message) process.stdout.write(JSON.stringify({ agentMessage: message }));
  process.exit(0);
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  done("silent");
}

const filePath =
  payload.file_path || payload.filePath || (payload.tool_input && payload.tool_input.file_path) || "";
if (!filePath) done("silent");

const edits = Array.isArray(payload.edits) ? payload.edits : [];
const content = [
  payload.content,
  payload.new_string,
  ...edits.map((edit) => edit && (edit.new_string || edit.newText || edit.text)),
]
  .filter(Boolean)
  .join("\n");

const violations = [];

// R3 — generated / do-not-edit files.
if (
  /(pnpm-lock\.yaml|docs\/routes\.txt|docs\/openapi\/openapi[^/]*\.json|docs\/postman-collection\.json|project-identity\.constants\.ts|docs\/database\/core-be\.dbml|\.codex\/hooks\.json)$/.test(
    filePath,
  )
) {
  violations.push(
    "this file is GENERATED — revert the hand-edit, change the source, and run the generator (agent-os/docs/skill-triggers.md).",
  );
}

// R5 — enforcement wiring (hook manifest / platform hook configs / guard scripts).
if (
  /(agent-os\/hooks\/hooks\.json|agent-os\/platforms\/targets\.json|agent-os\/platforms\/claude\/settings\.json|\.claude\/settings(\.local)?\.json|\.cursor\/hooks\.json|agent-os\/hooks\/(guard-edits\.sh|guardrails\.mjs|cursor-shell-guard\.mjs|cursor-edit-guard\.mjs|cursor-read-guard\.mjs|cursor-mcp-guard\.mjs|injection-scan\.mjs))$/.test(
    filePath,
  )
) {
  violations.push(
    "this file is part of the agent-guard enforcement wiring — do not weaken or disable hooks without explicit user approval (agent-os/hooks/README.md).",
  );
}

// R1 — workers/processors must not call getRequestDatabase().
if (/\.(worker|processor)\.ts$/.test(filePath) && /getRequestDatabase/.test(content)) {
  violations.push(
    "workers/processors must not call getRequestDatabase() (RLS) — bind a handle via a context wrapper (withOrganizationContext / runOrganizationScopedWorkerJob).",
  );
}

// R2 — no `../` parent-relative imports under src/.
if (
  /(^|\/)src\/.*\.tsx?$/.test(filePath) &&
  /(from|require|import)\s*\(?\s*['"]\.\.\//.test(content)
) {
  violations.push("relative parent import ('../') is banned under src/ — use the '@/' alias (be-import-paths.mdc).");
}

// R4 — NODE_ENV set/compared to a REMOVED value (test|staging; docs are exempt). `local` is a valid
// runtime (the developer's machine, primary file `.env.local`) so it is NOT blocked.
if (
  !/\.(md|mdc|txt)$/.test(filePath) &&
  /NODE_ENV\s*[:=]+\s*['"`]?(test|staging)\b/i.test(content)
) {
  violations.push(
    "NODE_ENV must never be 'test' or 'staging' (the enum is 'local' | 'development' | 'production') — use an explicit env flag with a static default instead (be-env-schema-add skill).",
  );
}

if (violations.length) {
  done(
    "fired",
    `core-be guard (afterFileEdit) — the edit to "${filePath}" violates a hard rule; fix it NOW, before pre-commit/CI:\n- ${violations.join("\n- ")}`,
  );
}
done("silent");
