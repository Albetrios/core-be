#!/usr/bin/env node
// Cursor `beforeShellExecution` guardrail for core-be (Cursor agent hooks, beta).
//
// Blocks the same destructive shell commands as the Claude PreToolUse guardrail.
// Companions: cursor-read-guard.mjs (beforeReadFile secrets block),
// cursor-mcp-guard.mjs (beforeMCPExecution), cursor-edit-guard.mjs (afterFileEdit,
// advisory — Cursor cannot veto writes pre-flight; hard policy stays in
// .cursor/rules/be-ai-guardrails.mdc).
//
// Reads the hook payload on stdin; prints { "permission": "allow" | "deny", ... }.
import { readFileSync } from "node:fs";
import { recordTelemetry } from "./_telemetry.mjs";

function allow() {
  recordTelemetry("cursor-shell-guard", "beforeShellExecution", "silent");
  process.stdout.write(JSON.stringify({ continue: true, permission: "allow" }));
  process.exit(0);
}
function deny(message) {
  recordTelemetry("cursor-shell-guard", "beforeShellExecution", "fired");
  process.stdout.write(JSON.stringify({ continue: true, permission: "deny", userMessage: message, agentMessage: message }));
  process.exit(0);
}

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  allow();
}

let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  allow();
}

const command = payload.command || (payload.tool_input && payload.tool_input.command) || payload.shellCommand || "";
if (!command) allow();

// Scan with quoted strings + heredoc bodies removed, so destructive patterns
// that merely appear in a message/echo don't trigger a false block.
const scan = command
  .replace(/<<-?\s*['"]?[A-Za-z_]\w*['"]?[\s\S]*$/, " ")
  .replace(/'[^']*'/g, " ")
  .replace(/"[^"]*"/g, " ");
let why = "";
if (/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i.test(scan)) {
  why = "recursive force delete (rm -rf)";
} else if (
  /\bgit\s+push\b/i.test(scan) &&
  (/--force(?!-with-lease)/i.test(scan) || /\s-f(?:\s|$)/.test(scan))
) {
  why = "git push --force";
} else if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(scan)) {
  why = "fork bomb";
} else if (/\bmkfs\b|\bdd\s+if=/i.test(scan)) {
  why = "filesystem-destroying command";
}

if (why) {
  deny(`core-be guardrail blocked a ${why}: "${command.slice(0, 160)}". Run it yourself in a terminal if you truly intend this.`);
}
allow();
