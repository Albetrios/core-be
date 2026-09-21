/**
 * Adopt this repository as the starting point for a new project.
 *
 * Automates the checklist in `docs/getting-started/adopting-as-template.md`:
 * collects the new identity, rewrites `tooling/setup/setup.config.json`,
 * regenerates every identity artifact, resyncs the lockfile, and reports the
 * manual remainder (provider secrets, the GitHub Template flag).
 *
 * Usage:
 *   pnpm init:project                       # interactive
 *   pnpm init:project --name acme-api --repository acme/acme-api --yes
 *   pnpm init:project --dry-run             # show the plan, write nothing
 *   pnpm init:project --reset-history       # ALSO perform the destructive fork reset
 *   pnpm init:project --keep-docs           # leave prose naming the base project
 *
 * @remarks
 * Identity-only by default. `--reset-history` is what truncates the changelog and
 * deletes the base project's review artifacts and coverage budgets; it is opt-in
 * and confirmed by typing an exact phrase, because it is irreversible and this
 * script is typically run once, on a fresh clone, by someone who has not read it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';

import { generateAllProjectIdentityArtifacts } from '@tooling/setup/codegen/generate-project-identity.js';
import {
  resolveDerivedNames,
  resolveFrontendSlug,
} from '@tooling/setup/codegen/project-identity.util.js';
import { loadConfigIfExists, saveConfig } from '@tooling/setup/common/config.js';
import { gitEnvironmentWithoutInheritedRepository } from '@tooling/setup/common/git-environment.js';
import type { SetupConfig } from '@tooling/setup/common/types.js';
import * as log from '@tooling/setup/common/logger.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');

/** Phrase the operator must type to authorize the irreversible fork reset. */
const RESET_CONFIRMATION_PHRASE = 'reset';

/**
 * Files whose project-name mentions are left alone by the prose rewrite.
 *
 * @remarks
 * These RECORD what happened to the base project under its own name and link to
 * its issues and commits. Rewriting them would invent a history the new project
 * never had and leave every citation pointing at a URL that does not resolve,
 * because the issue lives in the BASE repository. A fork that wants them gone
 * should DELETE them (`--reset-history`), not relabel them.
 */
const PROSE_REWRITE_EXCLUDED: readonly string[] = [
  'CHANGELOG.md',
  'docs/reviews/',
  'docs/superpowers/',
  'pnpm-lock.yaml',
];

/**
 * Directories whose files are rewritten regardless of extension.
 *
 * @remarks
 * Git hooks are extensionless by convention (`.husky/pre-push`), so the
 * extension filter alone would skip them and leave the base project's name in a
 * script every developer runs on every push.
 */
const PROSE_REWRITE_EXTENSIONLESS_DIRECTORIES: readonly string[] = ['.husky/'];

/** Extensions the prose rewrite will open; everything else is left untouched. */
const PROSE_REWRITE_EXTENSIONS: readonly string[] = [
  '.md',
  '.mdc',
  '.txt',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.ts',
  '.mjs',
  '.js',
  '.sh',
  '.toml',
  '.properties',
  '.example',
  // Migrations name the Postgres roles the app connects as; without this the
  // baseline migration is rewritten by the generator while every later migration
  // keeps the base project's role, and the two disagree.
  '.sql',
];

/** Paths deleted by `--reset-history` — artifacts describing the BASE project's history. */
const FORK_RESET_PATHS: ReadonlyArray<{ path: string; description: string }> = [
  { path: 'docs/reviews', description: "the base project's archived review reports" },
  {
    path: 'docs/superpowers',
    description: "the base project's completed implementation plans and specs",
  },
];

interface InitOptions {
  readonly name?: string | undefined;
  readonly displayName?: string | undefined;
  readonly packageName?: string | undefined;
  readonly description?: string | undefined;
  readonly repository?: string | undefined;
  readonly owners?: string[] | undefined;
  readonly resetHistory: boolean;
  /** Leave prose naming the BASE project untouched (default: rewrite it). */
  readonly keepDocs: boolean;
  readonly dryRun: boolean;
  readonly assumeYes: boolean;
}

