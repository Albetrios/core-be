import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationRlsTransactionSettlementOutcome } from '@/shared/middlewares/tenant/organization-rls-transaction.middleware.js';

/**
 * Regression test for production hardening item #1 — hook-order lifecycle.
 *
 * Asserts the request lifecycle coordinator runs onResponse steps in the order:
 *   1. RLS transaction settle (await commit/rollback)
 *   2. Idempotency cache write or forced placeholder release
 *   3. Outbox flush (only after successful commit / no organization transaction)
 *
 * Failure mode being prevented: side effects (idempotency cache, BullMQ enqueue) running
 * before the request DB transaction commits, so a rolled-back write can be replayed as a
 * cached 2xx or trigger downstream notifications/webhooks.
 */

const callOrder: string[] = [];

const settleAndAwaitOrganizationRlsTransactionMock = vi.fn(
  async (): Promise<OrganizationRlsTransactionSettlementOutcome> => {
    callOrder.push('rls_settle');
    return 'committed';
  },
);

const idempotencyOnResponseMock = vi.fn(async () => {
  callOrder.push('idempotency');
});

const flushOnCommitMock = vi.fn(async () => {
  callOrder.push('outbox_flush');
});

vi.mock('@/shared/middlewares/tenant/organization-rls-transaction.middleware.js', () => ({
  default: async () => {
    /* coordinator does not register the underlying plugin in this test */
  },
  settleAndAwaitOrganizationRlsTransaction: settleAndAwaitOrganizationRlsTransactionMock,
}));

vi.mock('@/shared/middlewares/core/idempotency.middleware.js', () => ({
  default: async () => {
    /* not registered in this test */
  },
  idempotencyOnResponse: idempotencyOnResponseMock,
}));

vi.mock('@/core/events/event-bus.js', () => ({
  eventBus: {
    flushOnCommit: flushOnCommitMock,
  },
  enterOnCommitScope: vi.fn(),
}));

describe('request-lifecycle middleware: onResponse step ordering', () => {
  beforeEach(() => {
    callOrder.length = 0;
    settleAndAwaitOrganizationRlsTransactionMock.mockClear();
    settleAndAwaitOrganizationRlsTransactionMock.mockImplementation(async () => {
      callOrder.push('rls_settle');
      return 'committed';
    });
    idempotencyOnResponseMock.mockClear();
    flushOnCommitMock.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('runs settle → idempotency → outbox-flush in that order on successful commit', async () => {
    const { default: requestLifecycleMiddleware } = await import(
      '@/shared/middlewares/core/request-lifecycle.middleware.js'
    );
    const application = Fastify({ logger: false });
    await application.register(requestLifecycleMiddleware);
    application.post('/probe', async () => ({ ok: true }));
    await application.ready();

    const response = await application.inject({ method: 'POST', url: '/probe' });
    expect(response.statusCode).toBe(200);

    expect(settleAndAwaitOrganizationRlsTransactionMock).toHaveBeenCalledTimes(1);
    expect(idempotencyOnResponseMock).toHaveBeenCalledTimes(1);
    expect(idempotencyOnResponseMock).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(idempotencyOnResponseMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { forceRelease: true },
    );
    expect(flushOnCommitMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['rls_settle', 'idempotency', 'outbox_flush']);

    await application.close();
  });

  it('force-releases idempotency and skips outbox when settlement is rolled_back', async () => {
    settleAndAwaitOrganizationRlsTransactionMock.mockImplementationOnce(async () => {
      callOrder.push('rls_settle');
      return 'rolled_back';
    });

    const { default: requestLifecycleMiddleware } = await import(
      '@/shared/middlewares/core/request-lifecycle.middleware.js'
    );
    const application = Fastify({ logger: false });
    await application.register(requestLifecycleMiddleware);
    application.post('/probe', async () => ({ ok: true }));
    await application.ready();

    const response = await application.inject({ method: 'POST', url: '/probe' });
    expect(response.statusCode).toBe(200);
    expect(idempotencyOnResponseMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      forceRelease: true,
    });
    expect(flushOnCommitMock).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['rls_settle', 'idempotency']);

    await application.close();
  });

  it('force-releases idempotency and skips outbox when settlement fails', async () => {
    settleAndAwaitOrganizationRlsTransactionMock.mockImplementationOnce(async () => {
      callOrder.push('rls_settle');
      return 'settle_failed';
    });

    const { default: requestLifecycleMiddleware } = await import(
      '@/shared/middlewares/core/request-lifecycle.middleware.js'
    );
    const application = Fastify({ logger: false });
    await application.register(requestLifecycleMiddleware);
    application.post('/probe', async () => ({ ok: true }));
    await application.ready();

    const response = await application.inject({ method: 'POST', url: '/probe' });
    expect(response.statusCode).toBe(200);
    expect(idempotencyOnResponseMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      forceRelease: true,
    });
    expect(flushOnCommitMock).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['rls_settle', 'idempotency']);

    await application.close();
  });

  it('treats settle throw as settle_failed and skips outbox', async () => {
    settleAndAwaitOrganizationRlsTransactionMock.mockImplementationOnce(async () => {
      callOrder.push('rls_settle_threw');
      throw new Error('settle_boom');
    });

    const { default: requestLifecycleMiddleware } = await import(
      '@/shared/middlewares/core/request-lifecycle.middleware.js'
    );
    const application = Fastify({ logger: false });
    await application.register(requestLifecycleMiddleware);
    application.post('/probe', async () => ({ ok: true }));
    await application.ready();

    const response = await application.inject({ method: 'POST', url: '/probe' });
    expect(response.statusCode).toBe(200);
    expect(idempotencyOnResponseMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      forceRelease: true,
    });
    expect(flushOnCommitMock).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['rls_settle_threw', 'idempotency']);

    await application.close();
  });

  it('flushes outbox after idempotency when commit succeeded even if cache write throws', async () => {
    idempotencyOnResponseMock.mockImplementationOnce(async () => {
      callOrder.push('idempotency_threw');
      throw new Error('cache_boom');
    });

    const { default: requestLifecycleMiddleware } = await import(
      '@/shared/middlewares/core/request-lifecycle.middleware.js'
    );
    const application = Fastify({ logger: false });
    await application.register(requestLifecycleMiddleware);
    application.post('/probe', async () => ({ ok: true }));
    await application.ready();

    const response = await application.inject({ method: 'POST', url: '/probe' });
    expect(response.statusCode).toBe(200);
    expect(flushOnCommitMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['rls_settle', 'idempotency_threw', 'outbox_flush']);

    await application.close();
  });
});
