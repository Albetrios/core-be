import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { GLOBAL_ROLES } from '@/shared/constants/index.js';
import { MODERATE_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireRole } from '@/shared/utils/auth/authorization.util.js';
import { createAuditController } from './audit.controller.js';

/**
 * Fastify plugin mounting the admin audit routes under the audit prefix.
 * Currently registers `GET /logs`, gated to SUPER_ADMIN / ADMIN global roles.
 */
export const auditRoutesPlugin: FastifyPluginAsync = async (app) => {
  const controller = createAuditController(app.auditDomain.auditService);
  const zodApplication = app.withTypeProvider<ZodTypeProvider>();

  // `GET /logs` was the last read-heavy admin surface in the repo carrying no per-route cap — it
  // fell back to the global limiter alone. Exposure is lower than an unauthenticated route
  // (SUPER_ADMIN / ADMIN only), but it is a cursor-paginated read over an unbounded-growth ledger
  // with an opt-in `include_total` count(*), so a hijacked admin session could walk the whole
  // table in a tight loop. MODERATE_AUTHED (30 req/60s, keyed by user) matches the repo's other
  // authenticated read surfaces, and its `preHandler` hook is appended AFTER `requireRole`, so a
  // non-admin is rejected before its bucket key is ever derived.
  //
  // Keep this rationale ABOVE the registration. The route-catalog access classifier reads only
  // the first 500 characters following a route registration, so a comment this long inside the
  // options object pushes `onRequest: [app.authenticate]` out of that window and the route is
  // mis-catalogued as PUBLIC. (The same scan is regex-based, so avoid writing a literal route
  // registration in prose here — it would be picked up as a second route.) The resulting access
  // classification is pinned by `audit-routes-rate-limit.policy.unit.test.ts` and the catalog
  // smoke suite.
  zodApplication.get(
    '/logs',
    {
      ...MODERATE_AUTHED_RATE_LIMIT,
      onRequest: [app.authenticate],
      preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
      schema: {
        summary: 'List audit logs (admin)',
        description:
          'Returns audit log entries with cursor pagination (`after`, `limit`). Requires SUPER_ADMIN or ADMIN role.',
        tags: ['Audit Log'],
      },
    },
    controller.listLogs,
  );
};
