#!/usr/bin/env tsx
/**
 * agent-os integrity evals — Tier 1 (deterministic).
 *
 * The agent-os/ bundle (skills, rules, agents, docs, hooks) is a large,
 * cross-referenced surface that silently drifts: stale counts, dead path
 * references, index/disk divergence, non-portable hook commands. This gate
 * asserts the structural invariants so that drift fails CI instead of being
 * discovered months later by a human audit.
 *
 * Tier 1 (here) is pure file inspection — fast, zero-token, zero-flake — and
 * gates CI. Tier 2 (trigger-eval.ts) checks routing behaviour and is reported,
 * not gated, until it is calibrated. See README.md.
 *
 * Usage:
 *   tsx agent-os/evals/check.ts            # gate: exits 1 on any ERROR
 *   tsx agent-os/evals/check.ts --report   # verbose: list every check + WARNs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

const repositoryRoot = process.cwd();
const agentOsDirectory = join(repositoryRoot, "agent-os");
const reportMode = process.argv.includes("--report");

type Level = "error" | "warn";
interface Finding {
  level: Level;
  check: string;
  message: string;
}

const findings: Finding[] = [];
const error = (check: string, message: string) =>
  findings.push({ level: "error", check, message });
const warn = (check: string, message: string) =>
  findings.push({ level: "warn", check, message });

const readText = (absolutePath: string): string =>
  readFileSync(absolutePath, "utf8");

const listDirectoryNames = (absoluteDirectory: string): string[] =>
  readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const listFilesWithExtension = (
  absoluteDirectory: string,
  extension: string,
): string[] =>
  readdirSync(absoluteDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort();

/** Extract a single frontmatter field, tolerating folded (`>`) / literal (`|`) scalars. */
function frontmatterField(text: string, key: string): string | undefined {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!block) return undefined;
  const lines = block.split("\n");
  const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (index === -1) return undefined;
  const inline = lines[index].slice(key.length + 1).trim();
  if (inline !== "" && ![">", "|", ">-", "|-"].includes(inline)) return inline;
  const collected: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    if (/^\s+\S/.test(lines[cursor])) collected.push(lines[cursor].trim());
    else if (/^\s*$/.test(lines[cursor])) continue;
    else break;
  }
  return collected.join(" ").trim() || undefined;
}