function parseArguments(argv: readonly string[]): InitOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    return next && !next.startsWith('--') ? next : undefined;
  };
  const owners = value('--owners');
  const options: InitOptions = {
    name: value('--name'),
    displayName: value('--display-name'),
    packageName: value('--package-name'),
    description: value('--description'),
    repository: value('--repository'),
    ...(owners ? { owners: owners.split(',').map((owner) => owner.trim()) } : {}),
    resetHistory: argv.includes('--reset-history'),
    keepDocs: argv.includes('--keep-docs'),
    dryRun: argv.includes('--dry-run'),
    assumeYes: argv.includes('--yes'),
  };
  return options;
}

async function ask(question: string, fallback: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`  ${question} [${fallback}]: `);
    return answer.trim() === '' ? fallback : answer.trim();
  } finally {
    readline.close();
  }
}

async function askExactPhrase(question: string, expected: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`  ${question}`);
    return answer.trim() === expected;
  } finally {
    readline.close();
  }
}

/** Slug rules shared with GitHub repository names and Docker image tags. */
function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    throw new Error(
      `Invalid project slug "${slug}". Use lowercase letters, digits and hyphens (e.g. acme-api) — it becomes the Docker image tag, JWT issuer and MCP URI scheme.`,
    );
  }
}

function assertValidRepository(repository: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`Invalid repository "${repository}". Expected "owner/repo".`);
  }
}

/**
 * Collect the new identity, preferring flags and falling back to prompts.
 *
 * @remarks
 * Defaults come from the CURRENT manifest, so re-running the script shows the
 * previous answers — the same saved-answers behaviour `pnpm github:sync` has.
 */
async function resolveIdentity(
  current: SetupConfig,
  options: InitOptions,
): Promise<{
  name: string;
  displayName: string;
  packageName: string;
  description?: string;
  repository: string;
  owners: string[];
}> {
  const interactive = !options.assumeYes;
  const name =
    options.name ??
    (interactive ? await ask('Project slug', current.project.name) : current.project.name);
  assertValidSlug(name);

  // Every later default keys off whether the slug actually CHANGED — not off
  // whether `--name` was passed. In an interactive run the new slug arrives from
  // the prompt, so testing the flag would suggest the old repository and names.
  const slugChanged = name !== current.project.name;
  const derivedDefault = (currentValue: string): string => (slugChanged ? name : currentValue);

  const displayName =
    options.displayName ??
    (interactive
      ? await ask('Display name', derivedDefault(current.project.displayName))
      : derivedDefault(current.project.displayName));

  const packageName =
    options.packageName ??
    (interactive
      ? await ask('npm package name', derivedDefault(current.project.packageName ?? name))
      : derivedDefault(current.project.packageName ?? name));

  const currentOwner = current.providers.github.repository.split('/')[0] ?? '';
  const repositoryDefault = slugChanged
    ? `${currentOwner}/${name}`
    : current.providers.github.repository;
  const repository =
    options.repository ??
    (interactive
      ? await ask('GitHub repository (owner/repo)', repositoryDefault)
      : repositoryDefault);
  assertValidRepository(repository);

  const inferredOwner = repository.split('/')[0] ?? '';
  const owners = options.owners ?? [inferredOwner];

  return {
    name,
    displayName,
    packageName,
    ...(options.description ? { description: options.description } : {}),
    repository,
    owners,
  };
}

