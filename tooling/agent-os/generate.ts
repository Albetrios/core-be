#!/usr/bin/env tsx
/**
 * agent-os generator — compiles each agent's native wiring FROM the common
 * agent-os/ sources, and (in --check mode) fails when a hand-edited artifact
 * has drifted from that single source.
 *
 * Single source: agent-os/hooks/hooks.json (hook wiring) + agent-os/platforms/
 * targets.json (capability registry). Derived artifacts (all under agent-os/
 * platforms/, symlinked from the app dirs): the `hooks` block of
 * claude/settings.json (.claude/settings.json symlinks to it), the `hooks`
 * block of cursor/hooks.json (.cursor/hooks.json), codex/hooks.json
 * (.codex/hooks.json), and the default Codex MCP config. Everything else in those
 * files (Claude `permissions`, Cursor `$schema`/`version`) is owned by hand and
 * preserved verbatim. --check compares semantically (parsed,
 * key-order-independent) so the existing hand-formatted files pass unchanged.
 *
 * Usage:
 *   tsx tooling/agent-os/generate.ts            # default: --check (drift gate)
 *   tsx tooling/agent-os/generate.ts --check    # compare generated vs on-disk; exit 1 on drift
 *   tsx tooling/agent-os/generate.ts --write     # write the derived artifacts from source
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateDocs } from './generate-docs.js';

const repositoryRoot = process.cwd();
const agentOsDirectory = join(repositoryRoot, 'agent-os');
const writeMode = process.argv.includes('--write');

interface HookManifestEntry {
  id: string;
  runtime: 'bash' | 'node';
  script: string;
  claude?: { event: string; matcher?: string };
  cursor?: { event: string; matcher?: string };
  codex?: { event: string; matcher?: string; statusMessage?: string };
}
interface HookManifest {
  hooks: HookManifestEntry[];
}
interface AgentTarget {
  capabilities: { hookEvents: string[]; mcpFormat?: string };
  hooksTarget: string | null;
}
interface TargetsRegistry {
  agents: Record<string, AgentTarget>;
}

const readJson = <T>(absolutePath: string): T =>
  JSON.parse(readFileSync(absolutePath, 'utf8')) as T;

const problems: string[] = [];
const report = (message: string) => problems.push(message);

const manifest = readJson<HookManifest>(join(agentOsDirectory, 'hooks', 'hooks.json'));
const targets = readJson<TargetsRegistry>(join(agentOsDirectory, 'platforms', 'targets.json'));

const claudeTarget = targets.agents.claude;
const cursorTarget = targets.agents.cursor;
const codexTarget = targets.agents.codex;

/** Claude command form: `<runtime> "$CLAUDE_PROJECT_DIR/agent-os/hooks/<script>"`. */
const claudeCommand = (entry: HookManifestEntry): string =>
  `${entry.runtime} "$CLAUDE_PROJECT_DIR/agent-os/hooks/${entry.script}"`;
/** Cursor command form, relative to .cursor/: `<runtime> ../agent-os/hooks/<script>`. */
const cursorCommand = (entry: HookManifestEntry): string =>
  `${entry.runtime} ../agent-os/hooks/${entry.script}`;
/** Codex command form: resolve from git root because Codex may start in a subdirectory. */
const codexCommand = (entry: HookManifestEntry): string =>
  `CLAUDE_PROJECT_DIR="$(git rev-parse --show-toplevel)" ${entry.runtime} "$(git rev-parse --show-toplevel)/agent-os/hooks/${entry.script}"`;

type ClaudeHookEntry = {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string }>;
};
type CodexHookEntry = {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; statusMessage?: string }>;
};

/** Build the Claude `hooks` block, grouped by event in first-appearance order. */
function buildClaudeHooks(): Record<string, ClaudeHookEntry[]> {
  const supported = new Set(claudeTarget?.capabilities.hookEvents ?? []);
  const grouped: Record<string, ClaudeHookEntry[]> = {};
  for (const entry of manifest.hooks) {
    if (!entry.claude) continue;
    if (!supported.has(entry.claude.event)) {
      report(
        `claude: hook "${entry.id}" targets unsupported event ${entry.claude.event} — skipped`,
      );
      continue;
    }
    const command = claudeCommand(entry);
    const hookEntry: ClaudeHookEntry = entry.claude.matcher
      ? { matcher: entry.claude.matcher, hooks: [{ type: 'command', command }] }
      : { hooks: [{ type: 'command', command }] };
    const event = entry.claude.event;
    const bucket = grouped[event] ?? [];
    bucket.push(hookEntry);
    grouped[event] = bucket;
  }
  return grouped;
}

