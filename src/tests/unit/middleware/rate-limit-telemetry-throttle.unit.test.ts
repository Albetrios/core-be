import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldEmitRateLimitTelemetry } from '@/shared/middlewares/rate-limit/rate-limit-telemetry-throttle.js';

/**
 * The rate-limit `onExceeded` observers fire on every REJECTED request, and a caller that has hit
 * its limit keeps hitting it; under a sustained burst that floods Pino + Sentry with a fact the
 * first line already established. `shouldEmitRateLimitTelemetry` caps emission to
 * once per key per window. Each test uses a unique key because the throttle map is module-level
 * (process-wide by design).
 */
describe('rate-limit-telemetry-throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits on the first observation of a key', () => {
    expect(shouldEmitRateLimitTelemetry('ip:198.51.100.1')).toBe(true);
  });

  it('suppresses repeat observations of the same key within the throttle window', () => {
    const key = 'ip:198.51.100.2';
    expect(shouldEmitRateLimitTelemetry(key)).toBe(true);
    expect(shouldEmitRateLimitTelemetry(key)).toBe(false);
    vi.advanceTimersByTime(5_000); // still inside the 10s window
    expect(shouldEmitRateLimitTelemetry(key)).toBe(false);
  });

  it('emits again once the throttle window has elapsed', () => {
    const key = 'ip:198.51.100.3';
    expect(shouldEmitRateLimitTelemetry(key)).toBe(true);
    expect(shouldEmitRateLimitTelemetry(key)).toBe(false);
    vi.advanceTimersByTime(10_001); // past the 10s window
    expect(shouldEmitRateLimitTelemetry(key)).toBe(true);
  });

  it('tracks distinct keys independently', () => {
    expect(shouldEmitRateLimitTelemetry('ip:198.51.100.4')).toBe(true);
    expect(shouldEmitRateLimitTelemetry('ip:198.51.100.5')).toBe(true);
    expect(shouldEmitRateLimitTelemetry('ip:198.51.100.4')).toBe(false);
  });
});
