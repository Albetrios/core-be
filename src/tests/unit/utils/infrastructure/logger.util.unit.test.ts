import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  buildFastifyServerOptions,
  PINO_REDACT_PATHS,
} from '@/shared/utils/http/fastify-server.util.js';
import {
  redactSensitive,
  SENSITIVE_REDACTION_PLACEHOLDER,
} from '@/shared/utils/security/sensitive-redaction.util.js';

describe('logger.util', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('exports a pino logger instance', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(PINO_REDACT_PATHS).toContain('authorization');
  });

  it('redacts nested sensitive fields via the shared log formatter', () => {
    const logObject = {
      req: {
        headers: { 'X-Api-Key': 'secret-key', accept: 'application/json' },
      },
      res: {
        headers: { 'set-cookie': 'session=zzz' },
      },
    };

    const redacted = redactSensitive(logObject);

    expect(redacted.req.headers['X-Api-Key']).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(redacted.req.headers.accept).toBe('application/json');
    expect(redacted.res.headers['set-cookie']).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('uses the same formatter in Fastify server logger options', () => {
    const fastifyLogger = buildFastifyServerOptions().logger;
    expect(fastifyLogger).toBeDefined();
    expect(typeof fastifyLogger).toBe('object');
    if (typeof fastifyLogger !== 'object' || fastifyLogger === null) {
      return;
    }

    const formatter = fastifyLogger.formatters?.log;
    expect(formatter).toBeDefined();

    const formatted = formatter?.({
      req: { headers: { authorization: 'Bearer secret' } },
    }) as { req: { headers: { authorization: string } } };

    expect(formatted.req.headers.authorization).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('enables pino-pretty transport when LOG_PRETTY is set', async () => {
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: { LOG_LEVEL: 'debug', LOG_PRETTY: true },
    }));
    const { logger: localLogger } = await import('@/shared/utils/infrastructure/logger.util.js');
    expect(localLogger).toBeDefined();
    expect(typeof localLogger.info).toBe('function');
  });

  // Regression: this module builds its Pino instance at import time, so an unresolvable
  // transport threw before any application code ran — `unable to determine transport target
  // for "pino-pretty"` took the whole API process down on boot in a deployed image, where
  // `pnpm install --prod` has pruned the devDependency. Constructing the logger with
  // LOG_PRETTY set must still succeed when the module is missing.
  it('still builds a working logger when LOG_PRETTY is set but pino-pretty is not installed', async () => {
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: { LOG_LEVEL: 'debug', LOG_PRETTY: true },
    }));
    vi.doMock('node:module', async () => {
      const actual = await vi.importActual<typeof import('node:module')>('node:module');
      return {
        ...actual,
        createRequire: () => ({
          resolve: (specifier: string): string => {
            throw new Error(`Cannot find module '${specifier}'`);
          },
        }),
      };
    });

    const { logger: localLogger } = await import('@/shared/utils/infrastructure/logger.util.js');
    expect(localLogger).toBeDefined();
    expect(typeof localLogger.info).toBe('function');
    expect(() => localLogger.info('boot')).not.toThrow();

    vi.doUnmock('node:module');
  });
});

/**
 * The unit above asserts the formatter redacts. This asserts the thing that was
 * actually broken: what pino EMITS. `formatters.log` runs before the
 * serializers, so a formatter that deep-copied an Error by its enumerable keys
 * handed `stdSerializers.err` an empty object and the line shipped as
 * `"error":{}` — no message, no stack — from all ~108 call sites.
 */
describe('logger.util — emitted error output', () => {
  function captureLine(log: (instance: pino.Logger) => void): Record<string, unknown> {
    const lines: string[] = [];
    const instance = pino(
      {
        level: 'error',
        // Mirrors the two options logger.util.ts passes; the interaction between
        // them is the whole point of this test.
        serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
        formatters: { log: (object) => redactSensitive(object) },
      },
      { write: (line: string) => lines.push(line) },
    );
    log(instance);
    return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  }

  it.each([['error'], ['err']])('emits message and stack under the %s key', (key) => {
    const emitted = captureLine((instance) => {
      instance.error({ [key]: new Error('connection refused') }, 'boom');
    });

    const logged = emitted[key] as { type?: string; message?: string; stack?: string };
    expect(logged.message).toBe('connection refused');
    expect(logged.type).toBe('Error');
    expect(logged.stack).toContain('connection refused');
  });

  it('still keeps a secret out of the emitted line', () => {
    const emitted = captureLine((instance) => {
      instance.error(
        { error: new Error('GET https://api.example.com/v1?access_token=super-secret') },
        'boom',
      );
    });

    expect(JSON.stringify(emitted)).not.toContain('super-secret');
    expect(JSON.stringify(emitted)).toContain(SENSITIVE_REDACTION_PLACEHOLDER);
  });
});