/** Build the Cursor `hooks` block, grouped by event. */
function buildCursorHooks(): Record<string, Array<{ command: string }>> {
  const supported = new Set(cursorTarget?.capabilities.hookEvents ?? []);
  const grouped: Record<string, Array<{ command: string }>> = {};
  for (const entry of manifest.hooks) {
    if (!entry.cursor) continue;
    if (!supported.has(entry.cursor.event)) {
      report(
        `cursor: hook "${entry.id}" targets unsupported event ${entry.cursor.event} — skipped`,
      );
      continue;
    }
    const event = entry.cursor.event;
    const bucket = grouped[event] ?? [];
    bucket.push({ command: cursorCommand(entry) });
    grouped[event] = bucket;
  }
  return grouped;
}

/** Build project-local Codex hooks.json from compatible common hook entries. */
function buildCodexHooks(): Record<string, CodexHookEntry[]> {
  const supported = new Set(codexTarget?.capabilities.hookEvents ?? []);
  const grouped: Record<string, CodexHookEntry[]> = {};
  for (const entry of manifest.hooks) {
    if (!entry.codex) continue;
    if (!supported.has(entry.codex.event)) {
      report(`codex: hook "${entry.id}" targets unsupported event ${entry.codex.event} — skipped`);
      continue;
    }
    const hook: { type: 'command'; command: string; statusMessage?: string } = {
      type: 'command',
      command: codexCommand(entry),
    };
    if (entry.codex.statusMessage) hook.statusMessage = entry.codex.statusMessage;
    const hookEntry: CodexHookEntry = entry.codex.matcher
      ? { matcher: entry.codex.matcher, hooks: [hook] }
      : { hooks: [hook] };
    const event = entry.codex.event;
    const bucket = grouped[event] ?? [];
    bucket.push(hookEntry);
    grouped[event] = bucket;
  }
  return grouped;
}

/** Recursively sort object keys so comparison ignores key order (arrays stay ordered). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      sorted[key] = canonical((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}
const deepEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Emit the canonical MCP servers as a Codex config.toml `[mcp_servers.*]` block. */
function toCodexToml(servers: Record<string, { command?: string; args?: string[] }>): string {
  const lines = [
    '# Generated by tooling/agent-os/generate.ts from agent-os/mcp/mcp.default.json — do not edit by hand.',
    '',
  ];
  for (const [name, definition] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    if (definition.command) lines.push(`command = ${JSON.stringify(definition.command)}`);
    if (definition.args?.length)
      lines.push(
        `args = [${definition.args.map((argument) => JSON.stringify(argument)).join(', ')}]`,
      );
    lines.push('');
  }
  return lines.join('\n');
}

const claudeHooks = buildClaudeHooks();
const cursorHooks = buildCursorHooks();
const codexHooks = buildCodexHooks();

