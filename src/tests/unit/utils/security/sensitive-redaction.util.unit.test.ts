import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  redactSensitive,
  redactSensitiveQueryString,
  redactSensitiveUrl,
  SENSITIVE_KEY_FRAGMENTS,
  SENSITIVE_REDACTION_PLACEHOLDER,
} from '@/shared/utils/security/sensitive-redaction.util.js';
import { PINO_REDACT_PATHS } from '@/shared/utils/http/fastify-server.util.js';

// audit #27: PINO_REDACT_PATHS is now derived from SENSITIVE_KEY_FRAGMENTS (one source of truth).
// This pins the no-drift invariant: every recursive fragment is also a Pino fast-path, and every
// bare (non-nested) Pino path is recognised as sensitive by the recursive matcher.
describe('redaction single-source invariant (audit #27)', () => {
  it('PINO_REDACT_PATHS includes every SENSITIVE_KEY_FRAGMENTS entry', () => {
    for (const fragment of SENSITIVE_KEY_FRAGMENTS) {
      expect(PINO_REDACT_PATHS).toContain(fragment);
    }
  });

  it('every bare Pino path is caught by the recursive isSensitiveKey matcher', () => {
    const barePaths = PINO_REDACT_PATHS.filter(
      (path) => !(path.includes('.') || path.includes('[')),
    );
    for (const path of barePaths) {
      expect(isSensitiveKey(path)).toBe(true);
    }
  });
});

