#!/usr/bin/env tsx
/**
 * agent-os doc generator — regenerates the three hand-maintained derivative docs
 * from their single sources so drift is impossible, not merely detected:
 *
 *   - the `Project skills (N)` table in agent-os/skills/be-skill-index/SKILL.md
 *       ← skill directories on disk + groups.json order + per-skill `indexNote`
 *   - agent-os/docs/agents-catalog.md
 *       ← agents/*.md frontmatter (name/description/model/wrapsSkill/useWhen)
 *         + agents/pipelines.json membership
 *   - the trigger table in agent-os/docs/skill-triggers.md
 *       ← skills/chains.json triggers (multi-skill rows) + per-skill `trigger`
 *
 * Only the region between `<!-- GENERATED:START -->` and `<!-- GENERATED:END -->`
 * markers is rewritten; hand-written prose outside the markers survives verbatim.
 *
 * Invoked by tooling/agent-os/generate.ts (so `pnpm agent-os:generate` /
 * `:generate:check` cover these docs alongside the hook/mcp derivations).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const repositoryRoot = process.cwd();
const agentOsDirectory = join(repositoryRoot, 'agent-os');

export const GENERATED_START = '<!-- GENERATED:START -->';
export const GENERATED_END = '<!-- GENERATED:END -->';

const readText = (absolutePath: string): string => readFileSync(absolutePath, 'utf8');
const readJson = <T>(absolutePath: string): T => JSON.parse(readText(absolutePath)) as T;

const listDirectoryNames = (absoluteDirectory: string): string[] =>
  readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const listMarkdownFiles = (absoluteDirectory: string): string[] =>
  readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

/** Extract one frontmatter field, tolerating folded (`>`) / literal (`|`) scalars. */
function frontmatterField(text: string, key: string): string | undefined {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!block) return undefined;
  const lines = block.split('\n');
  const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (index === -1) return undefined;
  const inline = (lines[index] ?? '').slice(key.length + 1).trim();
  if (inline !== '' && !['>', '|', '>-', '|-'].includes(inline)) return inline;
  const collected: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const current = lines[cursor] ?? '';
    if (/^\s+\S/.test(current)) collected.push(current.trim());
    else if (/^\s*$/.test(current)) continue;
    else break;
  }
  return collected.join(' ').trim() || undefined;
}