// ── Claude settings (hooks block only; permissions preserved) ──
// hooksTarget is agent-os/platforms/claude/settings.json — the canonical file
// that .claude/settings.json symlinks to (so config lives under agent-os/, the
// single source of truth). settings.local.json stays a real, gitignored file.
const claudeSettingsTarget = claudeTarget?.hooksTarget ?? 'agent-os/platforms/claude/settings.json';
const claudeSettingsPath = join(repositoryRoot, claudeSettingsTarget);
if (existsSync(claudeSettingsPath)) {
  const settings = readJson<Record<string, unknown>>(claudeSettingsPath);
  if (writeMode) {
    // Idempotent: only write when the hooks actually differ, so an unchanged
    // file is never reformatted (do-no-harm).
    if (!deepEqual(settings.hooks, claudeHooks)) {
      settings.hooks = claudeHooks;
      writeFileSync(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
      report(`wrote ${claudeSettingsTarget}`);
    }
  } else if (!deepEqual(settings.hooks, claudeHooks)) {
    report(
      `drift: ${claudeSettingsTarget} hooks differ from agent-os/hooks/hooks.json — run \`pnpm agent-os:generate --write\``,
    );
  }
} else report(`missing: ${claudeSettingsPath}`);

// ── Cursor: platforms/cursor/hooks.json, symlinked from .cursor/hooks.json ──
// (hooks block only; $schema/version preserved)
const cursorHooksTarget = cursorTarget?.hooksTarget ?? 'agent-os/platforms/cursor/hooks.json';
const cursorHooksPath = join(repositoryRoot, cursorHooksTarget);
if (existsSync(cursorHooksPath)) {
  const cursorConfig = readJson<Record<string, unknown>>(cursorHooksPath);
  if (writeMode) {
    // Idempotent: skip the write when content matches, preserving the existing
    // hand-formatted file instead of canonicalising it.
    if (!deepEqual(cursorConfig.hooks, cursorHooks)) {
      cursorConfig.hooks = cursorHooks;
      writeFileSync(cursorHooksPath, `${JSON.stringify(cursorConfig, null, 2)}\n`);
      report(`wrote ${cursorHooksTarget}`);
    }
  } else if (!deepEqual(cursorConfig.hooks, cursorHooks)) {
    report(
      `drift: ${cursorHooksTarget} hooks differ from agent-os/hooks/hooks.json — run \`pnpm agent-os:generate --write\``,
    );
  }
} else report(`missing: ${cursorHooksPath}`);

// ── Codex: platforms/codex/hooks.json, symlinked from .codex/hooks.json ──
// (generated from common compatible hook entries)
const codexHooksTarget = codexTarget?.hooksTarget ?? 'agent-os/platforms/codex/hooks.json';
const codexHooksPath = join(repositoryRoot, codexHooksTarget);
const codexHooksFile = { hooks: codexHooks };
if (writeMode) {
  const current = existsSync(codexHooksPath)
    ? readJson<Record<string, unknown>>(codexHooksPath)
    : null;
  if (!deepEqual(current, codexHooksFile)) {
    mkdirSync(dirname(codexHooksPath), { recursive: true });
    writeFileSync(codexHooksPath, `${JSON.stringify(codexHooksFile, null, 2)}\n`);
    report(`wrote ${codexHooksTarget}`);
  }
} else if (!existsSync(codexHooksPath)) {
  report(`missing: ${codexHooksPath}`);
} else {
  const current = readJson<Record<string, unknown>>(codexHooksPath);
  if (!deepEqual(current, codexHooksFile)) {
    report(
      `drift: ${codexHooksTarget} differs from agent-os/hooks/hooks.json — run \`pnpm agent-os:generate --write\``,
    );
  }
}

// ── Codex: agent-os/platforms/codex/config.toml (MCP servers as TOML, generated) ──
if (codexTarget?.capabilities.mcpFormat === 'toml') {
  const mcpDefaultPath = join(agentOsDirectory, 'mcp', 'mcp.default.json');
  const codexConfigPath = join(agentOsDirectory, 'platforms', 'codex', 'config.toml');
  if (existsSync(mcpDefaultPath)) {
    const servers =
      readJson<{
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      }>(mcpDefaultPath).mcpServers ?? {};
    const toml = toCodexToml(servers);
    const current = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, 'utf8') : null;
    if (writeMode) {
      if (current !== toml) {
        mkdirSync(dirname(codexConfigPath), { recursive: true });
        writeFileSync(codexConfigPath, toml);
        report('wrote agent-os/platforms/codex/config.toml');
      }
    } else if (current !== toml) {
      report(
        'drift: agent-os/platforms/codex/config.toml differs from agent-os/mcp/mcp.default.json — run `pnpm agent-os:generate --write`',
      );
    }
  }
}

// ── Derived docs (be-skill-index table, agents-catalog, skill-triggers) ──
// Regenerated from manifests + skill/agent frontmatter between GENERATED markers;
// hand-written prose outside the markers survives verbatim.
for (const message of generateDocs(writeMode)) report(message);

// ── Report ──
const drift = problems.filter(
  (message) => message.startsWith('drift') || message.startsWith('missing'),
);
console.log(`\nagent-os generate (${writeMode ? 'write' : 'check'})\n`);
console.log(`  agents: ${Object.keys(targets.agents).join(', ')}`);
console.log(
  `  claude hooks: ${Object.values(claudeHooks).flat().length}   cursor hooks: ${Object.values(cursorHooks).flat().length}   codex hooks: ${Object.values(codexHooks).flat().length}\n`,
);
for (const message of problems) console.log(`  • ${message}`);
console.log('');
if (!writeMode && drift.length) {
  console.log(`✗ DRIFT — ${drift.length} derived artifact(s) out of sync with agent-os/ source\n`);
  process.exit(1);
}
console.log(`✓ ${writeMode ? 'wrote derived artifacts' : 'in sync — no drift'}\n`);