function allNumbers(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

// ── Check 1: every skill has valid frontmatter and name matches its directory ──
const skillNames = listDirectoryNames(join(agentOsDirectory, "skills"));
for (const skill of skillNames) {
  const skillFile = join(agentOsDirectory, "skills", skill, "SKILL.md");
  if (!existsSync(skillFile)) {
    error("skill-frontmatter", `skills/${skill}/ has no SKILL.md`);
    continue;
  }
  const text = readText(skillFile);
  const name = frontmatterField(text, "name");
  const description = frontmatterField(text, "description");
  if (!name)
    error(
      "skill-frontmatter",
      `skills/${skill}/SKILL.md missing frontmatter \`name\``,
    );
  else if (name !== skill)
    error(
      "skill-frontmatter",
      `skills/${skill}/SKILL.md name "${name}" != directory "${skill}"`,
    );
  if (!description)
    error(
      "skill-frontmatter",
      `skills/${skill}/SKILL.md missing frontmatter \`description\``,
    );
  else if (description.length < 80)
    warn(
      "skill-description",
      `skills/${skill}: description is ${description.length} chars — too thin to auto-trigger reliably`,
    );
}

// ── Check 2: the index table lists exactly the skills on disk, and paths resolve ──
// The `## Project skills (N)` count + table is generated (tooling/agent-os/generate-docs.ts)
// between GENERATED markers, so a stale count is impossible — gated by
// `agent-os:generate:check`, not re-counted here. This check stays as the
// path-existence guard: every table row points at a real SKILL.md.
const indexFile = join(agentOsDirectory, "skills", "be-skill-index", "SKILL.md");
if (existsSync(indexFile)) {
  const indexText = readText(indexFile);
  const tableNames = new Set<string>();
  for (const row of indexText.matchAll(
    /^\|\s*([a-z][a-z0-9-]+)\s*\|\s*`([^`]+)`/gm,
  )) {
    tableNames.add(row[1]);
    const referencedPath = row[2].trim();
    if (!existsSync(join(repositoryRoot, referencedPath)))
      error(
        "skill-index-table",
        `be-skill-index row "${row[1]}" points at missing path ${referencedPath}`,
      );
  }
  for (const skill of skillNames)
    if (!tableNames.has(skill))
      error(
        "skill-index-table",
        `skill "${skill}" exists on disk but is absent from the be-skill-index table`,
      );
  for (const listed of tableNames)
    if (!skillNames.includes(listed))
      error(
        "skill-index-table",
        `be-skill-index table lists "${listed}" which has no directory`,
      );
}

// ── Check 3b: skills-lock.json provenance — every skill locked, no hash drift ──
// The lockfile records the sha256 of each skill's SKILL.md (and its source).
// A skill edited without relocking, a new skill never locked, or a lock entry
// for a deleted skill all fail here — provenance is a gate, not a hope.
// Workflow: edit skill → `pnpm agent-os:lock` → commit SKILL.md + lockfile.
const lockFile = join(agentOsDirectory, "skills-lock.json");
if (!existsSync(lockFile)) {
  error(
    "skills-lock",
    "agent-os/skills-lock.json is missing — run `pnpm agent-os:lock`",
  );
} else {
  try {
    const lock = JSON.parse(readText(lockFile)) as {
      skills?: Record<string, { computedHash?: string }>;
    };
    const locked = lock.skills ?? {};
    for (const skill of skillNames) {
      const skillFile = join(agentOsDirectory, "skills", skill, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const entry = locked[skill];
      if (!entry) {
        error(
          "skills-lock",
          `skill "${skill}" is not in skills-lock.json — run \`pnpm agent-os:lock\``,
        );
        continue;
      }
      const computedHash = createHash("sha256")
        .update(readFileSync(skillFile))
        .digest("hex");
      if (computedHash !== entry.computedHash)
        error(
          "skills-lock",
          `skill "${skill}" SKILL.md changed since it was locked — run \`pnpm agent-os:lock\``,
        );
    }
    for (const lockedName of Object.keys(locked))
      if (!skillNames.includes(lockedName))
        error(
          "skills-lock",
          `skills-lock.json lists "${lockedName}" which has no skill directory`,
        );
  } catch {
    error("skills-lock", "agent-os/skills-lock.json is not valid JSON");
  }
}

// ── Check 4: the sync-rule count in skill-triggers.md matches reality ──
const triggersFile = join(agentOsDirectory, "docs", "skill-triggers.md");
const syncRuleCount = listFilesWithExtension(
  join(agentOsDirectory, "rules"),
  "-sync.mdc",
).length;
if (existsSync(triggersFile)) {
  const triggersText = readText(triggersFile);
  const claimed = [
    ...allNumbers(triggersText, /(\d+)\s+sync rules/g),
    ...allNumbers(triggersText, /(\d+)\s+`agent-os\/rules\/\*-sync\.mdc`/g),
  ];
  for (const count of new Set(claimed))
    if (count !== syncRuleCount)
      error(
        "sync-rule-count",
        `skill-triggers.md states ${count} sync rules; ${syncRuleCount} *-sync.mdc files exist`,
      );
}

// ── Check 5: agent catalog coverage ──
// The catalog table (incl. its `All N agents` count) is generated between
// GENERATED markers (tooling/agent-os/generate-docs.ts), gated by
// `agent-os:generate:check` — so a stale count is impossible and no longer
// re-counted here. This stays as the coverage guard: every agent file appears.
const agentFiles = listFilesWithExtension(
  join(agentOsDirectory, "agents"),
  ".md",
);
const catalogFile = join(agentOsDirectory, "docs", "agents-catalog.md");
if (existsSync(catalogFile)) {
  const catalogText = readText(catalogFile);
  for (const file of agentFiles) {
    const agentName = basename(file, ".md");
    if (!catalogText.includes(agentName))
      error(
        "agent-catalog-coverage",
        `agent "${agentName}" is not referenced in agents-catalog.md`,
      );
  }
}