function runCommand(command: string, args: readonly string[]): void {
  execFileSync(command, [...args], { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
}

/**
 * Report any file still containing the PREVIOUS identity after regeneration.
 *
 * @remarks
 * The CI gate scans for the CURRENT identity outside its allowlist, which cannot
 * see leftovers of the old name. This script is the only place that knows both
 * values, so the residual sweep belongs here. Reported, never auto-edited —
 * most hits are prose that a human should reword.
 */
/**
 * Replace the base project's name and owner throughout prose and non-generated
 * config, so the adopted repository refers only to the new product.
 *
 * @remarks
 * The generator owns the files where identity is load-bearing; this pass covers
 * everything else a reader sees — the README, the setup guide, the AI-agent
 * instructions in `.claude`/`.cursor`/`agent-os`, and the reference docs. Left
 * alone, those tell a new teammate (and every coding agent) that they are
 * working on a different project.
 *
 * Substring replacement is deliberate and safe here because the slug is
 * hyphenated and specific: a sibling repository sharing only the first segment
 * (a paired frontend, an infrastructure repo) does not match the full slug, and
 * compounds such as the `-api` image tag and repository URLs rewrite correctly.
 *
 * This file is itself rewritten by the pass it defines, so nothing here may cite
 * the project by name — an illustrative literal would be rewritten into a real
 * hardcoded identity and fail the literal gate on the adopted repository.
 *
 * Returns the paths it changed.
 */
/** `acme_be` → `AcmeBe`, for identifiers embedded in TypeScript symbol names. */
function pascalCase(identifierStem: string): string {
  return identifierStem
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** `acme_be` → `acmeBe`, for local identifiers in shipped source. */
function lowerCamelCase(identifierStem: string): string {
  const pascal = pascalCase(identifierStem);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function rewriteProseIdentity(options: {
  readonly previousSlug: string;
  readonly previousOwner: string;
  readonly previousFrontend: string;
  readonly previousSqlStem: string;
  readonly nextSqlStem: string;
  readonly nextDatabaseName: string;
  readonly nextSlug: string;
  readonly nextOwner: string;
  readonly nextFrontend: string;
  readonly dryRun: boolean;
}): string[] {
  const basePairs = (
    [
      // Frontend FIRST: the pair names share a stem, and rewriting the backend
      // slug first would leave the frontend mention half-renamed when one is a
      // prefix of the other.
      [options.previousFrontend, options.nextFrontend],
      // The slug in identifier form, in both casings. Underscored names never
      // match the hyphenated slug pass, and they appear in two shapes: lower
      // (`<stem>_app` Postgres roles, the Docker volume) and UPPER (env vars such
      // as `<STEM>_RUNTIME`). One pair per casing covers every such name, present
      // and future.
      [options.previousSqlStem.toUpperCase(), options.nextSqlStem.toUpperCase()],
      // PascalCase, for identifiers embedded in TypeScript symbol names such as
      // `grantCoreBeAppRoleForTests`. A rename that misses this leaves helper
      // functions named after the base project in the fork's own test suite.
      [pascalCase(options.previousSqlStem), pascalCase(options.nextSqlStem)],
      // lowerCamel, for local identifiers such as `coreBeAppRole` in shipped
      // source. PascalCase does not cover it — the leading character differs.
      [lowerCamelCase(options.previousSqlStem), lowerCamelCase(options.nextSqlStem)],
      // Fully concatenated, for identifiers that keep no separator at all
      // (mermaid node ids). Listed last so the separated forms match first.
      [options.previousSqlStem.replace(/_/g, ''), options.nextSqlStem.replace(/_/g, '')],
      [options.previousSqlStem, options.nextSqlStem],
      [options.previousSlug, options.nextSlug],
      [options.previousOwner, options.nextOwner],
    ] as Array<[string, string]>
  ).filter(([from, to]) => from && to && from !== to);

  // Prose capitalizes the slug at the start of a sentence ("Core-be records…"),
  // so the lowercase pass alone leaves those behind. Each pair therefore gets a
  // sentence-case variant, applied BEFORE the lowercase one so the longer,
  // more specific form wins.
  const replacements = basePairs.flatMap(([from, to]): Array<[string, string]> => {
    const sentenceCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
    const capitalizedFrom = sentenceCase(from);
    return capitalizedFrom === from
      ? [[from, to]]
      : [
          [capitalizedFrom, sentenceCase(to)],
          [from, to],
        ];
  });
  if (replacements.length === 0) {
    return [];
  }

  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnvironmentWithoutInheritedRepository(),
  })
    .split('\0')
    .filter((entry) => entry.length > 0);

  const changed: string[] = [];
  for (const relativePath of tracked) {
    if (PROSE_REWRITE_EXCLUDED.some((excluded) => relativePath.startsWith(excluded))) continue;
    const alwaysRewrite = PROSE_REWRITE_EXTENSIONLESS_DIRECTORIES.some((directory) =>
      relativePath.startsWith(directory),
    );
    if (
      !(
        alwaysRewrite ||
        PROSE_REWRITE_EXTENSIONS.some((extension) => relativePath.endsWith(extension))
      )
    ) {
      continue;
    }

    const absolutePath = resolve(REPOSITORY_ROOT, relativePath);
    let contents: string;
    try {
      contents = readFileSync(absolutePath, 'utf-8');
    } catch {
      continue;
    }
    let updated = contents;
    for (const [from, to] of replacements) {
      updated = updated.split(from).join(to);
    }
    // Connection strings carry the LOCAL DATABASE name, which is the product stem rather
    // than the slug, so no string pair above matches them. Copy-pasteable setup commands
    // in docs would otherwise keep naming a database the adopted stack never creates —
    // the same `28P01: password authentication failed` that blocks a first bootstrap.
    // Shape-matched, and the trailing group preserves a `_dryrun`-style suffix.
    updated = updated.replace(
      /postgresql:\/\/[^:@/\s]+:[^@/\s]+@([^:/\s]+):(\d+)\/[a-z0-9]+(_[a-z0-9_]+)?/g,
      (_match, host: string, port: string, suffix = '') =>
        `postgresql://${options.nextDatabaseName}:${options.nextDatabaseName}@${host}:${port}/${options.nextDatabaseName}${suffix}`,
    );
    if (updated === contents) continue;
    changed.push(relativePath);
    if (!options.dryRun) {
      writeFileSync(absolutePath, updated, 'utf-8');
    }
  }
  return changed;
}

/**
 * Rename tracked files whose NAME carries the project slug.
 *
 * @remarks
 * The prose pass rewrites file CONTENTS; nothing renamed the files themselves. That gap
 * was not cosmetic — a migration whose body was rebranded while its filename was not left
 * its own regression test unable to load, and the parallel runner breaks out of its lane
 * loop on the first failure, so one ENOENT suppressed an entire database-bound lane.
 *
 * Uses `git mv` so history follows the file. Matches the slug in both hyphenated and
 * underscored forms, since filenames use both conventions.
 */
function renameSlugNamedFiles(options: {
  readonly previousSlug: string;
  readonly nextSlug: string;
  readonly dryRun: boolean;
}): string[] {
  const previousForms = [options.previousSlug, options.previousSlug.replace(/-/g, '_')];
  const nextForms = [options.nextSlug, options.nextSlug.replace(/-/g, '_')];

  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnvironmentWithoutInheritedRepository(),
  })
    .split('\0')
    .filter((entry) => entry.length > 0);

  const renamed: string[] = [];
  for (const relativePath of tracked) {
    const segments = relativePath.split('/');
    const fileName = segments[segments.length - 1] ?? '';
    let nextFileName = fileName;
    for (const [index, form] of previousForms.entries()) {
      const replacement = nextForms[index];
      if (replacement && nextFileName.includes(form)) {
        nextFileName = nextFileName.split(form).join(replacement);
      }
    }
    if (nextFileName === fileName) continue;

    // `git ls-files` lists tracked paths even when the working tree no longer has them —
    // the fork reset deletes files earlier in this run, and the stale DBML is removed by
    // name. Renaming those would fail with ENOENT and abort the adoption.
    if (!existsSync(resolve(REPOSITORY_ROOT, relativePath))) continue;

    const nextPath = [...segments.slice(0, -1), nextFileName].join('/');
    renamed.push(`${relativePath} → ${nextPath}`);
    if (options.dryRun) continue;
    try {
      // Without the strip, an inherited GIT_PREFIX is prepended to both
      // pathspecs and the rename lands outside the repository root.
      execFileSync('git', ['mv', relativePath, nextPath], {
        cwd: REPOSITORY_ROOT,
        env: gitEnvironmentWithoutInheritedRepository(),
      });
    } catch {
      // Untracked-by-git checkouts fall back to a plain rename.
      renameSync(resolve(REPOSITORY_ROOT, relativePath), resolve(REPOSITORY_ROOT, nextPath));
    }
  }
  return renamed;
}

