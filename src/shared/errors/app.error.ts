/** Discriminator for {@link AppError} subclasses; mapped to wire-format codes via {@link ERROR_CODE_TO_SNAKE}. */
export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNPROCESSABLE_ENTITY'
  | 'GONE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED';

/** Paddle-style snake_case error code for API responses */
export const ERROR_CODE_TO_SNAKE: Record<AppErrorCode, string> = {
  VALIDATION_ERROR: 'invalid_field',
  NOT_FOUND: 'not_found',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNPROCESSABLE_ENTITY: 'unprocessable_entity',
  GONE: 'gone',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  INTERNAL_ERROR: 'internal_error',
  NOT_IMPLEMENTED: 'not_implemented',
};

/**
 * Base class for every typed application error. Carries an HTTP status code,
 * an i18n `messageKey`, optional `messageParams` for interpolation, and a
 * fallback English message used when no i18n context is available. The error
 * handler middleware translates `messageKey` via `request.t()`.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  /** Translation key (e.g. "errors:notFound"); error handler uses request.t(messageKey, messageParams). */
  readonly messageKey: string;
  /** Interpolation params for request.t(messageKey, messageParams). */
  readonly messageParams?: Record<string, string | number>;
  /**
   * Optional stable, machine-readable sub-code (snake_case) the frontend can branch on
   * (e.g. `membership_already_exists`, `organization_slug_exists`) — distinct from the
   * status-class `code`. Set via {@link AppError.withReason}; the error handler serializes it as
   * `error.reason` on non-5xx responses only.
   */
  reason?: string;
  /**
   * Seconds the client should wait before retrying — the error handler sends it as `Retry-After`.
   * Set via {@link AppError.withRetryAfter}; meaningful on 429 and 503.
   */
  retryAfterSeconds?: number;

  constructor(
    code: AppErrorCode,
    statusCode: number,
    messageKey: string,
    messageParams?: Record<string, string | number>,
    fallbackMessage?: string,
  ) {
    super(fallbackMessage ?? messageKey);
    this.code = code;
    this.statusCode = statusCode;
    this.messageKey = messageKey;
    if (messageParams !== undefined) {
      this.messageParams = messageParams;
    }
    this.name = this.constructor.name;
  }

  /**
   * Attaches a stable machine-readable {@link AppError.reason} slug and returns `this` (fluent),
   * e.g. `throw new ConflictError('errors:membershipAlreadyExists').withReason('membership_already_exists')`.
   */
  withReason(reason: string): this {
    this.reason = reason;
    return this;
  }

  /**
   * Attaches {@link AppError.retryAfterSeconds} and returns `this` (fluent), e.g.
   * `throw new ServiceUnavailableError().withRetryAfter(1)`; the error handler sends `Retry-After`.
   */
  withRetryAfter(seconds: number): this {
    this.retryAfterSeconds = seconds;
    return this;
  }
}
