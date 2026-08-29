/**
 * Sync a local `.env.<environment>` file to its matching GitHub Environment.
 *
 * Classification is rule-based, NOT section-based. The `.env.example` half
 * headers ("GitHub Secrets" / "GitHub Variables") are for human readability
 * only. The push logic classifies each key via `classifyKey()` — a strict
 * rule set that cannot drift due to wrong-section placement.
 *
 * Reconciliation:
 *   - Items in the local file but missing on GitHub → created.
 *   - Variables with changed values → updated.
 *   - Secrets are always re-encrypted and pushed (GitHub hides secret values).
 *   - Keys absent from the local file entirely → DELETED on GitHub (file is truth).
 *   - Variables with unchanged values → left alone (counted as `unchanged`).
 *   - Variables whose value EQUALS their env-schema default → not pushed, and pruned
 *     from GitHub if present (the runtime falls back to the identical default, so
 *     storing it is redundant). Reported as `schema-default`. Pass
 *     `--keep-schema-defaults` to push them verbatim like any other variable.
 *
 * A key DECLARED in the local file but left blank (`KEY=`) is neither pushed nor
 * deleted: blank means "not managed here" (optional integrations ship blank in
 * `.env.example`), so the remote value is preserved. Only removing the key's LINE
 * marks it stale and deletes it. Blank keys are reported as `empty` in the summary
 * so a half-filled env file is visible rather than silent.
 *
 * The schema-default skip only ever applies to VARIABLES whose value matches the
 * exact stringified default from {@link envSchemaDefaults} (secrets and required keys
 * have no resolvable default and are always pushed). The match is conservative — a
 * value written in a different-but-equivalent form is treated as an override — so a
 * real override can never be dropped. See `envSchemaDefaults` for the extraction.
 *
 * Usage:
 *   pnpm github:sync development
 *   pnpm github:sync --all                          # reconcile every configured environment
 *   pnpm github:sync production --dry-run           # show what would be pushed
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import sodium from 'libsodium-wrappers';

import { envSchemaDefaults } from '@/shared/config/env-schema.js';
import { runGhAuthPreflight } from './auth-preflight.js';

const projectRoot = process.cwd();

const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000] as const;

/**
 * Page size for the environment variables/secrets list endpoints. GitHub silently clamps this
 * endpoint's `per_page` to 30 regardless of a higher request, so pagination MUST loop pages —
 * a single `per_page=100` fetch returns only the first 30 items and hides the rest.
 */
const ENVIRONMENT_ITEMS_PER_PAGE = 30;
/** Hard backstop on the pagination loop (30 × 200 = 6000 items) so a bad `total_count` cannot spin forever. */
const MAX_ENVIRONMENT_PAGES = 200;

/**
 * Minimum spacing between MUTATIVE requests (POST/PUT/PATCH/DELETE). GitHub's secondary
 * (abuse-detection) rate limit fires on bursts of writes even when the primary quota is healthy,
 * and its guidance is ≥1s between mutative calls. An env push is a SMALL write set (all secrets +
 * only the changed non-default variables — a few dozen calls), so a generous multi-second floor
 * costs only a couple minutes of total runtime while keeping the effective write rate well under
 * the secondary limit. Deliberately conservative — the whole push is well worth the extra spacing.
 */
const MUTATION_MIN_DELAY_MS = 3_000;

/**
 * Randomized jitter added on top of the mutative-write floor. A *fixed* cadence (exactly
 * {@link MUTATION_MIN_DELAY_MS} between every write) is itself a burst signature: GitHub's
 * secondary (abuse-detection) rate limiter keys on regular, machine-timed write streams and
 * tripped every environment push at ~20-25 consecutive writes — outlasting even the retry
 * backoff. Spacing each write by the floor PLUS a uniform-random delay in
 * [{@link MUTATION_JITTER_MIN_MS}, {@link MUTATION_JITTER_MAX_MS}] makes the stream look organic
 * ("not all at once"), lowers the effective write rate, and keeps the exact same logic on every
 * run. Applied to mutations only — GETs use primary-quota pacing and are not burst-limited.
 */
const MUTATION_JITTER_MIN_MS = 1_000;
const MUTATION_JITTER_MAX_MS = 4_000;

/**
 * On a SECONDARY (abuse-detection) rate-limit error we HOLD a full 5 minutes before retrying, and
 * repeat that hold up to {@link SECONDARY_RATE_LIMIT_MAX_RETRIES} times. GitHub's secondary limit
 * for content creation carries no Retry-After and can persist "up to an hour"; a short (≤4 min)
 * escalating backoff gives up too early AND repeated quick pokes ESCALATE the penalty. A flat
 * 5-minute hold is exactly GitHub's "wait a few minutes" guidance, so the run rides the penalty out
 * instead of hammering it. 12 holds ≈ up to an hour of patience. Written down here so every run
 * follows the same policy.
 */
const SECONDARY_RATE_LIMIT_HOLD_MS = 5 * 60_000;
const SECONDARY_RATE_LIMIT_MAX_RETRIES = 12;

/**
 * Dynamic-delay tuning. Between every successful request we wait
 * `clamp(timeToReset / remaining, MIN, MAX)` so a long batch is paced evenly
 * across the GitHub primary-rate-limit window. This avoids the secondary
 * abuse-detection rate limit that fires on bursts of writes to the same
 * environment, even when the primary quota is healthy.
 */