/**
 * Re-lock the vendored agent-os skills.
 *
 * @remarks
 * `agent-os/skills-lock.json` records a sha256 per vendored `SKILL.md`. The prose pass
 * rewrites those files, invalidating every hash, so `agent-os:check` fails on a freshly
 * adopted repo with one integrity error per skill. Regenerating is the remedy the failure
 * itself names — the rename simply never ran it.
 */
function relockAgentOsSkills(dryRun: boolean): boolean {
  if (dryRun) return false;
  try {
    execFileSync('pnpm', ['agent-os:lock'], { cwd: REPOSITORY_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function reportResidualLiterals(previousSlug: string, previousOwner: string): void {
  const stale = [previousSlug, previousOwner].filter(
    (literal, index, all) => literal.length > 0 && all.indexOf(literal) === index,
  );
  for (const literal of stale) {
    let output = '';
    try {
      // Exclude the historical record. CHANGELOG entries and the release-notes
      // archive DESCRIBE work done on the base project under its old name and
      // cite its issue URLs — rewriting them would falsify history, so listing
      // them here is pure noise that buries the lines a human must actually act
      // on. Prose in docs/ is still reported: it describes the fork now.
      output = execFileSync(
        'git',
        [
          'grep',
          '-rniI',
          '--',
          literal,
          ':!CHANGELOG.md',
          ':!docs/reviews/',
          ':!docs/superpowers/',
          ':!pnpm-lock.yaml',
        ],
        {
          cwd: REPOSITORY_ROOT,
          encoding: 'utf-8',
          maxBuffer: 32 * 1024 * 1024,
          env: gitEnvironmentWithoutInheritedRepository(),
        },
      );
    } catch {
      // git grep exits 1 when there are no matches — that is the success case.
      continue;
    }
    const lines = output.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    log.warn(
      `${lines.length} file line(s) still mention the previous identity "${literal}" (mostly prose — review and reword):`,
    );
    for (const line of lines.slice(0, 20)) {
      log.infoRaw(`    ${line}`);
    }
    if (lines.length > 20) {
      log.infoRaw(`    … and ${lines.length - 20} more (git grep -n "${literal}")`);
    }
  }
}

function performForkReset(dryRun: boolean): void {
  const changelog = resolve(REPOSITORY_ROOT, 'CHANGELOG.md');
  if (existsSync(changelog)) {
    if (dryRun) {
      log.info('Would truncate CHANGELOG.md to a fresh header.');
    } else {
      writeFileSync(
        changelog,
        '# Changelog\n\nAll notable changes to this project are documented in this file.\n',
        'utf-8',
      );
      log.success('Truncated CHANGELOG.md');
    }
  }
  for (const target of FORK_RESET_PATHS) {
    const absolute = resolve(REPOSITORY_ROOT, target.path);
    if (!existsSync(absolute)) continue;
    if (dryRun) {
      log.info(`Would delete ${target.path} — ${target.description}.`);
      continue;
    }
    rmSync(absolute, { recursive: true, force: true });
    log.success(`Deleted ${target.path}`);
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const current = loadConfigIfExists();
  if (!current) {
    log.error('tooling/setup/setup.config.json is missing or invalid — cannot adopt.');
    process.exit(1);
  }

  const previousSlug = current.project.name;
  const previousOwner = current.providers.github.repository.split('/')[0] ?? '';
  const previousFrontendSlug = resolveFrontendSlug(current);

  log.blank();
  log.info('Adopting this repository as a new project.');
  log.info('Reference: docs/getting-started/adopting-as-template.md');
  log.blank();

  const identity = await resolveIdentity(current, options);

  log.blank();
  log.info('New identity:');
  log.infoRaw(`    Project slug   : ${identity.name}`);
  log.infoRaw(`    Display name   : ${identity.displayName}`);
  log.infoRaw(`    Package name   : ${identity.packageName}`);
  log.infoRaw(`    Repository     : ${identity.repository}`);
  log.infoRaw(`    CODEOWNERS     : ${identity.owners.map((owner) => `@${owner}`).join(' ')}`);
  log.blank();

  if (options.dryRun) {
    log.warn('--dry-run: no files written.');
    if (options.resetHistory) performForkReset(true);
    return;
  }

  const updated: SetupConfig = {
    ...current,
    project: {
      ...current.project,
      name: identity.name,
      displayName: identity.displayName,
      packageName: identity.packageName,
      ...(identity.description ? { description: identity.description } : {}),
      // Artifact names derive from the slug; drop stale explicit overrides so the
      // defaults regenerate under the new name.
      ...(current.project.artifacts ? { artifacts: undefined } : {}),
    },
    providers: {
      ...current.providers,
      github: {
        ...current.providers.github,
        repository: identity.repository,
        owners: identity.owners,
      },
    },
  };
  saveConfig(updated);
  log.success('Updated tooling/setup/setup.config.json');

  const generated = generateAllProjectIdentityArtifacts();
  if (!generated) {
    log.error('Identity generation reported problems — resolve them, then re-run.');
    process.exit(1);
  }
  log.success('Regenerated project identity artifacts');

  // package.json `name` changed, so the lockfile's root importer is stale.
  log.info('Resyncing the lockfile (pnpm install)…');
  runCommand('pnpm', ['install', '--lockfile-only']);
  log.success('Lockfile resynced');

  if (options.resetHistory) {
    const confirmed =
      options.assumeYes ||
      (await askExactPhrase(
        `This deletes the base project's changelog and review artifacts. Type "${RESET_CONFIRMATION_PHRASE}" to confirm: `,
        RESET_CONFIRMATION_PHRASE,
      ));
    if (confirmed) {
      performForkReset(false);
    } else {
      log.warn('Fork reset skipped (confirmation did not match).');
    }
  }

  // The DBML diagram is named after the slug, so a rename leaves the old file
  // behind: the generator writes the NEW path and never learns about the old one.
  if (identity.name !== previousSlug) {
    const staleDbml = resolve(REPOSITORY_ROOT, `docs/database/${previousSlug}.dbml`);
    if (existsSync(staleDbml)) {
      rmSync(staleDbml, { force: true });
      log.success(
        `Removed stale docs/database/${previousSlug}.dbml (regenerated under the new name)`,
      );
    }
  }

  const renamedFiles = renameSlugNamedFiles({
    previousSlug,
    nextSlug: identity.name,
    dryRun: false,
  });
  if (renamedFiles.length > 0) {
    log.success(`Renamed ${renamedFiles.length} file(s) whose name carried the project slug`);
    for (const rename of renamedFiles) log.infoRaw(`    ${rename}`);
  }

  if (options.keepDocs) {
    log.warn('--keep-docs: prose still refers to the base project by name.');
  } else {
    const rewritten = rewriteProseIdentity({
      previousSlug,
      previousOwner,
      previousFrontend: previousFrontendSlug,
      previousSqlStem: previousSlug.replace(/-/g, '_'),
      nextSqlStem: identity.name.replace(/-/g, '_'),
      nextDatabaseName: resolveDerivedNames(updated).databaseName,
      nextSlug: identity.name,
      nextOwner: identity.repository.split('/')[0] ?? previousOwner,
      nextFrontend: resolveFrontendSlug(updated),
      dryRun: false,
    });
    log.success(
      `Rewrote the project name across ${rewritten.length} prose and config file(s) — docs, agent instructions, reference material and paired-frontend references now name this project.`,
    );
    // Must follow the prose pass: it rewrites every vendored SKILL.md, invalidating the
    // recorded hashes. Without this, `agent-os:check` fails on a freshly adopted repo.
    // Derived artifacts embed the project name, so a rebrand leaves them stale and their
    // drift gates red. Regenerate rather than leaving the adopter to discover each one.
    for (const [label, script] of [
      ['route catalog', 'routes:catalog'],
      ['database diagram', 'tool:generate-dbdiagram'],
      ['source tree', 'tool:project-structure-tree'],
      // OpenAPI + Postman: gitignored generated artifacts. Without them `docs:links:check`
      // is red on a fresh adoption, because docs/README.md cites the collection by name.
      ['API documents', 'docs:all'],
    ] as const) {
      try {
        execFileSync('pnpm', [script], { cwd: REPOSITORY_ROOT, stdio: 'ignore' });
        log.success(`Regenerated the ${label}`);
      } catch {
        log.warn(`Could not regenerate the ${label} — run \`pnpm ${script}\` before committing.`);
      }
    }

    if (relockAgentOsSkills(false)) {
      log.success('Re-locked agent-os skill hashes (pnpm agent-os:lock)');
    } else {
      log.warn('Could not re-lock agent-os skills — run `pnpm agent-os:lock` before committing.');
    }
  }

  log.blank();
  reportResidualLiterals(previousSlug, previousOwner);

  log.blank();
  log.info('Remaining manual steps:');
  log.instruction([
    'Create provider accounts and secrets (Stripe, Resend, S3, Sentry, Neon/Postgres, Redis).',
    'Run `pnpm setup:local` to scaffold .env.local, then `pnpm db:migrate`.',
    'Run `pnpm github:sync` to push rulesets, environments and secrets to the new repository.',
    'Replace the placeholder contacts in SECURITY.md and CONTRIBUTING.md.',
    `Enable the GitHub Template flag on the BASE repo if you maintain it: gh api -X PATCH repos/${previousOwner}/${previousSlug} -f is_template=true`,
    'Run `pnpm ci:local` to confirm every gate is green under the new identity.',
  ]);
  log.blank();
  log.success('Adoption complete.');
}

main().catch((error: Error) => {
  log.error(error.message);
  process.exit(1);
});