describe('redactSensitive', () => {
  it('redacts case-insensitive and nested sensitive keys', () => {
    const input = {
      Authorization: 'Bearer abc',
      headers: {
        'X-Api-Key': 'k-123',
        'set-cookie': 'session=zzz',
        'content-type': 'application/json',
      },
      body: {
        password: 'hunter2',
        nested: { refresh_token: 'r-1', keepThis: 'visible' },
      },
      raw_key: 'sk_live_xyz',
    };

    const result = redactSensitive(input);

    expect(result.Authorization).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.headers['X-Api-Key']).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.headers['set-cookie']).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.body.password).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.nested.refresh_token).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.nested.keepThis).toBe('visible');
    expect(result.raw_key).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('redacts email PII keys (object and query string)', () => {
    const result = redactSensitive({
      email: 'user@example.com',
      body: { user_email: 'a@b.com', name: 'ok' },
    });
    expect(result.email).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.user_email).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.name).toBe('ok');
    expect(redactSensitive('email=user%40example.com&page=1')).toBe(
      `email=${SENSITIVE_REDACTION_PLACEHOLDER}&page=1`,
    );
  });

  it('redacts sensitive keys inside arrays', () => {
    const input = { items: [{ apiKey: 'a' }, { name: 'ok' }] };
    const result = redactSensitive(input);
    expect(result.items[0]!.apiKey).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.items[1]!.name).toBe('ok');
  });

  it('does not mutate the original object', () => {
    const input = { token: 'secret-value' };
    const result = redactSensitive(input);
    expect(input.token).toBe('secret-value');
    expect(result.token).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('returns non-query primitives unchanged', () => {
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });

  it('redacts sensitive values in query strings', () => {
    expect(redactSensitive('token=secret&page=1')).toBe(
      `token=${SENSITIVE_REDACTION_PLACEHOLDER}&page=1`,
    );
    expect(redactSensitive('?raw_key=sk_live&name=bob')).toBe(
      `?raw_key=${SENSITIVE_REDACTION_PLACEHOLDER}&name=bob`,
    );
  });

  it('redacts sensitive values in URL strings', () => {
    expect(redactSensitive('https://api.example.com/v1/items?api_key=secret&page=2')).toBe(
      `https://api.example.com/v1/items?api_key=${SENSITIVE_REDACTION_PLACEHOLDER}&page=2`,
    );
  });

  it('handles cyclic structures without reintroducing secrets', () => {
    const cyclic: Record<string, unknown> = { name: 'root', password: 'x' };
    cyclic.self = cyclic;
    expect(() => redactSensitive(cyclic)).not.toThrow();
    const result = redactSensitive(cyclic) as Record<string, unknown>;
    expect(result.password).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.self).not.toBe(cyclic);
    const nestedSelf = result.self as Record<string, unknown>;
    expect(nestedSelf.password).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('does not return original objects beyond max depth', () => {
    const leafSecret = 'must-not-appear-beyond-max-depth';
    const root: Record<string, unknown> = { nested: {} };
    let current = root.nested as Record<string, unknown>;
    for (let depth = 0; depth < 15; depth += 1) {
      const next: Record<string, unknown> = {};
      current.child = next;
      current = next;
    }
    current.payload = leafSecret;

    const result = redactSensitive(root) as Record<string, unknown>;
    expect(result.nested).not.toBe(root.nested);
    expect(JSON.stringify(result)).not.toContain(leafSecret);
  });
});

describe('redactSensitiveQueryString', () => {
  it('redacts only sensitive query parameter values', () => {
    expect(redactSensitiveQueryString('foo=bar&token=abc')).toBe(
      `foo=bar&token=${SENSITIVE_REDACTION_PLACEHOLDER}`,
    );
    expect(redactSensitiveQueryString('?x-api-key=secret&limit=10')).toBe(
      `?x-api-key=${SENSITIVE_REDACTION_PLACEHOLDER}&limit=10`,
    );
  });
});

describe('redactSensitiveUrl', () => {
  it('redacts sensitive query parameters in absolute URLs', () => {
    expect(redactSensitiveUrl('https://example.com/path?password=hunter2&id=1')).toBe(
      `https://example.com/path?password=${SENSITIVE_REDACTION_PLACEHOLDER}&id=1`,
    );
  });
});

/**
 * `Object.entries` sees only own ENUMERABLE properties, and an Error keeps
 * `name` / `message` / `stack` non-enumerable — so the generic object walk
 * copied none of them and every error collapsed to `{}`. Pino runs
 * `formatters.log` before its serializers, so `stdSerializers.err` never saw an
 * Error and every `logger.error({ error }, …)` in the codebase shipped without a
 * message or a stack.
 */
describe('redactSensitive — Error values', () => {
  it('keeps the message and stack instead of collapsing to an empty object', () => {
    const error = new Error('connection refused');

    const redacted = redactSensitive(error);

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).toBe('connection refused');
    expect(redacted.stack).toContain('connection refused');
    expect(Object.keys(redacted as unknown as Record<string, unknown>)).not.toContain('name');
  });

  it('survives nested inside a log object', () => {
    const redacted = redactSensitive({ error: new Error('boom'), scope: 'worker' }) as {
      error: Error;
      scope: string;
    };

    expect(redacted.error).toBeInstanceOf(Error);
    expect(redacted.error.message).toBe('boom');
    expect(redacted.scope).toBe('worker');
  });

  it('redacts a secret in the message and in the stack header, keeping the frames', () => {
    const error = new Error('GET https://api.example.com/v1?access_token=super-secret');

    const redacted = redactSensitive(error);

    expect(redacted.message).toContain(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(redacted.message).not.toContain('super-secret');
    expect(redacted.stack).not.toContain('super-secret');
    // The frames below the header line must survive the substitution.
    expect(redacted.stack).toContain('at ');
  });

  it('redacts sensitive own properties an error carries', () => {
    const error = Object.assign(new Error('auth failed'), {
      statusCode: 401,
      access_token: 'leaked',
    });

    const redacted = redactSensitive(error) as unknown as Record<string, unknown>;

    expect(redacted.statusCode).toBe(401);
    expect(redacted.access_token).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('carries the cause across without making it enumerable', () => {
    const redacted = redactSensitive(new Error('outer', { cause: new Error('inner') })) as Error & {
      cause?: Error;
    };

    expect(redacted.cause).toBeInstanceOf(Error);
    expect(redacted.cause?.message).toBe('inner');
    expect(Object.keys(redacted as unknown as Record<string, unknown>)).not.toContain('cause');
  });

  it('never mutates the error it was handed', () => {
    const error = Object.assign(new Error('GET /x?token=abc'), { token: 'abc' });

    redactSensitive(error);

    expect(error.message).toBe('GET /x?token=abc');
    expect(error.token).toBe('abc');
  });

  it('returns the same copy for an error reachable twice (no infinite walk)', () => {
    const error = new Error('shared');
    const redacted = redactSensitive({ first: error, second: error }) as {
      first: Error;
      second: Error;
    };

    expect(redacted.first).toBe(redacted.second);
    expect(redacted.first.message).toBe('shared');
  });
});

describe('redactSensitiveUrl — relative paths', () => {
  it('does not double the question mark when redacting a relative URL', () => {
    expect(redactSensitiveUrl('/v1/callback?token=abc&id=1')).toBe(
      `/v1/callback?token=${SENSITIVE_REDACTION_PLACEHOLDER}&id=1`,
    );
  });
});