/** Strip a single layer of surrounding YAML quotes (e.g. `"*(inline)*"` → `*(inline)*`). */
const unquote = (value: string): string => value.replace(/^(['"])(.*)\1$/, '$2');

/** Escape a `|` so an embedded pipe does not split a Markdown table cell. */
const cell = (value: string): string => value.replace(/\|/g, '\\|');

/** A token is a file path/glob (gets backticked) vs prose (rendered plain). */
const isPathLike = (token: string): boolean => /[/*]/.test(token) || /\.[a-z]/.test(token);

/** Split on top-level commas, ignoring commas inside `{...}` brace groups. */
function splitTopLevel(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of pattern) {
    if (character === '{') depth++;
    else if (character === '}') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Expand `{a,b,c}` groups; backtick path-like tokens, leave prose plain. */
function backtickedGlobs(pattern: string): string {
  return splitTopLevel(pattern)
    .flatMap((token) => {
      const brace = token.match(/^(.*)\{([^}]+)\}(.*)$/);
      if (!brace) return [token];
      const [, before = '', group = '', after = ''] = brace;
      return group.split(',').map((option) => `${before}${option.trim()}${after}`);
    })
    .map((token) => (isPathLike(token) ? `\`${token}\`` : token))
    .join(', ');
}

// ── Region rewrite helpers ──────────────────────────────────────────────────
interface DocResult {
  path: string;
  displayPath: string;
  next: string;
  changed: boolean;
}

/** Replace the single GENERATED region in `text` with `body`; error if absent. */
function rewriteRegion(displayPath: string, text: string, body: string): string {
  const start = text.indexOf(GENERATED_START);
  const end = text.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start)
    throw new Error(`${displayPath}: missing GENERATED:START/END markers`);
  const before = text.slice(0, start + GENERATED_START.length);
  const after = text.slice(end);
  return `${before}\n${body}\n${after}`;
}

// ── 1) be-skill-index Project-skills table ─────────────────────────────────────
function buildSkillIndexRegion(): DocResult {
  const path = join(agentOsDirectory, 'skills', 'be-skill-index', 'SKILL.md');
  const skills = listDirectoryNames(join(agentOsDirectory, 'skills'));
  const groups = readJson<{ groups: Record<string, string[]> }>(
    join(agentOsDirectory, 'skills', 'groups.json'),
  ).groups;
  // Group order from groups.json; within a group, groups.json order.
  const ordered: string[] = [];
  for (const members of Object.values(groups))
    for (const member of members)
      if (skills.includes(member) && !ordered.includes(member)) ordered.push(member);
  for (const skill of skills) if (!ordered.includes(skill)) ordered.push(skill);

  const rows = ordered.map((skill) => {
    const note =
      frontmatterField(
        readText(join(agentOsDirectory, 'skills', skill, 'SKILL.md')),
        'indexNote',
      ) ?? '';
    return `| ${skill} | \`agent-os/skills/${skill}/SKILL.md\` | ${cell(note)} |`;
  });
  const body = [
    `## Project skills (${skills.length})`,
    '',
    'Grouped by `agent-os/skills/groups.json`. Regenerated by `pnpm agent-os:generate`.',
    '',
    '| Skill | Path | Note |',
    '| ----- | ---- | ---- |',
    ...rows,
  ].join('\n');

  const text = readText(path);
  const next = rewriteRegion('be-skill-index/SKILL.md', text, body);
  return {
    path,
    displayPath: 'agent-os/skills/be-skill-index/SKILL.md',
    next,
    changed: next !== text,
  };
}

// ── 2) agents-catalog.md ────────────────────────────────────────────────────
function buildAgentsCatalog(): DocResult {
  const path = join(agentOsDirectory, 'docs', 'agents-catalog.md');
  const agentsDirectory = join(agentOsDirectory, 'agents');
  const files = listMarkdownFiles(agentsDirectory);
  const pipelines = readJson<{ pipelines: Record<string, { steps?: string[] }> }>(
    join(agentsDirectory, 'pipelines.json'),
  ).pipelines;
  const pipelineOf = (agent: string): string[] =>
    Object.entries(pipelines)
      .filter(([, definition]) => (definition.steps ?? []).includes(agent))
      .map(([name]) => name);

  const rows = files.map((file) => {
    const text = readText(join(agentsDirectory, file));
    const name = frontmatterField(text, 'name') ?? basename(file, '.md');
    const model = frontmatterField(text, 'model') ?? 'inherit';
    const rationale = unquote(frontmatterField(text, 'modelRationale') ?? '');
    const modelCell = rationale ? `\`${model}\` — ${rationale}` : `\`${model}\``;
    const wraps = unquote(frontmatterField(text, 'wrapsSkill') ?? '*(inline)*');
    const useWhen = unquote(frontmatterField(text, 'useWhen') ?? '');
    const inPipelines = pipelineOf(name);
    const pipelineCell = inPipelines.length ? inPipelines.join(', ') : '—';
    return `| **${name}** | [\`agent-os/agents/${file}\`](../agents/${file}) | ${cell(wraps)} | ${cell(modelCell)} | ${pipelineCell} | ${cell(useWhen)} |`;
  });
  const body = [
    `All ${files.length} project agents — each read-only. Generated from \`agents/*.md\` frontmatter`,
    'and `agents/pipelines.json`. See [platform-access.md](platform-access.md) for how to invoke on each platform.',
    '',
    '| Agent | File | Wraps skill | Model (routing rationale) | Pipelines | Use when |',
    '| ----- | ---- | ----------- | ------------------------- | --------- | -------- |',
    ...rows,
  ].join('\n');

  const text = readText(path);
  const next = rewriteRegion('agents-catalog.md', text, body);
  return { path, displayPath: 'agent-os/docs/agents-catalog.md', next, changed: next !== text };
}

// ── 3) skill-triggers.md table ──────────────────────────────────────────────
function buildSkillTriggers(): DocResult {
  const path = join(agentOsDirectory, 'docs', 'skill-triggers.md');
  const skills = listDirectoryNames(join(agentOsDirectory, 'skills'));
  const chains = readJson<{
    chains: Record<
      string,
      { trigger?: string; steps?: string[]; optional?: string[]; description?: string }
    >;
  }>(join(agentOsDirectory, 'skills', 'chains.json')).chains;

  const chainEntryPatterns = new Set<string>();
  const chainRows: string[] = [];
  for (const definition of Object.values(chains)) {
    if (!definition.trigger) continue;
    chainEntryPatterns.add(definition.trigger);
    const steps = (definition.steps ?? []).join(' → ');
    const optional = (definition.optional ?? []).length
      ? ` (+ ${(definition.optional ?? []).join(', ')})`
      : '';
    chainRows.push(
      `| ${backtickedGlobs(definition.trigger)} | ${steps}${optional} | ${cell(definition.description ?? '')} |`,
    );
  }

  // Atomic rows: each skill declaring a `trigger` whose pattern isn't a chain entry.
  const atomicRows: string[] = [];
  for (const skill of skills) {
    const text = readText(join(agentOsDirectory, 'skills', skill, 'SKILL.md'));
    const trigger = frontmatterField(text, 'trigger');
    if (!trigger || chainEntryPatterns.has(trigger)) continue;
    const note = frontmatterField(text, 'triggerNote') ?? '';
    atomicRows.push(`| ${backtickedGlobs(trigger)} | ${skill} | ${cell(note)} |`);
  }
  atomicRows.sort();

  const body = [
    'When you edit a file matching a pattern below, invoke the listed skill(s). Generated from',
    '`agent-os/skills/chains.json` (multi-skill rows) and per-skill `trigger` frontmatter.',
    '',
    '| File pattern | Invoke skill(s) | Notes |',
    '| ------------ | --------------- | ----- |',
    ...chainRows,
    ...atomicRows,
  ].join('\n');

  const text = readText(path);
  const next = rewriteRegion('skill-triggers.md', text, body);
  return { path, displayPath: 'agent-os/docs/skill-triggers.md', next, changed: next !== text };
}

/** Regenerate all three docs. In write mode, persist changes; returns drift list. */
export function generateDocs(writeMode: boolean): string[] {
  const drift: string[] = [];
  for (const build of [buildSkillIndexRegion, buildAgentsCatalog, buildSkillTriggers]) {
    const result = build();
    if (!result.changed) continue;
    if (writeMode) {
      writeFileSync(result.path, result.next);
    } else {
      drift.push(
        `drift: ${result.displayPath} out of sync with its source — run \`pnpm agent-os:generate --write\``,
      );
    }
  }
  return drift;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const writeMode = process.argv.includes('--write');
  const drift = generateDocs(writeMode);
  for (const message of drift) console.log(`  • ${message}`);
  if (!writeMode && drift.length) process.exit(1);
  console.log(writeMode ? '✓ generated docs' : '✓ docs in sync');
}
