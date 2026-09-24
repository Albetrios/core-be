import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import i18next from 'i18next';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import {
  AppError,
  ConflictError,
  ERROR_CODE_TO_SNAKE,
  ValidationError,
} from '@/shared/errors/index.js';
import { EXTERNAL_ERROR_MESSAGE } from '@/shared/constants/index.js';
import { isPostgresLockTimeout } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { env } from '@/shared/config/env.config.js';
import {
  isFastifyRequestTimeoutError,
  isPostgresStatementTimeoutError,
} from '@/shared/utils/infrastructure/timeout-error.util.js';

function getRequestId(request: { id?: string }): string {
  return request.id ?? randomUUID();
}

function getDocsBaseUrl(): string | null {
  // Omit documentation_url entirely when unconfigured rather than emit a non-existent domain.
  return env.API_DOCS_BASE_URL ?? null;
}

function buildErrorPayload(
  type: 'request_error' | 'validation_error',
  code: string,
  detail: string,
  errors?: { field: string; message: string }[],
  reason?: string,
) {
  const docsBaseUrl = getDocsBaseUrl();
  const payload: {
    type: string;
    code: string;
    reason?: string;
    detail: string;
    documentation_url?: string;
    errors?: { field: string; message: string }[];
  } = {
    type,
    code,
    // Optional stable machine-readable sub-code (REQ-6) — additive; the FE can branch on it.
    ...(reason ? { reason } : {}),
    detail,
    ...(docsBaseUrl ? { documentation_url: `${docsBaseUrl}/${code}` } : {}),
  };
  if (errors?.length) payload.errors = errors;
  return payload;
}

function translateDetail(
  request: Pick<FastifyRequest, 't'>,
  key: string,
  params?: Record<string, string | number>,
  fallback: string = key,
): string {
  const options = params ?? {};
  // Prefer the per-request translator (honours the caller's Accept-Language).
  const viaRequest = request.t?.(key, options);
  if (viaRequest && viaRequest !== key) {
    return viaRequest;
  }
  // request.t can be absent, or unable to resolve `key`, when the error is
  // thrown before the i18n hook decorates the request (e.g. the captcha
  // security preHandler -> `errors:captchaRequired`). Resolve against the
  // initialised i18next singleton in the default language so `detail` is ALWAYS
  // a human string and never leaks a raw `errors:*` key to the client.
  if (i18next.isInitialized) {
    const viaSingleton = i18next.t(key, { lng: 'en', ...options });
    if (viaSingleton && viaSingleton !== key) {
      return viaSingleton;
    }
  }
  return fallback;
}

type FastifyValidationIssue = {
  instancePath?: string;
  params?: { missingProperty?: string };
  message?: string;
};

type FastifyValidationError = Error & {
  statusCode?: number;
  code: string;
  validation: FastifyValidationIssue[];
  validationContext?: string;
};

function isFastifyValidationError(error: unknown): error is FastifyValidationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'FST_ERR_VALIDATION' &&
    'validation' in error &&
    Array.isArray((error as { validation: unknown }).validation)
  );
}