// ── Check 7: every agent file has valid frontmatter; deep reasoners stay on inherit ──
// Model routing is intentional (Task 6): mechanical checkers are pinned to a cheap
// model (e.g. haiku) — that is fine and does NOT warn. Only a *deep reasoner* pinned
// off `inherit` warns, since under-powering a reasoning-heavy review is the real risk.
const deepReasoners = new Set([
  "be-verifier",
  "be-sql-design-reviewer",
  "be-production-hardening-reviewer",
  "be-production-reviewer",
  "be-ci-investigator",
  "be-stack-monitor",
]);
for (const file of agentFiles) {
  const text = readText(join(agentOsDirectory, "agents", file));
  const agentName = basename(file, ".md");
  const name = frontmatterField(text, "name");
  const description = frontmatterField(text, "description");
  const model = frontmatterField(text, "model");
  if (!name || name !== agentName)
    error(
      "agent-frontmatter",
      `agents/${file} name "${name ?? "∅"}" != "${agentName}"`,
    );
  if (!description)
    error(
      "agent-frontmatter",
      `agents/${file} missing frontmatter \`description\``,
    );
  if (model && model !== "inherit" && deepReasoners.has(agentName))
    warn(
      "agent-model",
      `agents/${file} pins model "${model}" but is a deep reasoner — prefer \`inherit\` so it keeps frontier reasoning`,
    );
}

// ── Check 12: read-only agents must enforce read-only via a tools allowlist ──
// `readonly: true` is honoured only by Cursor; on Claude Code an agent without a
// `tools` allowlist can still Edit/Write. Require every readonly agent to declare
// `tools` and to exclude the write tools, so the read-only contract is real on
// both platforms (audit §2, item 4).
const writeTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
for (const file of agentFiles) {
  const text = readText(join(agentOsDirectory, "agents", file));
  if (frontmatterField(text, "readonly") !== "true") continue;
  const tools = frontmatterField(text, "tools");
  if (!tools)
    error(
      "agent-readonly",
      `agents/${file} is readonly:true but declares no \`tools\` allowlist — read-only is unenforced on Claude`,
    );
  else {
    const offenders = writeTools.filter((tool) =>
      new RegExp(`\\b${tool}\\b`).test(tools),
    );
    if (offenders.length)
      error(
        "agent-readonly",
        `agents/${file} is readonly:true but its \`tools\` allowlist includes write tool(s): ${offenders.join(", ")}`,
      );
  }
}

// ── Check 8: hook commands must be portable and reference scripts that exist ──
const settingsFile = join(repositoryRoot, ".claude", "settings.json");
if (existsSync(settingsFile)) {
  let settings: {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  } | null = null;
  try {
    settings = JSON.parse(readText(settingsFile));
  } catch {
    error("hook-portability", ".claude/settings.json is not valid JSON");
  }
  const commands = Object.values(settings?.hooks ?? {})
    .flat()
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command)
    .filter((command): command is string => typeof command === "string");
  for (const command of commands) {
    if (/\/Users\/|\/home\/|\/root\//.test(command))
      error(
        "hook-portability",
        `.claude/settings.json hook hardcodes an absolute home path — use "$CLAUDE_PROJECT_DIR": ${command}`,
      );
    const scriptReference = command.match(
      /agent-os\/hooks\/[A-Za-z0-9._-]+\.sh/,
    )?.[0];
    if (scriptReference && !existsSync(join(repositoryRoot, scriptReference)))
      error(
        "hook-script",
        `.claude/settings.json references hook script ${scriptReference} which does not exist`,
      );
  }
}

// ── Check 9: backtick-referenced repo paths in agent-os docs/rules must exist ──
const ignoreFile = join(agentOsDirectory, "evals", "ignore.json");
const ignored: string[] = existsSync(ignoreFile)
  ? (JSON.parse(readText(ignoreFile)).paths ?? [])
  : [];
