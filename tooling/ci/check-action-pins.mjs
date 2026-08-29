#!/usr/bin/env node
/**
 * Ensures third-party GitHub Actions in .github/workflows and composite actions
 * are pinned to full commit SHAs (optionally with a trailing version comment).
 *
 * Allowed:
 *   uses: actions/checkout@11bd71901bbe5b1630cea0616a6785973c6dc2d2 # v4.2.2
 *   uses: ./.github/actions/setup-node-pnpm
 *
 * Disallowed:
 *   uses: actions/checkout@v6
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const ACTION_DIR = join(ROOT, '.github/actions');

const THIRD_PARTY_ACTION_PATTERN = /^\s*uses:\s+(?!\.\/)([\w.-]+\/[\w.-]+)@([^\s#]+)/gm;
const SHA_PIN_PATTERN = /^[0-9a-f]{40}$/;

function listYamlFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listYamlFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativePath(absolutePath) {
  return absolutePath.startsWith(`${ROOT}/`) ? absolutePath.slice(ROOT.length + 1) : absolutePath;
}

const violations = [];

for (const filePath of [...listYamlFiles(WORKFLOW_DIR), ...listYamlFiles(ACTION_DIR)]) {
  const contents = readFileSync(filePath, 'utf8');
  const actionMatches = [...contents.matchAll(THIRD_PARTY_ACTION_PATTERN)];
  for (const match of actionMatches) {
    const [, actionName, reference] = match;
    if (SHA_PIN_PATTERN.test(reference)) {
      continue;
    }
    violations.push(
      `${relativePath(filePath)}: unpinned reference for ${actionName}@${reference} → pin to full SHA`,
    );
  }
}

if (violations.length > 0) {
  console.error('Action pin check failed:\n');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error('\nPin actions with: uses: organization/repo@<40-char-sha> # vX.Y.Z');
  process.exit(1);
}

console.log('Action pin check passed (third-party actions use 40-character SHA refs).');