const DYNAMIC_DELAY_MIN_MS = 250;
const DYNAMIC_DELAY_MAX_MS = 5_000;
const DYNAMIC_DELAY_DEFAULT_MS = 350;
const DYNAMIC_DELAY_LOW_REMAINING_THRESHOLD = 50;

interface RateLimitState {
  remaining: number | null;
  resetAtMs: number | null;
  retryAfterMs: number | null;
}

const rateLimitState: RateLimitState = {
  remaining: null,
  resetAtMs: null,
  retryAfterMs: null,
};

function parseIntegerHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function recordRateLimitHeaders(headers: Headers): void {
  const remaining = parseIntegerHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = parseIntegerHeader(headers, 'x-ratelimit-reset');
  const retryAfterSeconds = parseIntegerHeader(headers, 'retry-after');
  if (remaining !== null) rateLimitState.remaining = remaining;
  if (resetSeconds !== null) rateLimitState.resetAtMs = resetSeconds * 1_000;
  rateLimitState.retryAfterMs = retryAfterSeconds === null ? null : retryAfterSeconds * 1_000;
}

function computeDynamicDelayMs(): number {
  const { remaining, resetAtMs, retryAfterMs } = rateLimitState;

  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, DYNAMIC_DELAY_MAX_MS);
  }

  if (remaining === null || resetAtMs === null) {
    return DYNAMIC_DELAY_DEFAULT_MS;
  }

  const timeToResetMs = resetAtMs - Date.now();
  if (timeToResetMs <= 0) return DYNAMIC_DELAY_MIN_MS;

  if (remaining <= 0) {
    return Math.min(timeToResetMs, DYNAMIC_DELAY_MAX_MS);
  }

  const evenSpacingMs = Math.ceil(timeToResetMs / remaining);

  // When quota is plentiful, stay near the floor; when it's tight, slow down.
  const baseDelayMs =
    remaining > DYNAMIC_DELAY_LOW_REMAINING_THRESHOLD
      ? Math.max(DYNAMIC_DELAY_MIN_MS, Math.min(evenSpacingMs, DYNAMIC_DELAY_DEFAULT_MS))
      : evenSpacingMs;

  return Math.min(Math.max(baseDelayMs, DYNAMIC_DELAY_MIN_MS), DYNAMIC_DELAY_MAX_MS);
}

/**
 * Pre-request wait for a MUTATIVE (POST/PUT/PATCH/DELETE) GitHub call: the larger of the dynamic
 * primary-quota pacing and the {@link MUTATION_MIN_DELAY_MS} floor, PLUS a uniform-random jitter in
 * [{@link MUTATION_JITTER_MIN_MS}, {@link MUTATION_JITTER_MAX_MS}]. The jitter is what breaks the
 * regular write cadence that trips GitHub's secondary (abuse) rate limit — see the constant docs.
 * `random` is injectable (defaults to `Math.random`) solely so the jitter band is deterministically
 * unit-testable; every real run passes real randomness, so no two writes share an identical cadence.
 */
export function computeMutationDelayMs(
  dynamicDelayMs: number,
  random: () => number = Math.random,
): number {
  const flooredMs = Math.max(dynamicDelayMs, MUTATION_MIN_DELAY_MS);
  const jitterSpanMs = MUTATION_JITTER_MAX_MS - MUTATION_JITTER_MIN_MS;
  const jitterMs = MUTATION_JITTER_MIN_MS + Math.floor(random() * (jitterSpanMs + 1));
  return flooredMs + jitterMs;
}

/** Retry policy decision for a failed GitHub response — see {@link classifyRetry}. */
export interface RetryDecision {
  readonly retryable: boolean;
  readonly secondaryRateLimit: boolean;
  readonly waitMs: number;
  readonly maxRetries: number;
}

/**
 * Pure retry policy for a non-2xx GitHub response: whether to retry, how long to HOLD first, and
 * the per-error retry budget. A SECONDARY (abuse) rate limit — 429 OR 403 carrying a
 * "too many requests" / "secondary rate limit" body and no Retry-After — HOLDS a flat
 * {@link SECONDARY_RATE_LIMIT_HOLD_MS} (5 min) each attempt for up to
 * {@link SECONDARY_RATE_LIMIT_MAX_RETRIES} tries, so the run waits the penalty out ("hold for 5
 * minutes on error") instead of hammering it; every other retryable error (plain 429, 5xx) uses the
 * short escalating {@link RATE_LIMIT_BACKOFF_MS} schedule. The wait is never below the server's
 * Retry-After. A 403 without the abuse body stays non-retryable (it is a real permission error).
 */
export function classifyRetry(options: {
  readonly status: number;
  readonly responseText: string;
  readonly attempt: number;
  readonly retryAfterMs: number | null;
}): RetryDecision {
  const { status, responseText, attempt } = options;
  const retryAfterMs =
    options.retryAfterMs !== null && options.retryAfterMs > 0 ? options.retryAfterMs : 0;
  const secondaryRateLimit =
    (status === 429 || status === 403) &&
    /secondary rate limit|too many requests|abuse/i.test(responseText);
  const retryable = secondaryRateLimit || status === 429 || status >= 500;
  const maxRetries = secondaryRateLimit
    ? SECONDARY_RATE_LIMIT_MAX_RETRIES
    : RATE_LIMIT_BACKOFF_MS.length;
  const scheduledMs = secondaryRateLimit
    ? SECONDARY_RATE_LIMIT_HOLD_MS
    : (RATE_LIMIT_BACKOFF_MS[attempt] ??
      RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1] ??
      1_000);
  return { retryable, secondaryRateLimit, waitMs: Math.max(retryAfterMs, scheduledMs), maxRetries };
}

