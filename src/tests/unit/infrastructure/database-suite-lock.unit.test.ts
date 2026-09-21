import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDatabaseSuiteLock } from '@/tests/database-suite-lock.js';

const TEST_DATABASE_URL = 'postgresql://lock-spec@localhost:5432/lock-spec';

function lockPathFor(databaseUrl: string): string {
  const fingerprint = createHash('sha256').update(databaseUrl).digest('hex').slice(0, 12);
  return join(tmpdir(), `core-be-test-database-${fingerprint}.lock`);
}

/** A pid that cannot be running: the kernel rejects it, so `kill(pid, 0)` always throws ESRCH. */
const IMPOSSIBLE_PID = 2_147_483_646;

describe('database suite lock', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const lockPath = lockPathFor(TEST_DATABASE_URL);

  beforeEach(() => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    if (existsSync(lockPath)) unlinkSync(lockPath);
  });

  afterEach(() => {
    if (existsSync(lockPath)) unlinkSync(lockPath);
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('claims the lock and releases it', () => {
    const release = acquireDatabaseSuiteLock();
    expect(existsSync(lockPath)).toBe(true);

    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses when a live process already holds it, and says what to do', () => {
    // `process.pid` is alive by definition and is not us only because we claim otherwise — so
    // borrow the parent pid, which is alive and genuinely different.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.ppid,
        startedAt: new Date().toISOString(),
        command: 'vitest run --project integration',
      }),
    );

    expect(() => acquireDatabaseSuiteLock()).toThrow(/Another test run is already using/);
    // The message is the entire point: the failure it prevents surfaces as an unrelated
    // foreign-key violation, so the error has to name that symptom or nobody connects the two.
    expect(() => acquireDatabaseSuiteLock()).toThrow(/23503/);
    expect(() => acquireDatabaseSuiteLock()).toThrow(/vitest run --project integration/);
  });

  it('takes over a lock left behind by a crashed run', () => {
    // A killed run cannot clean up after itself. If a dead pid blocked the next run, one crash
    // would wedge the suite until someone found the file — worse than the problem being solved.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: IMPOSSIBLE_PID,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        command: 'vitest run',
      }),
    );

    const release = acquireDatabaseSuiteLock();
    const holder = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(holder.pid).toBe(process.pid);
    release();
  });

  it('is re-entrant within one process', () => {
    // Several Vitest projects share one `globalSetup`, so a run can claim the same lock twice.
    const releaseFirst = acquireDatabaseSuiteLock();
    expect(() => acquireDatabaseSuiteLock()).not.toThrow();
    releaseFirst();
  });

  it('does not block a run against a different database', () => {
    // Two runs on two databases cannot corrupt each other, so they must not block each other —
    // otherwise the guard becomes a nuisance people disable.
    const release = acquireDatabaseSuiteLock();

    process.env.DATABASE_URL = 'postgresql://other@localhost:5432/other';
    const otherLockPath = lockPathFor(process.env.DATABASE_URL);
    try {
      expect(() => acquireDatabaseSuiteLock()).not.toThrow();
    } finally {
      if (existsSync(otherLockPath)) unlinkSync(otherLockPath);
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      release();
    }
  });

  it('never leaves a run unable to start when the lock file is unreadable', () => {
    // A guard that cannot parse its own state must yield, not wedge the suite.
    writeFileSync(lockPath, 'not json');
    expect(() => acquireDatabaseSuiteLock()).not.toThrow();
  });
});