function mapFastifyValidationField(
  issue: FastifyValidationIssue,
  validationContext?: string,
): string {
  if (issue.params?.missingProperty) {
    return issue.params.missingProperty;
  }
  const pathSegment = issue.instancePath?.replace(/^\//, '') ?? '';
  if (pathSegment.length > 0) {
    return validationContext ? `${validationContext}.${pathSegment}` : pathSegment;
  }
  return validationContext ?? 'body';
}

interface ErrorResponseBody {
  error: ReturnType<typeof buildErrorPayload>;
  meta: { request_id: string };
}

function buildTimeoutResponse(
  request: FastifyRequest,
  requestId: string,
  options: {
    translationKey: string;
    fallbackMessage: string;
    code: 'request_timeout' | 'gateway_timeout';
  },
): ErrorResponseBody {
  const detail = translateDetail(request, options.translationKey, {}, options.fallbackMessage);
  return {
    error: buildErrorPayload('request_error', options.code, detail),
    meta: { request_id: requestId },
  };
}

function handleAppErrorResponse(
  error: AppError,
  request: FastifyRequest,
  requestId: string,
): ErrorResponseBody {
  if (error.statusCode >= 500) {
    captureException(
      error,
      omitUndefined({
        requestId,
        userId: request.auth?.kind === 'user' ? request.auth.userId : undefined,
        organizationId: request.auth?.organizationPublicId ?? request.organizationId ?? undefined,
      }),
    );
  }
  const code = ERROR_CODE_TO_SNAKE[error.code];
  const isValidation = error instanceof ValidationError;
  const detail =
    error.statusCode >= 500
      ? translateDetail(request, 'errors:internal', {}, EXTERNAL_ERROR_MESSAGE)
      : translateDetail(request, error.messageKey, error.messageParams, error.message);
  const errors =
    isValidation && error.errors
      ? error.errors.map((item) => ({
          field: item.field,
          // Same resolver as `detail`: per-request t -> i18next singleton ->
          // fallback, so a field message never leaks a raw `errors:*` key either.
          message: item.messageKey
            ? translateDetail(
                request,
                item.messageKey,
                item.messageParams,
                item.message ?? item.messageKey,
              )
            : (item.message ?? 'Invalid'),
        }))
      : undefined;
  return {
    error: buildErrorPayload(
      isValidation ? 'validation_error' : 'request_error',
      code,
      detail,
      errors,
      // 5xx detail is masked, so omit the reason there too; only surface it on client-facing 4xx.
      error.statusCode >= 500 ? undefined : error.reason,
    ),
    meta: { request_id: requestId },
  };
}

function handleZodErrorResponse(
  error: ZodError,
  request: FastifyRequest,
  requestId: string,
): ErrorResponseBody {
  const detail = translateDetail(
    request,
    'errors:invalidFields',
    {},
    'Invalid values for fields in request',
  );
  const errors = Object.entries(z.flattenError(error).fieldErrors).map(([field, fieldMessages]) => {
    let message: string;
    if (Array.isArray(fieldMessages)) {
      message = fieldMessages.join(', ');
    } else if (typeof fieldMessages === 'string') {
      message = fieldMessages;
    } else {
      message = 'Invalid';
    }
    return { field, message };
  });
  return {
    error: buildErrorPayload('validation_error', 'invalid_field', detail, errors),
    meta: { request_id: requestId },
  };
}

function handleFastifyValidationErrorResponse(
  error: FastifyValidationError,
  request: FastifyRequest,
  requestId: string,
): ErrorResponseBody {
  const detail = translateDetail(
    request,
    'errors:invalidFields',
    {},
    'Invalid values for fields in request',
  );
  const errors = error.validation.map((issue) => ({
    field: mapFastifyValidationField(issue, error.validationContext),
    message: issue.message ?? 'Invalid',
  }));
  return {
    error: buildErrorPayload('validation_error', 'invalid_field', detail, errors),
    meta: { request_id: requestId },
  };
}

function handleUnhandledErrorResponse(
  error: unknown,
  request: FastifyRequest,
  requestId: string,
): ErrorResponseBody {
  captureException(
    error,
    omitUndefined({
      requestId,
      userId: request.auth?.kind === 'user' ? request.auth.userId : undefined,
      organizationId: request.organizationId ?? undefined,
    }),
  );
  // `error` is serialized by Pino's stdSerializers.err (configured for both `err` and `error`), so
  // it already carries the message + stack as structured fields. Duplicating them as top-level
  // plain strings (errorMessage/errorStack) only added an extra free-text copy that the key-based
  // redactor cannot scrub — a third-party exception message can embed a secret. errorName/errorCode
  // stay: they are low-risk structured values useful for log filtering.
  logger.error(
    {
      error,
      errorName: error instanceof Error ? error.name : undefined,
      errorCode:
        error instanceof Error && 'code' in error
          ? (error as Error & { code?: unknown }).code
          : undefined,
      requestId,
    },
    'Unhandled error',
  );
  const internalDetail = translateDetail(request, 'errors:internal', {}, EXTERNAL_ERROR_MESSAGE);
  return {
    error: buildErrorPayload('request_error', 'internal_error', internalDetail),
    meta: { request_id: requestId },
  };
}

/**
 * Stable client-error payloads for Fastify framework errors that already carry a
 * 4xx status — content-type-parser failures such as `FST_ERR_CTP_BODY_TOO_LARGE`
 * (413) and `FST_ERR_CTP_UNSUPPORTED_MEDIA_TYPE` (415). Other 4xx framework codes
 * fall back to a generic invalid-request payload.
 */
const FASTIFY_CLIENT_ERRORS: Record<number, { code: string; key: string; fallback: string }> = {
  413: {
    code: 'payload_too_large',
    key: 'errors:payloadTooLarge',
    fallback: 'Payload too large',
  },
  415: {
    code: 'unsupported_media_type',
    key: 'errors:invalidInput',
    fallback: 'Unsupported media type',
  },
};

/**
 * Returns the 4xx status of a Fastify framework error (one that carries its own
 * `statusCode` but is neither an {@link AppError}, a `ZodError`, nor an
 * `FST_ERR_VALIDATION`). Used to honor the framework status instead of masking
 * it as a 500.
 */
function getFastifyClientErrorStatus(error: unknown): number | undefined {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return statusCode;
  }
  return undefined;
}

