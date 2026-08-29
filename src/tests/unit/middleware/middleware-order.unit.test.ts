import { describe, expect, it } from 'vitest';
import { middlewarePlugins } from '@/shared/middlewares/index.js';
import rateLimitMiddleware from '@/shared/middlewares/rate-limit/rate-limit.middleware.js';
import organizationRlsTransactionMiddleware from '@/shared/middlewares/tenant/organization-rls-transaction.middleware.js';

/**
 * Regression test for middleware ordering. The global limiter is keyed strictly on
 * `request.ip`, so it depends on no tenant resolution; the load-bearing constraint
 * is that rate limiting runs before the per-request RLS transaction so throttled requests
 * never open a DB connection. (the header-driven tenant middleware was removed with X-Organization-Id).
 */
describe('middleware registration order', () => {
  const order = middlewarePlugins as readonly unknown[];

  it('rate limits before opening the per-request RLS transaction', () => {
    const rateLimitIndex = order.indexOf(rateLimitMiddleware);
    const rlsIndex = order.indexOf(organizationRlsTransactionMiddleware);

    expect(rateLimitIndex).toBeGreaterThanOrEqual(0);
    expect(rlsIndex).toBeGreaterThanOrEqual(0);
    expect(rateLimitIndex).toBeLessThan(rlsIndex);
  });
});