const pathRoots = [
  "src/",
  "tooling/",
  "agent-os/",
  "docs/",
  "migrations/",
  ".github/",
  ".husky/",
  ".vscode/",
  ".cursor/",
];
// `.js` is excluded on purpose: source uses `.js` ESM specifiers that resolve to `.ts` files on disk.
const pathExtensions = [
  ".ts",
  ".tsx",
  ".mjs",
  ".json",
  ".md",
  ".mdc",
  ".sql",
  ".yml",
  ".yaml",
  ".sh",
  ".hcl",
  ".txt",
];
const isPathCandidate = (token: string): boolean => {
  // Reject globs, `<placeholders>`, `{brace,expansion}`, URLs, and parent refs.
  if (/[*<>:{}\s]|\.\.|^https?/.test(token)) return false;
  if (ignored.some((entry) => token === entry || token.startsWith(entry)))
    return false;
  const underRoot = pathRoots.some((root) => token.startsWith(root));
  const hasKnownExtension = pathExtensions.some((extension) =>
    token.endsWith(extension),
  );
  return underRoot && hasKnownExtension;
};
const scanOneFile = (absolutePath: string) => {
  const displayPath = relative(repositoryRoot, absolutePath);
  const text = readText(absolutePath);
  const seen = new Set<string>();
  for (const inline of text.matchAll(/`([^`\n]+)`/g)) {
    const token = inline[1].trim();
    if (seen.has(token) || !isPathCandidate(token)) continue;
    seen.add(token);
    if (!existsSync(join(repositoryRoot, token)))
      // Gated: the reference corpus is clean, so a missing path is a real dead reference.
      // Add genuinely-absent paths (gitignored / generated / illustrative) to evals/ignore.json.
      error(
        "referenced-path",
        `${displayPath} → \`${token}\` does not exist (fix the ref, or add to evals/ignore.json if intentional)`,
      );
  }
};
const scanForPaths = (absoluteDirectory: string, extension: string) => {
  for (const file of listFilesWithExtension(absoluteDirectory, extension))
    scanOneFile(join(absoluteDirectory, file));
};
scanForPaths(join(agentOsDirectory, "docs"), ".md");
scanForPaths(join(agentOsDirectory, "rules"), ".mdc");
for (const skill of skillNames)
  scanForPaths(join(agentOsDirectory, "skills", skill), ".md");
// Repo-wide: the canonical entry-point docs at the root are scanned too, so a
// dead `src/...` / `agent-os/...` reference there fails the gate like any other.
for (const rootDoc of ["CLAUDE.md", "AGENTS.md"])
  if (existsSync(join(repositoryRoot, rootDoc)))
    scanOneFile(join(repositoryRoot, rootDoc));

// ── Check 10: root docs (CLAUDE.md, AGENTS.md) state counts that match disk ──
// These root files sit outside the per-component scans above (be-skill-index,
// skill-triggers, agents-catalog), so a stale count there ("22 sync rules",
// "All 8 agents", "36 project skills") drifts unseen. Same patterns, applied
// at the repo root so the canonical entry-point docs cannot silently diverge.
for (const rootDoc of ["CLAUDE.md", "AGENTS.md"]) {
  const rootDocFile = join(repositoryRoot, rootDoc);
  if (!existsSync(rootDocFile)) continue;
  const rootText = readText(rootDocFile);
  for (const count of new Set(allNumbers(rootText, /(\d+)\s+project skills/g)))
    if (count !== skillNames.length)
      error(
        "root-doc-count",
        `${rootDoc} states ${count} project skills; ${skillNames.length} exist on disk`,
      );
  for (const count of new Set(allNumbers(rootText, /(\d+)\s+sync rules/g)))
    if (count !== syncRuleCount)
      error(
        "root-doc-count",
        `${rootDoc} states ${count} sync rules; ${syncRuleCount} *-sync.mdc files exist`,
      );
  for (const count of new Set(
    allNumbers(rootText, /[Aa]ll\s+(\d+)\s+(?:project\s+)?agents/g),
  ))
    if (count !== agentFiles.length)
      error(
        "root-doc-count",
        `${rootDoc} states ${count} agents; ${agentFiles.length} agent files exist`,
      );
}