interface GitHubEnvironmentPublicKey {
  readonly key_id: string;
  readonly key: string;
}

interface GitHubEnvironmentVariablesResponse {
  readonly total_count: number;
  readonly variables: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
}

interface GitHubEnvironmentSecretsResponse {
  readonly total_count: number;
  readonly secrets: ReadonlyArray<{
    readonly name: string;
  }>;
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function getGitHubToken(): string {
  return execSync('gh auth token', { encoding: 'utf-8' }).trim();
}

function getRepositoryFullName(): string {
  return execSync('gh api repos/:owner/:repo --jq .full_name', {
    encoding: 'utf-8',
  }).trim();
}

function buildGitHubApiUrl(pathname: string): string {
  return `https://api.github.com/${pathname.replace(/^\/+/, '')}`;
}

async function requestGitHub<T>(
  token: string,
  label: string,
  pathname: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const isMutation = method !== 'GET';
  const dynamicDelayMs = computeDynamicDelayMs();
  // Writes are floored at MUTATION_MIN_DELAY_MS AND get randomized jitter (computeMutationDelayMs)
  // so the cadence is never a fixed burst pattern that trips GitHub's secondary (abuse) limit.
  const preRequestDelayMs = isMutation ? computeMutationDelayMs(dynamicDelayMs) : dynamicDelayMs;
  if (preRequestDelayMs > 0) {
    await sleep(preRequestDelayMs);
  }

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(buildGitHubApiUrl(pathname), {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    recordRateLimitHeaders(response.headers);

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    const responseText = await response.text();
    const decision = classifyRetry({
      status: response.status,
      responseText,
      attempt,
      retryAfterMs: rateLimitState.retryAfterMs,
    });
    if (!decision.retryable || attempt >= decision.maxRetries) {
      throw new GitHubApiError(
        response.status,
        `${label}: HTTP ${response.status} ${responseText}`,
      );
    }
    // A SECONDARY (abuse) limit resolves to a flat 5-minute HOLD (SECONDARY_RATE_LIMIT_HOLD_MS);
    // every other retryable error uses the short escalating backoff. "holding" mirrors the policy.
    console.warn(
      `  ! GitHub API throttled "${label}" — holding ${formatDuration(decision.waitMs)} ` +
        `(retry ${attempt + 1}/${decision.maxRetries})`,
    );
    await sleep(decision.waitMs);
  }
}

export interface SyncEnvironmentToGitHubOptions {
  readonly environment: string;
  readonly dryRun: boolean;
  readonly skipCreate?: boolean;
  readonly skipPreflight?: boolean;
  /**
   * Push variables that equal their env-schema default verbatim instead of skipping
   * and pruning them. Restores the pre-schema-default reconciliation behaviour.
   */
  readonly keepSchemaDefaults?: boolean;
}

interface EnvEntry {
  name: string;
  value: string;
}

/**
 * Classifies an env key as a GitHub Secret or Variable purely by name.
 *
 * @remarks
 * The `.env.example` section headers are for humans only — this strict, name-based rule is the
 * authority, so a key can never leak as a plaintext Variable because it was filed under the wrong
 * half. Also consumed by {@link planEnvironmentSyncPreview} so the `--diff` preview masks the same
 * keys the sync treats as secrets.
 */
function classifyKey(key: string): 'secret' | 'variable' {
  // Credential / signing material suffixes → Secret
  if (key.endsWith('_API_KEY')) return 'secret';
  if (key.endsWith('_SECRET_KEY')) return 'secret';
  if (key.endsWith('_WEBHOOK_SECRET')) return 'secret';
  if (key.endsWith('_PRIVATE_KEY')) return 'secret';
  if (key.endsWith('_ACCESS_KEY_ID')) return 'secret';
  if (key.endsWith('_SECRET_ACCESS_KEY')) return 'secret';
  if (key.endsWith('_ENCRYPTION_KEY')) return 'secret';
  if (key.endsWith('_TOKEN')) return 'secret';
  if (key.endsWith('_DSN')) return 'secret';
  // Deploy-provider service / workspace IDs (e.g. RAILWAY_SERVICE_ID,
  // RAILWAY_WORKER_SERVICE_ID, POSTMAN_WORKSPACE_ID) are read via `secrets.*`
  // in workflows, so they ship as Secrets, not Variables.
  if (key.endsWith('_SERVICE_ID')) return 'secret';
  if (key.endsWith('_WORKSPACE_ID')) return 'secret';

  // Connection strings with embedded credentials → Secret
  if (key === 'DATABASE_URL' || key === 'DATABASE_MIGRATION_URL') return 'secret';
  if (key === 'DATABASE_MAINTENANCE_URL') return 'secret';
  if (key === 'DATABASE_OPERATOR_URL') return 'secret';
  if (key === 'REDIS_URL' || key === 'REDIS_BULLMQ_URL') return 'secret';

  // Auth secrets → Secret
  if (key === 'JWT_SECRET') return 'secret';
  if (key.endsWith('_CLIENT_SECRET')) return 'secret';
  if (key === 'CAPTCHA_SECRET') return 'secret';

  // Everything else → Variable (public ids, knobs, flags, URLs, keys with _PUBLIC_KEY, etc.)
  return 'variable';
}

/**
 * Flat parser — reads all KEY=VALUE pairs into their LOGICAL runtime values
 * via `dotenv.parse`, which strips quotes, decodes `\n`/`\"`/`\\` escapes,
 * and reassembles multi-line single-quoted blocks (PEM keys).
 *
 * Pushing the raw post-`=` text (including literal quotes) is incorrect for
 * GitHub Environment Variables — GitHub stores the value verbatim, so a
 * cron expression written locally as `KEY="0 3 * * *"` would land in GitHub
 * as the literal `"0 3 * * *"` with surrounding quotes and would also fail
 * the value-diff check on the next sync.
 */
/**
 * Reads every key DECLARED in the env file, blank values included.
 *
 * @remarks
 * Blank entries are retained deliberately: they must still register as locally declared so the
 * stale-detection pass does not treat them as removed and delete the live remote value. Callers
 * filter to non-blank entries for the push list.
 */
function parseEnvFile(filePath: string): EnvEntry[] {
  return parseEnvContents(readFileSync(filePath, 'utf-8'));
}

/**
 * Parses env-file contents into every DECLARED entry, blank values included.
 *
 * @remarks
 * Split from {@link parseEnvFile} so the reconciliation rules are testable without touching disk.
 */
export function parseEnvContents(contents: string): EnvEntry[] {
  return Object.entries(dotenv.parse(contents)).map(([name, value]) => ({ name, value }));
}

/**
 * Splits declared entries into the ones to push, the ones left blank, and the ones
 * whose value equals their env-schema default.
 *
 * @remarks
 * Three disjoint buckets:
 *   - `blank` — `KEY=` with an empty value. Pushed to nobody but stays DECLARED (see
 *     {@link findStaleRemoteKeys}); "not managed here", so the remote value is preserved.
 *   - `schemaDefault` — a VARIABLE (never a secret) whose value string-equals its
 *     {@link envSchemaDefaults} entry. Not pushed AND intentionally treated as
 *     not-declared by the caller so the prune removes any stale remote copy — the
 *     runtime falls back to the identical default. Suppressed when `keepSchemaDefaults`
 *     is set, which routes these back into `pushable` (legacy push-everything behaviour).
 *   - `pushable` — everything else (all secrets, and variables that override a default).
 *
 * `schemaDefaults` is injectable for tests; it defaults to the real {@link envSchemaDefaults}.
 */
export function splitDeclaredEntries(
  declared: readonly EnvEntry[],
  options: {
    readonly schemaDefaults?: Readonly<Record<string, string>>;
    readonly keepSchemaDefaults?: boolean;
  } = {},
): {
  pushable: EnvEntry[];
  blank: EnvEntry[];
  schemaDefault: EnvEntry[];
} {
  const schemaDefaults = options.schemaDefaults ?? envSchemaDefaults;
  const pushable: EnvEntry[] = [];
  const blank: EnvEntry[] = [];
  const schemaDefault: EnvEntry[] = [];

  for (const entry of declared) {
    if (entry.value === '') {
      blank.push(entry);
      continue;
    }
    const equalsSchemaDefault =
      !options.keepSchemaDefaults &&
      classifyKey(entry.name) === 'variable' &&
      schemaDefaults[entry.name] === entry.value;
    if (equalsSchemaDefault) {
      schemaDefault.push(entry);
      continue;
    }
    pushable.push(entry);
  }

  return { pushable, blank, schemaDefault };
}

/**
 * Returns the remote keys that no longer exist in the local file and must be deleted.
 *
 * @remarks
 * `declaredNames` MUST include blank-valued keys. Filtering blanks out upstream makes a blanked key
 * look absent, so this reports it stale and the caller deletes a live secret — the opposite of the
 * documented contract. Only a removed LINE marks a key stale.
 */
export function findStaleRemoteKeys(options: {
  declaredNames: ReadonlySet<string>;
  remoteKeys: readonly string[];
}): string[] {
  return options.remoteKeys.filter((name) => !options.declaredNames.has(name));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

function padIndex(index: number, total: number): string {
  return String(index).padStart(String(total).length, ' ');
}

async function createGitHubEnvironment(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<void> {
  await requestGitHub<void>(
    token,
    `create env ${environment}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}`,
    { method: 'PUT' },
  );
}

async function githubEnvironmentExists(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<boolean> {
  try {
    await requestGitHub<unknown>(
      token,
      `probe env ${environment}`,
      `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}`,
    );
    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

async function ensureGitHubEnvironment(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<void> {
  if (await githubEnvironmentExists(token, repositoryFullName, environment)) {
    console.log(`GitHub environment "${environment}" already exists; skipping create.`);
    return;
  }
  console.log(`Creating GitHub environment "${environment}"...`);
  await createGitHubEnvironment(token, repositoryFullName, environment);
}

async function getEnvironmentPublicKey(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<GitHubEnvironmentPublicKey> {
  return requestGitHub<GitHubEnvironmentPublicKey>(
    token,
    `fetch public key for ${environment}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets/public-key`,
  );
}

async function fetchExistingSecrets(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    for (let page = 1; page <= MAX_ENVIRONMENT_PAGES; page += 1) {
      const response = await requestGitHub<GitHubEnvironmentSecretsResponse>(
        token,
        `fetch secrets for ${environment} (page ${page})`,
        `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets?per_page=${ENVIRONMENT_ITEMS_PER_PAGE}&page=${page}`,
      );
      for (const secret of response.secrets) names.add(secret.name);
      // Terminate on total_count (not page length): the endpoint silently clamps per_page to 30,
      // so a "full" page can be shorter than requested — length-based stops would end early.
      if (response.secrets.length === 0 || names.size >= response.total_count) break;
    }
    return names;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return new Set();
    }
    throw error;
  }
}

async function fetchExistingVariables(
  token: string,
  repositoryFullName: string,
  environment: string,
): Promise<Map<string, string>> {
  const variables = new Map<string, string>();
  try {
    for (let page = 1; page <= MAX_ENVIRONMENT_PAGES; page += 1) {
      const response = await requestGitHub<GitHubEnvironmentVariablesResponse>(
        token,
        `fetch variables for ${environment} (page ${page})`,
        `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables?per_page=${ENVIRONMENT_ITEMS_PER_PAGE}&page=${page}`,
      );
      for (const entry of response.variables) variables.set(entry.name, entry.value);
      // Terminate on total_count (not page length): the endpoint silently clamps per_page to 30,
      // so a "full" page can be shorter than requested — length-based stops would end early.
      if (response.variables.length === 0 || variables.size >= response.total_count) break;
    }
    return variables;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return new Map();
    }
    throw error;
  }
}

async function setSecret(
  token: string,
  repositoryFullName: string,
  environment: string,
  publicKey: GitHubEnvironmentPublicKey,
  name: string,
  value: string,
): Promise<void> {
  await sodium.ready;
  const encryptedValue = sodium.to_base64(
    sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
    ),
    sodium.base64_variants.ORIGINAL,
  );
  await requestGitHub<void>(
    token,
    `set secret ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(name)}`,
    {
      method: 'PUT',
      body: {
        encrypted_value: encryptedValue,
        key_id: publicKey.key_id,
      },
    },
  );
}

async function deleteSecret(
  token: string,
  repositoryFullName: string,
  environment: string,
  name: string,
): Promise<void> {
  await requestGitHub<void>(
    token,
    `delete secret ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

async function deleteVariable(
  token: string,
  repositoryFullName: string,
  environment: string,
  name: string,
): Promise<void> {
  await requestGitHub<void>(
    token,
    `delete variable ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

async function setVariable(
  token: string,
  repositoryFullName: string,
  environment: string,
  existingVariables: Map<string, string>,
  name: string,
  value: string,
): Promise<'created' | 'updated' | 'skipped'> {
  const existingValue = existingVariables.get(name);
  if (existingValue === value) return 'skipped';

  if (existingValue === undefined) {
    try {
      await requestGitHub<void>(
        token,
        `create variable ${name}`,
        `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables`,
        {
          method: 'POST',
          body: { name, value },
        },
      );
      return 'created';
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 409) {
        throw error;
      }
    }
  }

  await requestGitHub<void>(
    token,
    `update variable ${name}`,
    `repos/${repositoryFullName}/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      body: { name, value },
    },
  );
  return 'updated';
}

export interface SyncEnvironmentResult {
  pushed: number;
  /** Variables whose remote value already matched — no API write needed. */
  unchanged: number;
  /** Keys declared in the local file but left blank — neither pushed nor deleted. */
  emptySkipped: number;
  deleted: number;
  /** Variables equal to their env-schema default — not pushed; pruned from remote if present. */
  schemaDefaultSkipped: number;
}

/**
 * Full reconciliation of a single GitHub Environment against its local
 * .env.<environment> file. The file is the source of truth:
 *   - Push all secrets and variables from the file.
 *   - Delete any secret or variable on GitHub that is NOT in the file.
 */
export async function syncEnvironmentToGitHub(
  options: SyncEnvironmentToGitHubOptions,
): Promise<SyncEnvironmentResult> {
  const {
    environment,
    dryRun,
    skipCreate = false,
    skipPreflight = false,
    keepSchemaDefaults = false,
  } = options;
  const envFilePath = resolve(projectRoot, `.env.${environment}`);

  if (!existsSync(envFilePath)) {
    throw new Error(
      `Missing .env.${environment} at the repo root. Run \`pnpm setup:github\` without --dry-run to scaffold it from setup.config.json.`,
    );
  }

  const declaredEntries = parseEnvFile(envFilePath);
  const {
    pushable: pushableEntries,
    blank: blankEntries,
    schemaDefault: schemaDefaultEntries,
  } = splitDeclaredEntries(declaredEntries, { keepSchemaDefaults });
  const secrets = pushableEntries.filter((e) => classifyKey(e.name) === 'secret');
  const variables = pushableEntries.filter((e) => classifyKey(e.name) === 'variable');

  // Stale-detection uses DECLARED names (blank included) so blanking a value never
  // deletes the live remote item — only deleting the key's line does. Schema-default
  // variables are the deliberate exception: they are EXCLUDED from the declared set so
  // the prune removes any stale remote copy and the runtime falls back to the identical
  // default (secrets never qualify as schema-default — see splitDeclaredEntries).
  const schemaDefaultNames = new Set(schemaDefaultEntries.map((e) => e.name));
  const localSecretNames = new Set(
    declaredEntries.filter((e) => classifyKey(e.name) === 'secret').map((e) => e.name),
  );
  const localVariableNames = new Set(
    declaredEntries
      .filter((e) => classifyKey(e.name) === 'variable' && !schemaDefaultNames.has(e.name))
      .map((e) => e.name),
  );

  console.log(`Source:      .env.${environment}`);
  console.log(`Environment: ${environment}`);
  console.log(`Plan:        ${secrets.length} secret(s), ${variables.length} variable(s)`);
  if (blankEntries.length > 0) {
    console.log(
      `Blank:       ${blankEntries.length} declared but empty — not pushed, remote preserved`,
    );
    for (const entry of blankEntries) {
      console.log(`  [empty]    ${entry.name}`);
    }
  }
  if (schemaDefaultEntries.length > 0) {
    console.log(
      `Default:     ${schemaDefaultEntries.length} equal the env-schema default — not pushed, pruned from remote (runtime uses the default)`,
    );
    for (const entry of schemaDefaultEntries) {
      console.log(`  [default]  ${entry.name}=${entry.value}`);
    }
  }
  console.log('');

  if (dryRun) {
    for (const entry of secrets) console.log(`  [secret]   ${entry.name}`);
    for (const entry of variables) console.log(`  [variable] ${entry.name}`);
    for (const entry of schemaDefaultEntries) {
      console.log(`  [default]  ${entry.name} (equals schema default — not pushed, pruned)`);
    }
    console.log('');
    console.log('Dry run — no API calls made. Drop --dry-run to push.');
    return {
      pushed: 0,
      unchanged: 0,
      emptySkipped: blankEntries.length,
      deleted: 0,
      schemaDefaultSkipped: schemaDefaultEntries.length,
    };
  }

  const repositoryFullName = getRepositoryFullName();

  if (!skipPreflight && process.env.GITHUB_SYNC_PARENT !== '1') {
    await runGhAuthPreflight({
      repository: repositoryFullName,
      purpose: `Push secrets and variables to GitHub Environment "${environment}"`,
      destructive: true,
    });
  }

  const token = getGitHubToken();
  if (!skipCreate) {
    await ensureGitHubEnvironment(token, repositoryFullName, environment);
  }
  const publicKey = await getEnvironmentPublicKey(token, repositoryFullName, environment);
  const existingSecrets = await fetchExistingSecrets(token, repositoryFullName, environment);
  const existingVariables = await fetchExistingVariables(token, repositoryFullName, environment);

  // ── Push secrets (always, can't diff) ──────────────────────────────────
  const pushTotal = secrets.length + variables.length;
  console.log(`Pushing ${pushTotal} item(s) through the GitHub REST API`);
  console.log(
    '(Variables with unchanged values are left alone; secrets are always re-encrypted and pushed).',
  );
  console.log('');

  const startTime = Date.now();
  let processed = 0;
  let pushed = 0;
  let unchanged = 0;

  const push = async (
    kind: 'secret' | 'variable',
    name: string,
    action: () => Promise<'created' | 'updated' | 'skipped' | 'pushed'>,
  ): Promise<void> => {
    const itemStart = Date.now();
    const status = await action();
    const itemDuration = Date.now() - itemStart;

    processed += 1;
    if (status !== 'skipped') pushed += 1;
    else unchanged += 1;

    const remaining = pushTotal - processed;
    const elapsed = Date.now() - startTime;
    const averagePerItem = elapsed / processed;
    const estimatedRemaining = Math.round(averagePerItem * remaining);
    const indexLabel = `${padIndex(processed, pushTotal)}/${pushTotal}`;
    const kindLabel = kind === 'secret' ? '[secret]  ' : '[variable]';

    const quotaLabel =
      rateLimitState.remaining !== null ? `, quota ${rateLimitState.remaining}` : '';

    console.log(
      `  ${indexLabel}  ${kindLabel} ${name}  (` +
        `${status}, took ${formatDuration(itemDuration)}, ${remaining} left, ` +
        `ETA ${formatDuration(estimatedRemaining)}${quotaLabel})`,
    );
  };

  for (const entry of secrets) {
    await push('secret', entry.name, async () => {
      await setSecret(token, repositoryFullName, environment, publicKey, entry.name, entry.value);
      return 'pushed';
    });
  }
  for (const entry of variables) {
    await push('variable', entry.name, async () => {
      return setVariable(
        token,
        repositoryFullName,
        environment,
        existingVariables,
        entry.name,
        entry.value,
      );
    });
  }

  // ── Delete stale items (on GitHub but NOT in local file with same kind) ──
  //
  // This covers two cases in a single pass:
  //   1. Item removed from the local .env file (true stale).
  //   2. Item re-classified across kinds, or pushed as the wrong kind by an
  //      older setup-infra version (e.g. ALLOWED_ORIGINS pushed as a Secret
  //      previously, now correctly classified as a Variable). The Secret is
  //      no longer in localSecretNames, so it gets pruned here while the
  //      Variable is created above — no duplicate left behind.
  const staleSecrets = findStaleRemoteKeys({
    declaredNames: localSecretNames,
    remoteKeys: [...existingSecrets],
  });
  const staleVariables = findStaleRemoteKeys({
    declaredNames: localVariableNames,
    remoteKeys: [...existingVariables.keys()],
  });
  const crossKindDuplicates = new Set<string>([
    ...staleSecrets.filter((name) => localVariableNames.has(name)),
    ...staleVariables.filter((name) => localSecretNames.has(name)),
  ]);
  const deleteTotal = staleSecrets.length + staleVariables.length;

  let deleted = 0;

  if (deleteTotal > 0) {
    console.log('');
    console.log(`Pruning ${deleteTotal} stale item(s) from GitHub...`);
    if (crossKindDuplicates.size > 0) {
      console.log(
        `  (${crossKindDuplicates.size} of these are cross-kind duplicates from an older sync-tool version)`,
      );
    }

    for (const name of staleSecrets) {
      try {
        await deleteSecret(token, repositoryFullName, environment, name);
        deleted += 1;
        const note = crossKindDuplicates.has(name) ? ' (now a variable)' : '';
        console.log(`  [deleted]  secret ${name}${note}`);
      } catch (deleteError) {
        const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.error(`  [error]    secret ${name}: ${msg}`);
      }
    }

    for (const name of staleVariables) {
      try {
        await deleteVariable(token, repositoryFullName, environment, name);
        deleted += 1;
        const note = crossKindDuplicates.has(name)
          ? ' (now a secret)'
          : schemaDefaultNames.has(name)
            ? ' (equals schema default)'
            : '';
        console.log(`  [deleted]  variable ${name}${note}`);
      } catch (deleteError) {
        const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.error(`  [error]    variable ${name}: ${msg}`);
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  console.log('');
  console.log(
    `Done. Pushed ${pushed}, unchanged ${unchanged}, empty ${blankEntries.length}, ` +
      `schema-default ${schemaDefaultEntries.length}, deleted ${deleted} in ${formatDuration(totalDuration)}.`,
  );
  console.log('Verify: pnpm github:sync --check');

  return {
    pushed,
    unchanged,
    emptySkipped: blankEntries.length,
    deleted,
    schemaDefaultSkipped: schemaDefaultEntries.length,
  };
}

/** Sentinel shown in place of a secret value in the read-only preview — secret values are never printed. */
const PREVIEW_SECRET_MASK = '••••';

/**
 * The reconciliation decision `github:sync` would take for one key — the unit the `--diff` preview renders.
 *
 * @remarks
 * Mirrors the buckets {@link syncEnvironmentToGitHub} acts on: `skip+prune`/`skip` are the
 * schema-default outcomes, `create`/`update`/`unchanged` the variable outcomes, `secret`/`secret-create`
 * the always-pushed secrets, `blank` the preserved empties, and `prune-stale` a remote key with no local line.
 */
export type SyncDecision =
  | 'blank'
  | 'secret'
  | 'secret-create'
  | 'skip+prune'
  | 'skip'
  | 'create'
  | 'unchanged'
  | 'update'
  | 'prune-stale';

/** One row of the `github:sync --diff` preview — a key with its schema default, local value, remote value, and decision. */
export interface SyncPreviewRow {
  readonly name: string;
  readonly kind: 'secret' | 'variable' | 'blank';
  readonly schemaDefault: string | null;
  readonly local: string;
  readonly remote: string;
  readonly decision: SyncDecision;
}

/**
 * Computes, per declared key, the exact decision `github:sync` would make against a given remote —
 * the pure core of the `--diff` preview. No I/O.
 *
 * @remarks
 * Reuses {@link splitDeclaredEntries}, {@link classifyKey}, and {@link findStaleRemoteKeys} so the
 * preview can never drift from what {@link syncEnvironmentToGitHub} actually does. Secret values are
 * replaced with {@link PREVIEW_SECRET_MASK} and never surfaced. A schema-default variable that is on
 * the remote is reported once as `skip+prune` (the sync deletes it via the stale path); only a remote
 * key with NO local line is reported as `prune-stale`.
 */
export function planEnvironmentSyncPreview(options: {
  readonly declared: readonly EnvEntry[];
  readonly remoteVariables: ReadonlyMap<string, string>;
  readonly remoteSecretNames: ReadonlySet<string>;
  readonly schemaDefaults?: Readonly<Record<string, string>>;
  readonly keepSchemaDefaults?: boolean;
}): SyncPreviewRow[] {
  const { declared, remoteVariables, remoteSecretNames } = options;
  const schemaDefaults = options.schemaDefaults ?? envSchemaDefaults;
  const { blank, schemaDefault } = splitDeclaredEntries(declared, {
    schemaDefaults,
    keepSchemaDefaults: options.keepSchemaDefaults ?? false,
  });
  const blankNames = new Set(blank.map((entry) => entry.name));
  const schemaDefaultNames = new Set(schemaDefault.map((entry) => entry.name));
  const declaredNames = new Set(declared.map((entry) => entry.name));
  const remoteHas = (key: string) => remoteVariables.has(key) || remoteSecretNames.has(key);

  const rows: SyncPreviewRow[] = [];
  for (const { name, value } of declared) {
    const secret = classifyKey(name) === 'secret';
    const onRemote = remoteHas(name);
    let decision: SyncDecision;
    if (blankNames.has(name)) decision = 'blank';
    else if (schemaDefaultNames.has(name)) decision = onRemote ? 'skip+prune' : 'skip';
    else if (secret) decision = onRemote ? 'secret' : 'secret-create';
    else if (!onRemote) decision = 'create';
    else decision = remoteVariables.get(name) === value ? 'unchanged' : 'update';
    rows.push({
      name,
      kind: value === '' ? 'blank' : secret ? 'secret' : 'variable',
      schemaDefault: secret ? null : (schemaDefaults[name] ?? null),
      local: value === '' ? '' : secret ? PREVIEW_SECRET_MASK : value,
      remote: secret ? (onRemote ? PREVIEW_SECRET_MASK : '') : (remoteVariables.get(name) ?? ''),
      decision,
    });
  }

  // Remote keys with NO local line → pruned as stale. Mirror the caller's kind-split; schema-default
  // names are already emitted above as skip+prune, so filter anything still declared to avoid a
  // duplicate row.
  const localSecretNames = new Set(
    declared.filter((entry) => classifyKey(entry.name) === 'secret').map((entry) => entry.name),
  );
  const localVariableNames = new Set(
    declared
      .filter(
        (entry) => classifyKey(entry.name) === 'variable' && !schemaDefaultNames.has(entry.name),
      )
      .map((entry) => entry.name),
  );
  const staleVariables = findStaleRemoteKeys({
    declaredNames: localVariableNames,
    remoteKeys: [...remoteVariables.keys()],
  }).filter((name) => !declaredNames.has(name));
  const staleSecrets = findStaleRemoteKeys({
    declaredNames: localSecretNames,
    remoteKeys: [...remoteSecretNames],
  }).filter((name) => !declaredNames.has(name));
  for (const name of staleVariables)
    rows.push({
      name,
      kind: 'variable',
      schemaDefault: schemaDefaults[name] ?? null,
      local: '',
      remote: remoteVariables.get(name) ?? '',
      decision: 'prune-stale',
    });
  for (const name of staleSecrets)
    rows.push({
      name,
      kind: 'secret',
      schemaDefault: null,
      local: '',
      remote: PREVIEW_SECRET_MASK,
      decision: 'prune-stale',
    });

  return rows;
}

/** Decision sort order for the preview table — the outcomes that CHANGE remote state come first. */
const PREVIEW_DECISION_ORDER: readonly SyncDecision[] = [
  'prune-stale',
  'update',
  'skip+prune',
  'create',
  'secret-create',
  'skip',
  'unchanged',
  'secret',
  'blank',
];

/** Renders {@link planEnvironmentSyncPreview} rows as an aligned, column-wise text table plus a per-decision count summary. */
export function formatSyncPreviewTable(options: {
  readonly rows: readonly SyncPreviewRow[];
  readonly environment: string;
}): string {
  const { rows, environment } = options;
  const columns: ReadonlyArray<{
    readonly header: string;
    readonly width: number;
    readonly value: (row: SyncPreviewRow) => string;
  }> = [
    { header: 'VARIABLE', width: 44, value: (row) => row.name },
    { header: 'KIND', width: 8, value: (row) => row.kind },
    { header: 'DEFAULT', width: 16, value: (row) => row.schemaDefault ?? '—' },
    { header: 'LOCAL', width: 20, value: (row) => row.local || '""' },
    { header: 'REMOTE', width: 20, value: (row) => row.remote || '—' },
    { header: 'DECISION', width: 14, value: (row) => row.decision },
  ];
  const cell = (text: string, width: number) => {
    const clean = text.replace(/\s+/g, ' ');
    return (clean.length > width ? `${clean.slice(0, width - 1)}…` : clean).padEnd(width);
  };
  const rank = (decision: SyncDecision) => {
    const index = PREVIEW_DECISION_ORDER.indexOf(decision);
    return index === -1 ? PREVIEW_DECISION_ORDER.length : index;
  };
  const sorted = [...rows].sort(
    (a, b) => rank(a.decision) - rank(b.decision) || a.name.localeCompare(b.name),
  );

  const lines = [
    `github:sync ${environment} — preview (read-only, no changes made)`,
    columns.map((column) => cell(column.header, column.width)).join('  '),
    columns.map((column) => '-'.repeat(column.width)).join('  '),
    ...sorted.map((row) =>
      columns.map((column) => cell(column.value(row), column.width)).join('  '),
    ),
  ];

  const counts = new Map<SyncDecision, number>();
  for (const row of rows) counts.set(row.decision, (counts.get(row.decision) ?? 0) + 1);
  const summary = PREVIEW_DECISION_ORDER.filter((decision) => counts.has(decision))
    .map((decision) => `${decision}=${counts.get(decision)}`)
    .join('  ');
  lines.push('', `total=${rows.length}  ${summary}`);
  return lines.join('\n');
}

/**
 * Read-only preview: reads `.env.<environment>`, fetches the live GitHub Environment (fully paginated),
 * and returns the per-key {@link SyncPreviewRow} decisions `github:sync` would make — writing nothing.
 */
export async function previewEnvironmentSync(options: {
  readonly environment: string;
  readonly keepSchemaDefaults?: boolean;
}): Promise<SyncPreviewRow[]> {
  const envFilePath = resolve(projectRoot, `.env.${options.environment}`);
  if (!existsSync(envFilePath)) {
    throw new Error(`Missing .env.${options.environment} at the repo root.`);
  }
  const declared = parseEnvFile(envFilePath);
  const token = getGitHubToken();
  const repositoryFullName = getRepositoryFullName();
  const [remoteVariables, remoteSecretNames] = await Promise.all([
    fetchExistingVariables(token, repositoryFullName, options.environment),
    fetchExistingSecrets(token, repositoryFullName, options.environment),
  ]);
  return planEnvironmentSyncPreview({
    declared,
    remoteVariables,
    remoteSecretNames,
    keepSchemaDefaults: options.keepSchemaDefaults ?? false,
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: pnpm github:sync <environment> [--dry-run] [--no-create] [--keep-schema-defaults]',
    );
    console.log('       pnpm github:sync --all [--dry-run]');
    console.log('');
    console.log(
      '  --keep-schema-defaults  Push variables equal to their env-schema default instead of',
    );
    console.log('                          skipping and pruning them (legacy push-everything).');
    process.exit(0);
  }

  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const skipCreate = argv.includes('--no-create');
  const keepSchemaDefaults = argv.includes('--keep-schema-defaults');
  const env = argv.find((a) => !a.startsWith('--') && a !== '-n');

  if (!env) {
    console.error('Missing required argument: <environment>');
    console.error('Usage: pnpm github:sync <environment> [--dry-run] [--no-create]');
    process.exit(2);
  }

  await syncEnvironmentToGitHub({ environment: env, dryRun, skipCreate, keepSchemaDefaults });
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
