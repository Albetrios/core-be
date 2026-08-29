#!/usr/bin/env tsx
/**
 * agent-os skills lockfile — provenance for every skill in agent-os/skills/.
 *
 * Each skill's SKILL.md is hashed (sha256) and recorded in
 * agent-os/skills-lock.json alongside its source. Home-grown skills are
 * `sourceType: "local"`; skills vendored from an upstream repo record the
 * `source` (github organization/repo) so upstream drift or local tampering is a failing
 * gate (agent-os/evals/check.ts recomputes and compares), not a silent change.
 *
 * Workflow: edit a skill → `pnpm agent-os:lock` (rewrite hashes) → commit both
 * the SKILL.md and the updated lockfile.
 *
 * Usage:
 *   tsx tooling/agent-os/skills-lock.ts            # default: --check (drift gate)
 *   tsx tooling/agent-os/skills-lock.ts --check    # compare on-disk hashes vs lock; exit 1 on drift
 *   tsx tooling/agent-os/skills-lock.ts --write     # recompute + rewrite the lockfile
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repositoryRoot = process.cwd();
const agentOsDirectory = join(repositoryRoot, 'agent-os');
const skillsDirectory = join(agentOsDirectory, 'skills');
const lockPath = join(agentOsDirectory, 'skills-lock.json');
const writeMode = process.argv.includes('--write');

/** Skills vendored from an upstream repository (everything else is home-grown/local). */
const KNOWN_EXTERNAL_SOURCES: Record<string, { source: string; sourceType: 'github' }> = {
  ponytail: { source: 'DietrichGebert/ponytail', sourceType: 'github' },
  'ponytail-audit': { source: 'DietrichGebert/ponytail', sourceType: 'github' },
};

export interface SkillLockEntry {
  source: string;
  sourceType: 'local' | 'github';
  skillPath: string;
  computedHash: string;
}
export interface SkillsLock {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

/** List skill directory names (each must own a SKILL.md), sorted. */
export function listSkillNames(): string[] {
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** sha256 of a skill's SKILL.md, or null when the file is absent. */
export function hashSkill(skill: string): string | null {
  const skillFile = join(skillsDirectory, skill, 'SKILL.md');
  if (!existsSync(skillFile)) return null;
  return createHash('sha256').update(readFileSync(skillFile)).digest('hex');
}

/** Read the committed lockfile, or null when it does not exist yet. */
export function readLock(): SkillsLock | null {
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, 'utf8')) as SkillsLock;
}

/** Build a fresh lock from disk, preserving prior external `source` attribution. */
function buildLock(previous: SkillsLock | null): SkillsLock {
  const skills: Record<string, SkillLockEntry> = {};
  for (const skill of listSkillNames()) {
    const computedHash = hashSkill(skill);
    if (computedHash === null) continue;
    const external = KNOWN_EXTERNAL_SOURCES[skill] ?? previousExternal(previous, skill);
    skills[skill] = {
      source: external?.source ?? 'local',
      sourceType: external?.sourceType ?? 'local',
      skillPath: `agent-os/skills/${skill}/SKILL.md`,
      computedHash,
    };
  }
  return { version: 1, skills };
}

/** Preserve a non-local `source` recorded in a prior lockfile, if any. */
function previousExternal(
  previous: SkillsLock | null,
  skill: string,
): { source: string; sourceType: 'github' } | undefined {
  const entry = previous?.skills[skill];
  if (entry && entry.sourceType === 'github') return { source: entry.source, sourceType: 'github' };
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const previous = readLock();
  const next = buildLock(previous);
  if (writeMode) {
    writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `\n✓ wrote agent-os/skills-lock.json — ${Object.keys(next.skills).length} skills\n`,
    );
  } else {
    const drift: string[] = [];
    const onDisk = new Set(listSkillNames());
    for (const skill of onDisk) {
      const locked = previous?.skills[skill];
      const computed = hashSkill(skill);
      if (!locked)
        drift.push(`skill "${skill}" is not in the lockfile — run \`pnpm agent-os:lock\``);
      else if (computed !== locked.computedHash)
        drift.push(`skill "${skill}" hash drifted from the lockfile — run \`pnpm agent-os:lock\``);
    }
    for (const locked of Object.keys(previous?.skills ?? {}))
      if (!onDisk.has(locked))
        drift.push(`lockfile lists "${locked}" which has no skill directory`);
    console.log(`\nagent-os skills-lock (check) — ${onDisk.size} skills\n`);
    for (const message of drift) console.log(`  • ${message}`);
    if (drift.length) {
      console.log(`\n✗ DRIFT — ${drift.length} lockfile mismatch(es)\n`);
      process.exit(1);
    }
    console.log('✓ in sync — no drift\n');
  }
}