// ── Check 11: backbone manifests — hook scripts exist, capability registry is well-formed ──
// The generator (tooling/agent-os/generate.ts) owns drift between these manifests
// and the derived .claude/.cursor wiring (pnpm agent-os:generate:check); here we
// assert the source manifests themselves are structurally sound.
const hooksManifestFile = join(agentOsDirectory, "hooks", "hooks.json");
if (existsSync(hooksManifestFile)) {
  try {
    const manifest = JSON.parse(readText(hooksManifestFile)) as {
      hooks?: Array<{ id?: string; script?: string }>;
    };
    for (const entry of manifest.hooks ?? []) {
      if (!entry.script)
        error(
          "hooks-manifest",
          `hooks.json entry "${entry.id ?? "∅"}" has no script`,
        );
      else if (!existsSync(join(agentOsDirectory, "hooks", entry.script)))
        error(
          "hooks-manifest",
          `hooks.json references agent-os/hooks/${entry.script} which does not exist`,
        );
    }
  } catch {
    error("hooks-manifest", "agent-os/hooks/hooks.json is not valid JSON");
  }
}
const targetsRegistryFile = join(agentOsDirectory, "platforms", "targets.json");
if (existsSync(targetsRegistryFile)) {
  try {
    const registry = JSON.parse(readText(targetsRegistryFile)) as {
      agents?: Record<string, unknown>;
    };
    if (!registry.agents || Object.keys(registry.agents).length === 0)
      error("targets-registry", "platforms/targets.json declares no agents");
  } catch {
    error(
      "targets-registry",
      "agent-os/platforms/targets.json is not valid JSON",
    );
  }
}

// ── Check 13: skill groups + chains stay in sync with the skills on disk ──
// groups.json must place every skill in exactly one known group; chains.json
// steps must each reference a real skill — so the orchestration manifests cannot
// drift as skills are added or renamed.
const groupsFile = join(agentOsDirectory, "skills", "groups.json");
if (existsSync(groupsFile)) {
  try {
    const groups =
      (
        JSON.parse(readText(groupsFile)) as {
          groups?: Record<string, string[]>;
        }
      ).groups ?? {};
    const membership = new Map<string, number>();
    for (const [group, members] of Object.entries(groups))
      for (const member of members) {
        if (!skillNames.includes(member))
          error(
            "skill-groups",
            `groups.json group "${group}" lists "${member}" which has no skill directory`,
          );
        membership.set(member, (membership.get(member) ?? 0) + 1);
      }
    for (const skill of skillNames) {
      const count = membership.get(skill) ?? 0;
      if (count === 0)
        error("skill-groups", `skill "${skill}" is in no group in groups.json`);
      else if (count > 1)
        error(
          "skill-groups",
          `skill "${skill}" is in ${count} groups in groups.json (expected exactly 1)`,
        );
    }
  } catch {
    error("skill-groups", "agent-os/skills/groups.json is not valid JSON");
  }
}
const chainsFile = join(agentOsDirectory, "skills", "chains.json");
if (existsSync(chainsFile)) {
  try {
    const chains =
      (
        JSON.parse(readText(chainsFile)) as {
          chains?: Record<string, { steps?: string[]; optional?: string[] }>;
        }
      ).chains ?? {};
    for (const [chain, definition] of Object.entries(chains))
      for (const step of [
        ...(definition.steps ?? []),
        ...(definition.optional ?? []),
      ])
        if (!skillNames.includes(step))
          error(
            "skill-chains",
            `chains.json chain "${chain}" references "${step}" which has no skill directory`,
          );
  } catch {
    error("skill-chains", "agent-os/skills/chains.json is not valid JSON");
  }
}

