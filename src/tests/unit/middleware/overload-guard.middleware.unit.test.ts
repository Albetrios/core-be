import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  incrementOrganizationRlsCheckoutCount,
  resetOrganizationRlsCheckoutCountForTests,
} from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import errorHandlerMiddleware from '@/shared/middlewares/core/error-handler.middleware.js';
import overloadGuardMiddleware, {
  shouldShedRequest,
} from '@/shared/middlewares/core/overload-guard.middleware.js';
import { resetSharedEventLoopHistogram } from '@/shared/utils/infrastructure/event-loop-monitor.js';

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureException: vi.fn(),
}));

// Pin the pool inputs the guard reads at registration to the schema defaults, so the shed threshold
// is ceil(20 × 0.9) = 18 whatever a developer's env file sets (the load rig raises the pool size).
vi.mock('@/shared/config/env.config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/shared/config/env.config.js')>();
  return {
    ...original,
    env: { ...original.env, DATABASE_POOL_MAX: 20, OVERLOAD_DB_POOL_SHED_RATIO: 0.9 },
  };
});

/** The guard's sample interval (module-private in the middleware). */
const SAMPLE_INTERVAL_MS = 500;
/** A synchronous stall longer than the default 250 ms shed threshold. */
const BOOT_STALL_MS = 350;

/** Blocks the event loop the way synchronous boot work (imports, schema compilation) does. */
function blockEventLoopFor(milliseconds: number): void {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    // Deliberately synchronous.
  }
}

/** Baseline options that do NOT shed — individual tests override one signal at a time. */
const baseShedOptions = {
  path: '/api/v1/users/me',
  recentEventLoopDelayMs: 40,
  thresholdMs: 250,
  activeDbCheckouts: 0,
  dbCheckoutShedThreshold: 18, // ceil(20 * 0.9)
};

describe('overload-guard.middleware', () => {
  describe('shouldShedRequest', () => {
    it('never sheds allowlisted health/metrics paths, even far over both thresholds', () => {
      for (const path of ['/livez', '/readyz', '/metrics']) {
        expect(
          shouldShedRequest({
            ...baseShedOptions,
            path,
            recentEventLoopDelayMs: 9_999,
            activeDbCheckouts: 20,
          }),
        ).toBe(false);
      }
    });

    it('does not shed when both signals are below threshold', () => {
      expect(shouldShedRequest(baseShedOptions)).toBe(false);
    });

    it('sheds when recent event-loop delay reaches or exceeds the threshold', () => {
      expect(shouldShedRequest({ ...baseShedOptions, recentEventLoopDelayMs: 250 })).toBe(true);
      expect(shouldShedRequest({ ...baseShedOptions, recentEventLoopDelayMs: 600 })).toBe(true);
    });

    it('sheds on DB-pool saturation even when the event loop is idle', () => {
      // Event loop well below threshold, but the pool is at/over the shed line.
      expect(
        shouldShedRequest({ ...baseShedOptions, recentEventLoopDelayMs: 5, activeDbCheckouts: 18 }),
      ).toBe(true);
      expect(
        shouldShedRequest({ ...baseShedOptions, recentEventLoopDelayMs: 5, activeDbCheckouts: 20 }),
      ).toBe(true);
    });

    it('does not shed when checkouts are below the pool shed threshold', () => {
      expect(shouldShedRequest({ ...baseShedOptions, activeDbCheckouts: 17 })).toBe(false);
    });

    it('disables pool-saturation shedding when the threshold is 0 (ratio disabled)', () => {
      expect(
        shouldShedRequest({
          ...baseShedOptions,
          activeDbCheckouts: 9_999,
          dbCheckoutShedThreshold: 0,
        }),
      ).toBe(false);
    });
  });

  describe('plugin', () => {
    it('passes requests through when neither signal is saturated (dormant)', async () => {
      const app = Fastify();
      await app.register(overloadGuardMiddleware);
      app.get('/x', async () => ({ ok: true }));
      const response = await app.inject({ method: 'GET', url: '/x' });
      expect(response.statusCode).toBe(200);
      await app.close();
    });

    it('sheds with 503 and Retry-After once the DB pool is saturated', async () => {
      // At ceil(DATABASE_POOL_MAX × OVERLOAD_DB_POOL_SHED_RATIO) = 18 in-flight units of work the
      // guard sheds; the error handler turns the error's retryAfterSeconds into the header.
      resetOrganizationRlsCheckoutCountForTests();
      for (let checkout = 0; checkout < 20; checkout++) {
        incrementOrganizationRlsCheckoutCount();
      }
      const app = Fastify();
      app.decorateRequest(
        't',
        ((key: string) => key) as unknown as NonNullable<Parameters<typeof app.decorateRequest>[1]>,
      );
      await app.register(errorHandlerMiddleware);
      await app.register(overloadGuardMiddleware);
      app.get('/x', async () => ({ ok: true }));
      try {
        const response = await app.inject({ method: 'GET', url: '/x' });
        expect(response.statusCode).toBe(503);
        expect(response.headers['retry-after']).toBe('1');
      } finally {
        resetOrganizationRlsCheckoutCountForTests();
        await app.close();
      }
    });

    it('does not shed a fresh process on the stall of its own boot', async () => {
      // Registering the guard starts its event-loop histogram, and everything the app does before
      // it is ready — importing modules, compiling route schemas — is one synchronous stall on that
      // loop. Counted, it became the first sample's p99 and shed the first requests a new process
      // served: CI test workers got 503 on their opening calls whenever the runner was slow.
      resetSharedEventLoopHistogram();
      const app = Fastify();
      await app.register(overloadGuardMiddleware);
      app.get('/x', async () => ({ ok: true }));
      // A real boot awaits I/O (Postgres, Redis) between its synchronous stretches, so the loop
      // turns and the monitor is armed before the heavy work — which it then measures in full.
      await new Promise((resolve) => setTimeout(resolve, 30));
      blockEventLoopFor(BOOT_STALL_MS);
      await app.ready();

      // Probe across two sample windows: the first sample after boot is where the stall would land.
      const statuses = new Set<number>();
      const probeUntil = Date.now() + SAMPLE_INTERVAL_MS * 2;
      while (Date.now() < probeUntil) {
        statuses.add((await app.inject({ method: 'GET', url: '/x' })).statusCode);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect([...statuses]).toEqual([200]);
      await app.close();
    });
  });
});
