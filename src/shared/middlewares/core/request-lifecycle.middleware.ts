import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { eventBus } from '@/core/events/event-bus.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  settleAndAwaitOrganizationRlsTransaction,
  type OrganizationRlsTransactionSettlementOutcome,
} from '@/shared/middlewares/tenant/organization-rls-transaction.middleware.js';
import { idempotencyOnResponse } from './idempotency.middleware.js';

/**
 * Request lifecycle coordinator.
 *
 * Owns the post-response ordering for write-side effects so they observe a settled DB
 * transaction. Fastify `onResponse` hooks run FIFO; this plugin is registered FIRST in
 * `middlewarePlugins` so its hook fires before any other `onResponse` and explicitly
 * sequences the three steps that previously raced:
 *
 *   1. Settle the per-request RLS transaction and AWAIT commit/rollback.
 *   2. Persist the idempotency cache entry (only meaningful after commit).
 *   3. Flush the on-commit outbox (enqueue BullMQ side-effect jobs).
 *
 * Idempotency cache writes and outbox flushes run only when settlement reports
 * `committed` or `no_transaction` (autocommit / non-organization routes). Rollback and settle
 * failures release idempotency placeholders without caching 2xx responses and skip
 * `flushOnCommit` so workers never observe uncommitted writes.
 */
function mayPersistPostCommitSideEffects(
  outcome: OrganizationRlsTransactionSettlementOutcome,
): boolean {
  return outcome === 'committed' || outcome === 'no_transaction';
}

const requestLifecycleMiddleware: FastifyPluginAsync = async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    let settlementOutcome: OrganizationRlsTransactionSettlementOutcome = 'settle_failed';
    try {
      settlementOutcome = await settleAndAwaitOrganizationRlsTransaction(request, reply);
    } catch (error) {
      logger.warn({ error, requestId: request.id }, 'request.lifecycle.rls_settle_failed');
    }

    const persistSideEffects = mayPersistPostCommitSideEffects(settlementOutcome);

    try {
      if (persistSideEffects) {
        await idempotencyOnResponse(request, reply);
      } else {
        await idempotencyOnResponse(request, reply, { forceRelease: true });
      }
    } catch (error) {
      logger.warn({ error, requestId: request.id }, 'request.lifecycle.idempotency_failed');
    }

    if (!persistSideEffects) {
      // Rollback / settle-failed: side effects must NOT fire, so flushOnCommit is skipped. Purge
      // BOTH the in-memory marker and the durable Redis tasks (audit-#M2): the rows those tasks
      // reference were rolled back, so leaving them for the recovery sweeper would replay them
      // against phantom rows — burning the worker retry budget and raising false final-failure
      // alerts. Best-effort; never throws out of the onResponse hook.
      try {
        await eventBus.discardCommitDispatchOnRollback(request.id);
      } catch (error) {
        logger.warn(
          { error, requestId: request.id },
          'request.lifecycle.commit_dispatch_purge_failed',
        );
      }
      return;
    }

    try {
      await eventBus.flushOnCommit({ requestId: request.id });
    } catch (error) {
      logger.warn({ error, requestId: request.id }, 'request.lifecycle.outbox_flush_failed');
    }
  });
};

export default fp(requestLifecycleMiddleware, { name: 'request-lifecycle-middleware' });