// ── Check 18: every skill chain has at least one Tier-3 outcome fixture ──
// A chain without an outcome case is routing that is never behaviourally
// verified — the coverage rule is "new chain ⇒ new cases/outcomes/<chain>-*.jsonl
// fixture (+ .expected.json)". Fixture count may grow, never shrink to zero
// per chain (the outcome analogue of the tsdoc ratchet).
const outcomesDirectory = join(agentOsDirectory, "evals", "cases", "outcomes");
if (existsSync(chainsFile) && existsSync(outcomesDirectory)) {
  const outcomeFixtures = listFilesWithExtension(outcomesDirectory, ".jsonl");
  try {
    const chainNames = Object.keys(
      (JSON.parse(readText(chainsFile)) as { chains?: Record<string, unknown> })
        .chains ?? {},
    );
    for (const chain of chainNames)
      if (!outcomeFixtures.some((fixture) => fixture.startsWith(`${chain}-`)))
        error(
          "outcome-coverage",
          `chain "${chain}" has no outcome fixture — add agent-os/evals/cases/outcomes/${chain}-<case>.jsonl (+ .expected.json)`,
        );
    for (const fixture of outcomeFixtures) {
      const expected = fixture.replace(/\.jsonl$/, ".expected.json");
      if (!existsSync(join(outcomesDirectory, expected)))
        error(
          "outcome-coverage",
          `outcome fixture ${fixture} has no ${expected}`,
        );
    }
  } catch {
    /* chains.json parse errors are reported by Check 13 */
  }
}

// ── Check 19: sync rules mirror real skills, and their globs appear in the routing map ──
// The 25+ `<skill>-sync.mdc` files are Cursor's auto-attach mirror of the
// generated skill-triggers.md table — two surfaces for one fact. A sync rule
// whose skill was renamed/deleted, or whose glob no longer appears in the
// generated map, is silent drift between what Cursor attaches and what every
// other platform is told. (be-project-identity-sync is the one command-driven
// sync rule with no backing skill — exempt by design.)
const syncRuleSkillExemptions = new Set(["be-project-identity"]);
const triggersTableText = existsSync(triggersFile)
  ? readText(triggersFile)
  : "";
for (const ruleFile of listFilesWithExtension(
  join(agentOsDirectory, "rules"),
  "-sync.mdc",
)) {
  const ruleSkill = basename(ruleFile, ".mdc").replace(/-sync$/, "");
  if (syncRuleSkillExemptions.has(ruleSkill)) continue;
  if (!skillNames.includes(ruleSkill)) {
    error(
      "sync-rule-drift",
      `rules/${ruleFile} has no matching skill "${ruleSkill}" — rename the rule or restore the skill`,
    );
    continue;
  }
  const ruleText = readText(join(agentOsDirectory, "rules", ruleFile));
  const globsLine = frontmatterField(ruleText, "globs");
  if (!globsLine) {
    warn(
      "sync-rule-drift",
      `rules/${ruleFile} declares no globs — it will never auto-attach in Cursor`,
    );
    continue;
  }
  if (triggersTableText) {
    // Sync rules deliberately attach on a wider net than the routing map, so
    // per-glob matching is noise. The drift signal is a rule whose globs are
    // ALL absent from the map (after normalising `/**/*.ts` ↔ `/**` suffixes)
    // AND whose skill name is absent too — a fully disconnected mirror.
    const globs = globsLine
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    const appearsInMap = (glob: string): boolean =>
      [
        glob,
        glob.replace(/\/\*\*\/\*\.ts$/, "/**"),
        glob.replace(/\/\*\.ts$/, ""),
        glob.replace(/\/\*\*$/, ""),
      ].some((candidate) => candidate && triggersTableText.includes(candidate));
    if (!globs.some(appearsInMap) && !triggersTableText.includes(ruleSkill))
      warn(
        "sync-rule-drift",
        `rules/${ruleFile}: none of its globs (or its skill name) appear in docs/skill-triggers.md — Cursor auto-attach and the cross-platform map have fully diverged`,
      );
  }
}

// ── Check 14: command names are unique and never collide with a skill name ──
// Commands are workflows; skills are the granular procedures. A command must not
// shadow a skill (or another command), so routing stays unambiguous across tools.
const commandsDirectory = join(agentOsDirectory, "commands");
if (existsSync(commandsDirectory)) {
  const seenCommand = new Set<string>();
  for (const file of listFilesWithExtension(commandsDirectory, ".md")) {
    const name = basename(file, ".md");
    if (name === "README") continue;
    if (seenCommand.has(name))
      error(
        "command-uniqueness",
        `command "${name}" is defined more than once`,
      );
    seenCommand.add(name);
    if (skillNames.includes(name))
      error(
        "command-uniqueness",
        `command "${name}" collides with a skill of the same name`,
      );
  }
}

