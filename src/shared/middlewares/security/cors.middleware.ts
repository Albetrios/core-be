import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import fastifyCors from '@fastify/cors';
import { env } from '@/shared/config/env.config.js';
import { CORS_PREFLIGHT_MAX_AGE_SECONDS } from '@/shared/constants/index.js';
import { parseAllowedOriginsList } from '@/shared/utils/security/allowed-origins.util.js';

const corsMiddleware: FastifyPluginAsync = async (app) => {
  const origins = parseAllowedOriginsList(env.ALLOWED_ORIGINS);

  if (origins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must contain at least one origin');
  }

  await app.register(fastifyCors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Captcha-Token',
      'X-Idempotency-Key',
      'X-Request-Id',
      // Browsers/XHR libraries set `X-Requested-With` on requests; without it in the
      // preflight `Access-Control-Allow-Headers` the OPTIONS check fails, which blocked
      // the silent auth-token refresh on the dev deploy.
      'X-Requested-With',
    ],
    // sec-re-17: sec-CM #27 added the server-minted `X-Client-Request-Id`
    // response header but did not list it on `exposedHeaders`. Cross-origin
    // browsers honour `Access-Control-Expose-Headers` strictly, so without
    // this entry the new header was invisible to fetch / XHR callers and
    // the tracing pivot it was meant to enable did not work from web apps.
    // EX-11: `Retry-After` is emitted on 429 (rate limit) and 503 (idempotency store unavailable)
    // but cross-origin browsers cannot read it unless it is exposed — so SPAs retried blind. Expose
    // it so clients can honour the server's backoff. (X-RateLimit-* are intentionally omitted: this
    // stack does not emit them, so listing them would be dead config.)
    exposedHeaders: ['X-Request-Id', 'X-Client-Request-Id', 'X-Idempotency-Replay', 'Retry-After'],
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  });
};

// fp() breaks plugin encapsulation so the @fastify/cors onRequest hook that decorates
// EVERY response with Access-Control-Allow-* reaches routes registered in sibling plugin
// scopes. Without it only the plugin's global wildcard OPTIONS route worked: preflights
// carried CORS headers but actual responses did not, so browsers surfaced a CORS error
// on otherwise-successful (e.g. 200) cross-origin requests.
export default fp(corsMiddleware, { name: 'cors-middleware' });
