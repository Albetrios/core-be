/**
 * Central recursive, case-insensitive secret redactor.
 *
 * Walks arbitrary objects/arrays and replaces the value of any key whose name contains a
 * sensitive fragment (case-insensitive substring) with `[REDACTED]`. Used by the Pino logger
 * and Sentry `beforeSend` so headers, query, body, breadcrumbs, and extras are scrubbed
 * regardless of nesting depth or header casing.
 *
 * String values that look like URLs or query strings have sensitive parameter values scrubbed.
 * Returns a redacted deep copy — never mutates the input. Cyclic references are tracked via
 * WeakMap so the original object graph is never returned from a cycle or depth boundary.
 */
export const SENSITIVE_REDACTION_PLACEHOLDER = '[REDACTED]';

const MAX_REDACTION_DEPTH = 8;

/**
 * Lower-cased substrings that mark a key as sensitive. Substring (not exact) matching catches
 * casing and nesting variants: `Authorization`, `X-Api-Key`, `set-cookie`, `raw_key`,
 * `body.refresh_token`, etc. `email` is included to keep address PII out of logs and Sentry;
 * this also redacts incidental flags such as `is_email_verified`, which is an acceptable
 * fail-closed trade-off.
 */
export const SENSITIVE_KEY_FRAGMENTS = [
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'api_key',
  'apikey',
  'api-key',
  'raw_key',
  'rawkey',
  'access_key_id',
  'private_key',
  'encryption_key',
  'session_id',
  'jwt',
  'credential',
  'email',
] as const;

interface RedactionContext {
  readonly visited: WeakMap<object, Record<string, unknown> | unknown[] | Error>;
  readonly depth: number;
}

/** Returns true when `key` (case-insensitive) contains any fragment in {@link SENSITIVE_KEY_FRAGMENTS} (e.g. `Authorization`, `X-Api-Key`, `set-cookie`). */
export function isSensitiveKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.includes('://');
}

function looksLikeQueryString(value: string): boolean {
  if (!value.includes('=')) {
    return false;
  }
  const queryPortion = value.startsWith('?') ? value.slice(1) : value;
  return queryPortion.split('&').some((pair) => pair.includes('='));
}

function decodeQueryParameterName(parameterName: string): string {
  try {
    return decodeURIComponent(parameterName.replace(/\+/g, ' '));
  } catch {
    return parameterName;
  }
}

/**
 * Redacts sensitive query parameter values in an application/x-www-form-urlencoded string.
 */
export function redactSensitiveQueryString(query: string): string {
  const hasLeadingQuestionMark = query.startsWith('?');
  const queryPortion = hasLeadingQuestionMark ? query.slice(1) : query;
  if (!queryPortion.includes('=')) {
    return query;
  }

  let changed = false;
  const redactedPairs = queryPortion.split('&').map((pair) => {
    const equalsIndex = pair.indexOf('=');
    if (equalsIndex === -1) {
      return pair;
    }

    const parameterName = pair.slice(0, equalsIndex);
    if (!isSensitiveKey(decodeQueryParameterName(parameterName))) {
      return pair;
    }

    changed = true;
    return `${parameterName}=${SENSITIVE_REDACTION_PLACEHOLDER}`;
  });

  if (!changed) {
    return query;
  }

  const redactedQuery = redactedPairs.join('&');
  return hasLeadingQuestionMark ? `?${redactedQuery}` : redactedQuery;
}

/**
 * Redacts sensitive query parameter values in a full URL string.
 */
export function redactSensitiveUrl(url: string): string {
  if (!looksLikeUrl(url)) {
    const questionMarkIndex = url.indexOf('?');
    if (questionMarkIndex === -1) {
      return url;
    }
    // `slice(questionMarkIndex)` keeps the `?`, and redactSensitiveQueryString
    // puts it back on the way out — including it in the prefix too emitted `??`.
    return `${url.slice(0, questionMarkIndex)}${redactSensitiveQueryString(url.slice(questionMarkIndex))}`;
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.search) {
      const redactedSearch = redactSensitiveQueryString(parsedUrl.search);
      return `${parsedUrl.origin}${parsedUrl.pathname}${redactedSearch}${parsedUrl.hash}`;
    }
    return parsedUrl.toString();
  } catch {
    const questionMarkIndex = url.indexOf('?');
    if (questionMarkIndex === -1) {
      return url;
    }
    // `slice(questionMarkIndex)` keeps the `?`, and redactSensitiveQueryString
    // puts it back on the way out — including it in the prefix too emitted `??`.
    return `${url.slice(0, questionMarkIndex)}${redactSensitiveQueryString(url.slice(questionMarkIndex))}`;
  }
}

function redactSensitiveString(value: string): string {
  if (looksLikeUrl(value)) {
    return redactSensitiveUrl(value);
  }
  if (looksLikeQueryString(value)) {
    return redactSensitiveQueryString(value);
  }
  return value;
}