function handleFastifyClientErrorResponse(
  error: unknown,
  request: FastifyRequest,
  requestId: string,
  statusCode: number,
): ErrorResponseBody {
  // A client error — log at warn (not error) and do NOT capture to Sentry.
  logger.warn(
    { requestId, statusCode, code: (error as { code?: string }).code },
    'request.client_error',
  );
  const mapped = Object.hasOwn(FASTIFY_CLIENT_ERRORS, statusCode)
    ? FASTIFY_CLIENT_ERRORS[statusCode]
    : undefined;
  const detail = mapped
    ? translateDetail(request, mapped.key, {}, mapped.fallback)
    : translateDetail(request, 'errors:invalidInput', {}, 'Invalid request');
  return {
    error: buildErrorPayload('request_error', mapped?.code ?? 'invalid_request', detail),
    meta: { request_id: requestId },
  };
}

const errorHandlerMiddlewarePlugin: FastifyPluginAsync = async (app) => {
  app.setNotFoundHandler(async (request, reply) => {
    const requestId = getRequestId(request as { id?: string });
    const detail = translateDetail(request, 'errors:routeNotFound', {}, 'Route not found');
    reply.status(404);
    return {
      error: buildErrorPayload('request_error', 'not_found', detail),
      meta: { request_id: requestId },
    };
  });

  app.setErrorHandler(async (error, request, reply) => {
    const currentRequestId = getRequestId(request as { id?: string });

    if (isFastifyRequestTimeoutError(error)) {
      logger.warn({ requestId: currentRequestId }, 'request.timeout');
      reply.status(408);
      return buildTimeoutResponse(request, currentRequestId, {
        translationKey: 'errors:requestTimeout',
        fallbackMessage: 'The request took too long to complete',
        code: 'request_timeout',
      });
    }

    if (isPostgresStatementTimeoutError(error)) {
      logger.warn({ requestId: currentRequestId }, 'database.statement_timeout');
      reply.status(504);
      return buildTimeoutResponse(request, currentRequestId, {
        translationKey: 'errors:databaseTimeout',
        fallbackMessage: 'The database operation timed out',
        code: 'gateway_timeout',
      });
    }

    // A statement cancelled by `lock_timeout` (SQLSTATE 55P03) is transient contention, not a
    // server fault: the same request succeeds once the holder commits. Without this it would fall
    // through to the 500 branch and be captured to Sentry as an unhandled error. Mapped to 409 per
    // the response-codes decision guide — "valid request colliding with current state, retrying may
    // succeed" — rather than 503, which is reserved for a dependency being unavailable.
    if (isPostgresLockTimeout(error)) {
      const conflictError = new ConflictError('errors:resourceBusy');
      reply.status(conflictError.statusCode);
      return handleAppErrorResponse(conflictError, request, currentRequestId);
    }

    if (error instanceof AppError) {
      reply.status(error.statusCode);
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      return handleAppErrorResponse(error, request, currentRequestId);
    }

    if (error instanceof ZodError) {
      reply.status(400);
      return handleZodErrorResponse(error, request, currentRequestId);
    }

    if (isFastifyValidationError(error)) {
      reply.status(error.statusCode ?? 400);
      return handleFastifyValidationErrorResponse(error, request, currentRequestId);
    }

    // Fastify framework errors that already carry a 4xx status (e.g. body too
    // large → 413, unsupported media type → 415). Honor the status instead of
    // masking it as 500 — which would also wrongly capture a client error to Sentry.
    const fastifyClientErrorStatus = getFastifyClientErrorStatus(error);
    if (fastifyClientErrorStatus !== undefined) {
      reply.status(fastifyClientErrorStatus);
      return handleFastifyClientErrorResponse(
        error,
        request,
        currentRequestId,
        fastifyClientErrorStatus,
      );
    }

    reply.status(500);
    return handleUnhandledErrorResponse(error, request, currentRequestId);
  });
};

/** Global error formatting for all routes and hooks (onRequest, preHandler, etc.). */
export default fp(errorHandlerMiddlewarePlugin, {
  name: 'error-handler-middleware',
});