// ── Check 15: agent review-pipelines reference real agents ──
// pipelines.json names sequences of read-only agents (pre-merge-review runs via
// /be-pre-merge-review, prod-readiness after be-path-to-production-gate); every step
// must resolve to an agent file on disk.
const pipelinesFile = join(agentOsDirectory, "agents", "pipelines.json");
if (existsSync(pipelinesFile)) {
  const agentNames = new Set(agentFiles.map((file) => basename(file, ".md")));
  try {
    const pipelines =
      (
        JSON.parse(readText(pipelinesFile)) as {
          pipelines?: Record<string, { steps?: string[] }>;
        }
      ).pipelines ?? {};
    for (const [pipeline, definition] of Object.entries(pipelines))
      for (const step of definition.steps ?? [])
        if (!agentNames.has(step))
          error(
            "agent-pipelines",
            `pipelines.json pipeline "${pipeline}" references "${step}" which has no agent file`,
          );
  } catch {
    error(
      "agent-pipelines",
      "agent-os/agents/pipelines.json is not valid JSON",
    );
  }
}

// ── Check 16: plugin manifest references resolve to real paths ──
// agent-os/.claude-plugin/plugin.json makes agent-os/ itself the installable
// plugin root, so every component path is agent-os-relative; each must exist so
// the plugin is never broken.
const pluginRoot = join(repositoryRoot, "agent-os");
const pluginManifestFile = join(pluginRoot, ".claude-plugin", "plugin.json");
if (existsSync(pluginManifestFile)) {
  try {
    const manifest = JSON.parse(readText(pluginManifestFile)) as Record<
      string,
      unknown
    >;
    const references: string[] = [];
    for (const key of ["commands", "agents", "skills"]) {
      const value = manifest[key];
      if (Array.isArray(value))
        references.push(
          ...value.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        );
      else if (typeof value === "string") references.push(value);
    }
    if (typeof manifest.mcpServers === "string")
      references.push(manifest.mcpServers);
    for (const reference of references)
      if (!existsSync(join(pluginRoot, reference.replace(/^\.\//, ""))))
        error(
          "plugin-refs",
          `agent-os/.claude-plugin/plugin.json references ${reference} which does not exist`,
        );
  } catch {
    error(
      "plugin-refs",
      "agent-os/.claude-plugin/plugin.json is not valid JSON",
    );
  }
}

// ── Check 17: the /be-build-requirement intake form exists with all canonical sections ──
// docs/getting-started/requirement.template.md is the one format /be-build-requirement
// accepts; it must stay complete so a build always starts from the full 8-section spec.
const requirementForm = join(
  repositoryRoot,
  "docs",
  "getting-started",
  "requirement.template.md",
);
if (!existsSync(requirementForm)) {
  error(
    "requirement-form",
    "docs/getting-started/requirement.template.md is missing (the /be-build-requirement format)",
  );
} else {
  const formText = readText(requirementForm);
  const requiredSections = [
    "# Requirement:",
    "## 1. Summary & placement",
    "## 2. Data model",
    "## 3. Public API",
    "## 4. Business logic",
    "## 5. i18n",
    "## 6. Seed data",
    "## 7. Tests",
    "## 8. Non-functionals",
    "## 9. File structure",
  ];
  for (const section of requiredSections)
    if (!formText.includes(section))
      error(
        "requirement-form",
        `requirement.template.md is missing the "${section}" section`,
      );
}

// ── Check 17: every agent-os item this repo owns starts with `be-` ──
// core-be and core-fe (`fe-`) are often loaded in one session, where a shared name lets
// one repo's skill, agent, command or rule hide the other's. Skills installed from
// upstream keep their upstream names: the skills-lock.json entries whose sourceType is
// not "local" (today ponytail and ponytail-audit).
const repositoryPrefix = "be-";
const upstreamSkills = new Set<string>();
if (existsSync(lockFile)) {
  try {
    const lock = JSON.parse(readText(lockFile)) as {
      skills?: Record<string, { sourceType?: string }>;
    };
    for (const [name, entry] of Object.entries(lock.skills ?? {}))
      if (entry.sourceType !== "local") upstreamSkills.add(name);
  } catch {
    // Check 3b reports a malformed lock file.
  }
}
const requirePrefix = (kind: string, name: string) => {
  if (!name.startsWith(repositoryPrefix))
    error(
      "name-prefix",
      `${kind} "${name}" must start with "${repositoryPrefix}" — rename it "${repositoryPrefix}${name}"` +
        (kind === "skill" ? ", or record an upstream skill's source in skills-lock.json" : ""),
    );
};
for (const skill of skillNames)
  if (!upstreamSkills.has(skill)) requirePrefix("skill", skill);
for (const file of agentFiles) requirePrefix("agent", basename(file, ".md"));
if (existsSync(commandsDirectory))
  for (const file of listFilesWithExtension(commandsDirectory, ".md"))
    requirePrefix("command", basename(file, ".md"));
for (const file of listFilesWithExtension(join(agentOsDirectory, "rules"), ".mdc"))
  requirePrefix("rule", basename(file, ".mdc"));

// ── Report ──
const errors = findings.filter((finding) => finding.level === "error");
const warnings = findings.filter((finding) => finding.level === "warn");

const checkLabels: Record<string, string> = {
  "skill-frontmatter": "Skill frontmatter & names",
  "skill-index-table": "Skill-index ↔ disk (path resolution)",
  "skills-lock": "Skills lockfile provenance",
  "sync-rule-count": "Sync-rule count",
  "agent-catalog-coverage": "Agent catalog coverage",
  "agent-frontmatter": "Agent frontmatter",
  "agent-readonly": "Read-only agents enforce tools",
  "hook-portability": "Hook portability",
  "hook-script": "Hook scripts exist",
  "referenced-path": "Referenced paths exist",
  "root-doc-count": "Root-doc counts (CLAUDE/AGENTS)",
  "hooks-manifest": "Hook manifest scripts exist",
  "targets-registry": "Capability registry valid",
  "skill-groups": "Skill groups ↔ disk",
  "skill-chains": "Skill chains ↔ disk",
  "outcome-coverage": "Chains have outcome fixtures",
  "sync-rule-drift": "Sync rules ↔ skills/routing map",
  "command-uniqueness": "Command names unique",
  "agent-pipelines": "Agent pipelines ↔ disk",
  "plugin-refs": "Plugin manifest refs exist",
  "name-prefix": "Repo name prefix (be-)",
  "requirement-form": "Requirement form sections",
};

console.log("\nagent-os integrity evals (Tier 1)\n");
console.log(
  `  skills: ${skillNames.length}   sync-rules: ${syncRuleCount}   agents: ${agentFiles.length}\n`,
);

const group = (level: Level) => {
  const list = findings.filter((finding) => finding.level === level);
  const byCheck = new Map<string, string[]>();
  for (const finding of list)
    byCheck.set(finding.check, [
      ...(byCheck.get(finding.check) ?? []),
      finding.message,
    ]);
  return byCheck;
};

if (errors.length || reportMode) {
  for (const [check, messages] of group("error")) {
    console.log(`  ✗ ${checkLabels[check] ?? check}`);
    for (const message of messages) console.log(`      ${message}`);
  }
}
if (warnings.length) {
  for (const [check, messages] of group("warn")) {
    console.log(`  ⚠ ${checkLabels[check] ?? check} (${messages.length})`);
    if (reportMode)
      for (const message of messages) console.log(`      ${message}`);
  }
}

if (reportMode) {
  const checksWithFindings = new Set(findings.map((finding) => finding.check));
  for (const [check, label] of Object.entries(checkLabels))
    if (!checksWithFindings.has(check)) console.log(`  ✓ ${label}`);
}

console.log("");
if (errors.length) {
  console.log(
    `✗ FAILED — ${errors.length} integrity error(s), ${warnings.length} warning(s)\n`,
  );
  process.exit(1);
}
console.log(`✓ PASSED — 0 errors, ${warnings.length} warning(s)\n`);
