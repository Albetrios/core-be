import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type LockHolder = { pid: number; startedAt: string; command: string };

/** Re-entrancy for one Vitest process: several projects share one `globalSetup`. */
let lockPathHeldByThisProcess: string | null = null;

/**
 * Lock path, keyed on the database this run will use.
 *
 * @remarks
 * Two runs against two DIFFERENT databases cannot corrupt each other, so they must not block
 * each other either — keying on the URL is what keeps this from being a nuisance. The hash keeps
 * credentials out of a world-readable filename in the shared temp directory.
 */
function resolveLockPath(): string {
  const databaseUrl = process.env.DATABASE_URL ?? 'unset';
  const fingerprint = createHash('sha256').update(databaseUrl).digest('hex').slice(0, 12);
  return join(tmpdir(), `core-be-test-database-${fingerprint}.lock`);
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as LockHolder;
  } catch {
    return null;
  }
}

/** `kill(pid, 0)` signals nothing — it only asks whether the process is still there. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function describeAge(startedAt: string): string {
  const elapsedMinutes = Math.round((Date.now() - Date.parse(startedAt)) / 60_000);
  if (!Number.isFinite(elapsedMinutes)) return 'unknown';
  return elapsedMinutes < 1 ? 'under a minute ago' : `${String(elapsedMinutes)}m ago`;
}

function buildConflictMessage(lockPath: string, holder: LockHolder): string {
  return [
    '',
    'Another test run is already using this database.',
    '',
    `  lock      ${lockPath}`,
    `  held by   pid ${String(holder.pid)}, started ${describeAge(holder.startedAt)}`,
    `  command   ${holder.command}`,
    '',
    'Two runs against one Postgres corrupt each other. `fileParallelism: false` serialises files',
    "WITHIN a run, not across runs — so one run's `TRUNCATE ... RESTART IDENTITY` lands between",
    "another's fixture inserts. The symptom is a foreign-key violation (SQLSTATE 23503) in a test",
    'that passes fine on its own, plus a wall-clock several times the normal one.',
    '',
    'Wait for that run to finish, or stop it. If the process is already gone, delete the lock file.',
    '',
  ].join('\n');
}

/**
 * Claims exclusive use of the test database for this process, or fails fast explaining why not.
 *
 * @remarks
 * - **Algorithm:** atomic `writeFileSync(..., { flag: 'wx' })`. On `EEXIST`, read the holder: a
 *   dead pid means a crashed run left the file behind, so take it over; a live pid that is not us
 *   is a real conflict and throws; our own pid is re-entrant (several Vitest projects share one
 *   `globalSetup`).
 * - **Failure modes:** throws only on a genuine conflict. Any other filesystem error is swallowed
 *   and the run proceeds unguarded — a broken guard must never be the reason a test suite cannot
 *   run.
 * - **Side effects:** one file in the OS temp directory, removed by the returned release.
 * - **Notes:** this exists because the failure it prevents does not look like itself. A concurrent
 *   run surfaces as a foreign-key violation inside an unrelated suite, which reads as a
 *   regression in the code under test; it cost two separate debugging rounds before being
 *   recognised. Fail fast with the explanation instead.
 */
export function acquireDatabaseSuiteLock(): () => void {
  const lockPath = resolveLockPath();
  if (lockPathHeldByThisProcess === lockPath) return () => {};

  const holder: LockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: process.argv.slice(1).join(' ').slice(0, 200),
  };

  for (const attempt of ['first', 'after-clearing-stale'] as const) {
    try {
      writeFileSync(lockPath, JSON.stringify(holder), { flag: 'wx' });
      lockPathHeldByThisProcess = lockPath;
      return () => releaseDatabaseSuiteLock(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return () => {};

      const existing = readHolder(lockPath);
      if (existing && existing.pid === process.pid) {
        lockPathHeldByThisProcess = lockPath;
        return () => releaseDatabaseSuiteLock(lockPath);
      }
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(buildConflictMessage(lockPath, existing));
      }
      if (attempt === 'after-clearing-stale') return () => {};
      // Unreadable or owned by a dead process — a crashed run, not a live one.
      try {
        unlinkSync(lockPath);
      } catch {
        return () => {};
      }
    }
  }
  return () => {};
}

/**
 * Releases the lock, but only if this process still owns it.
 *
 * @remarks
 * - **Algorithm:** re-read the holder and delete only on a pid match, so a run that took over a
 *   stale lock cannot delete the lock of whoever wrote it next.
 * - **Failure modes:** every error swallowed; a leaked lock is cleared by the next run's
 *   stale-pid check.
 * - **Side effects:** removes the lock file.
 */
function releaseDatabaseSuiteLock(lockPath: string): void {
  lockPathHeldByThisProcess = null;
  try {
    if (!existsSync(lockPath)) return;
    const holder = readHolder(lockPath);
    if (holder && holder.pid !== process.pid) return;
    unlinkSync(lockPath);
  } catch {
    // Nothing to do — the next run's stale-pid check clears it.
  }
}