/**
 * Errors carry `name` / `message` / `stack` as NON-enumerable properties, so the
 * `Object.entries` walk below copied none of them and every error collapsed to
 * `{}`. Pino runs `formatters.log` BEFORE its serializers, so the
 * `stdSerializers.err` wired into the logger never saw an `Error` at all — it was
 * handed that empty copy and passed it straight through. Every
 * `logger.error({ error }, …)` in the codebase lost its message and stack that way.
 *
 * The copy stays a real `Error` rather than becoming a plain `{ type, message,
 * stack }` object, so the serializers downstream — this logger's, and the one
 * Fastify installs by default — get what they are built for and render it the way
 * they always have. Handing them a pre-shaped plain object instead makes pino
 * re-serialize it: `type` comes back as `Object` and the stack is rebuilt from
 * fields it no longer recognises.
 *
 * Message and stack go through {@link redactSensitiveString} like any other string
 * — a token in a failing URL must not reach the log just because it arrived inside
 * an Error.
 */
function redactError(input: Error, context: RedactionContext): Error {
  const existingError = context.visited.get(input);
  if (existingError !== undefined) {
    return existingError as Error;
  }

  const redactedMessage = redactSensitiveString(input.message);
  const output = new Error(redactedMessage);
  context.visited.set(input, output);

  // `name` and `cause` are non-enumerable on a real Error. Assigning them
  // plainly would make them own ENUMERABLE properties, and pino copies those
  // verbatim — the log would carry a redundant `name` beside `type`, and a
  // `cause` beside the one the serializer already folds into message + stack.
  Object.defineProperty(output, 'name', {
    value: input.name,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  if (input.cause !== undefined) {
    Object.defineProperty(output, 'cause', {
      value: redactValue(input.cause, { ...context, depth: context.depth + 1 }),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * Only the stack's header line can hold the secret, because it is
   * `${name}: ${message}` — the frames below it are file paths. Swapping just
   * that substring keeps every frame intact. Running the WHOLE stack through
   * {@link redactSensitiveString} instead destroys it: a stack quoting a URL
   * contains `://`, so it is taken for a URL, and `new URL` parses the header
   * line as scheme `error:` rather than throwing — the "redacted" result is
   * `null <rest of first line>` with every frame dropped. Replacement goes
   * through a function so a `$&` in the message is not read as a backreference.
   */
  if (typeof input.stack === 'string') {
    output.stack =
      redactedMessage === input.message
        ? input.stack
        : input.stack.replace(input.message, () => redactedMessage);
  } else {
    // The source had no stack, and `new Error()` just gave the copy one pointing
    // into this file — worse than none, since it describes the redactor rather
    // than the failure.
    delete (output as { stack?: string }).stack;
  }

  // Own enumerable extras an error may carry (`code`, `statusCode`, …) are
  // redacted by key like any other object.
  const extras = output as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(input as unknown as Record<string, unknown>)) {
    // eslint-disable-next-line security/detect-object-injection -- key from Object.entries of the error being redacted; written to a fresh local Error.
    extras[key] = isSensitiveKey(key)
      ? SENSITIVE_REDACTION_PLACEHOLDER
      : redactValue(value, { ...context, depth: context.depth + 1 });
  }

  return output;
}

function redactValue<T>(input: T, context: RedactionContext): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return redactSensitiveString(input) as T;
  }

  if (typeof input !== 'object') {
    return input;
  }

  if (context.depth >= MAX_REDACTION_DEPTH) {
    return SENSITIVE_REDACTION_PLACEHOLDER as T;
  }

  if (input instanceof Error) {
    return redactError(input, context) as T;
  }

  if (Array.isArray(input)) {
    const existingArray = context.visited.get(input);
    if (existingArray !== undefined) {
      return existingArray as T;
    }

    const output: unknown[] = [];
    context.visited.set(input, output);
    for (const item of input) {
      output.push(redactValue(item, { ...context, depth: context.depth + 1 }));
    }
    return output as T;
  }

  const existingObject = context.visited.get(input);
  if (existingObject !== undefined) {
    return existingObject as T;
  }

  const output: Record<string, unknown> = {};
  context.visited.set(input, output);

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // eslint-disable-next-line security/detect-object-injection -- key from Object.entries of the input being redacted; written to a fresh local object.
    output[key] = isSensitiveKey(key)
      ? SENSITIVE_REDACTION_PLACEHOLDER
      : redactValue(value, { ...context, depth: context.depth + 1 });
  }
  return output as T;
}

/**
 * Returns a deep copy of `input` with values for sensitive keys (and
 * URL/query-string-shaped strings containing sensitive parameters) replaced
 * by `[REDACTED]`. Walks up to {@link MAX_REDACTION_DEPTH} levels and tracks
 * cyclic references via WeakMap. Used by the Pino logger and Sentry
 * `beforeSend` so headers, body, breadcrumbs, and extras are scrubbed.
 */
export function redactSensitive<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return redactSensitiveString(input) as T;
  }

  if (typeof input !== 'object') {
    return input;
  }

  return redactValue(input, { visited: new WeakMap(), depth: 0 });
}
