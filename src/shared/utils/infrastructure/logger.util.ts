import pino from 'pino';
import { env } from '@/shared/config/env.config.js';
import {
  buildPinoPrettyTransport,
  PINO_REDACT_PATHS,
} from '@/shared/utils/http/fastify-server.util.js';
import { redactSensitive } from '@/shared/utils/security/sensitive-redaction.util.js';

const prettyTransport = buildPinoPrettyTransport();

/**
 * Process-wide Pino logger pre-configured with sensitive-key redaction
 * (paths + recursive value scrubbing via {@link redactSensitive}). Local dev
 * uses `pino-pretty` when {@link buildPinoPrettyTransport} can resolve it; a deployed
 * image (devDependencies pruned) emits structured JSON for log aggregation instead of
 * throwing on the missing transport.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [...PINO_REDACT_PATHS],
    censor: '[REDACTED]',
  },
  // sec-r5-observability: `Error` objects serialise as `{}` by default because
  // `name`/`message`/`stack` are non-enumerable, so every
  // `logger.error({ error }, ...)` and `logger.fatal({ error }, ...)` landed in
  // production logs with the failure reason dropped. `stdSerializers.err` is
  // applied to both `err` (the pino convention) and `error` (the convention this
  // codebase uses) so every log site benefits without a per-call change.
  //
  // These serializers are only half the fix, and on their own they did nothing:
  // pino runs `formatters.log` FIRST, and the `redactSensitive` formatter below
  // used to deep-copy by enumerable key — so what reached a serializer was
  // already an empty object, not an `Error`. `redactSensitive` now returns a real
  // `Error` copy for errors, which is what keeps this pair working. Neither half
  // is redundant: the formatter preserves the error, these render it.
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  formatters: {
    log: (object) => redactSensitive(object),
  },
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});

// `LOG_PRETTY` was honoured silently until it wasn't: a deployed image prunes
// devDependencies, so `pino-pretty` is missing and {@link buildPinoPrettyTransport}
// degrades to JSON rather than letting Pino throw at module load. Say so once, through
// the logger that did get built, so the operator sees WHY the format they asked for is
// not the format they got instead of quietly assuming the flag never took effect.
if (env.LOG_PRETTY && !prettyTransport) {
  logger.warn(
    'LOG_PRETTY is set but pino-pretty could not be resolved (deployed images install with --prod, which prunes devDependencies). Falling back to structured JSON logs.',
  );
}
