import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAOS_POSTGRES_PROXY_NAME } from '@/tests/chaos/chaos.constants.js';
import { withTemporaryListeningProxyToxinForChaosAssertion } from '@/tests/chaos/helpers/toxiproxy.client.js';

/**
 * A COLD pool under a connect-time fault. A warm pool fails fast — its open connection errors within
 * milliseconds — but with no connection open, postgres.js keeps reconnecting while the transaction
 * waits, for as long as the fault lasts. Without a deadline the unit of work outlives any request
 * timeout and then commits once the database is back — after the client was told it failed.
 *
 * Each case imports the context module into a fresh module graph, which builds a new pool (cold, no
 * connection yet) and re-reads the environment (so the deadline under test applies).
 */
const ACQUIRE_DEADLINE_MS = 1_500;
const USER_PUBLIC_ID = 'usr_chaoscoldpool00000000';
const RESET_PEER = {
  name: 'postgres_cold_pool_reset_peer',
  type: 'reset_peer',
  stream: 'upstream',
  toxicity: 1,
  attributes: { timeout: 0 },
} as const;

async function loadWithColdPool(acquireDeadlineMs: number) {
  vi.resetModules();
  process.env.DATABASE_POOL_ACQUIRE_TIMEOUT_MS = String(acquireDeadlineMs);
  const contexts = await import('@/infrastructure/database/contexts/database-context.js');
  const connection = await import('@/infrastructure/database/connection.js');
  return {
    withAppDatabaseContext: contexts.withAppDatabaseContext,
    scope: contexts.PRINCIPAL_SCOPE.VERIFIED({ userPublicId: USER_PUBLIC_ID }),
    closeDatabase: connection.closeDatabase,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('Chaos resilience: cold pool under a connect-time fault', () => {
  afterEach(() => {
    delete process.env.DATABASE_POOL_ACQUIRE_TIMEOUT_MS;
    vi.resetModules();
  });

  it('without a deadline, waits out the fault and then runs the unit of work late', async () => {
    const { withAppDatabaseContext, scope, closeDatabase } = await loadWithColdPool(0);
    let ran = false;
    let settled = false;
    let unitOfWork: Promise<unknown> = Promise.resolve();

    await withTemporaryListeningProxyToxinForChaosAssertion(
      CHAOS_POSTGRES_PROXY_NAME,
      RESET_PEER,
      async () => {
        unitOfWork = withAppDatabaseContext(scope, async () => {
          ran = true;
        });
        void unitOfWork.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await sleep(4_000);
        expect(settled, 'a cold pool must still be waiting for a connection').toBe(false);
      },
    );

    // The fault is gone: the queued transaction connects and runs — the late write.
    await unitOfWork;
    expect(ran).toBe(true);
    await closeDatabase();
  });

  it('answers 503 + Retry-After at the acquire deadline, and never runs the unit of work late', async () => {
    const { withAppDatabaseContext, scope, closeDatabase } =
      await loadWithColdPool(ACQUIRE_DEADLINE_MS);
    let ran = false;

    await withTemporaryListeningProxyToxinForChaosAssertion(
      CHAOS_POSTGRES_PROXY_NAME,
      RESET_PEER,
      async () => {
        const startedAt = Date.now();
        await expect(
          withAppDatabaseContext(scope, async () => {
            ran = true;
          }),
        ).rejects.toMatchObject({ statusCode: 503, retryAfterSeconds: 5 });
        const elapsedMilliseconds = Date.now() - startedAt;
        expect(elapsedMilliseconds).toBeGreaterThanOrEqual(ACQUIRE_DEADLINE_MS - 50);
        expect(elapsedMilliseconds).toBeLessThan(ACQUIRE_DEADLINE_MS + 3_000);
      },
    );

    // The fault is gone: give the pool time to reconnect and reach the abandoned transaction.
    await sleep(3_000);
    expect(ran, 'an abandoned unit of work must roll back unrun').toBe(false);
    // And the pool serves new work again.
    await expect(withAppDatabaseContext(scope, async () => 'served')).resolves.toBe('served');
    await closeDatabase();
  });
});
