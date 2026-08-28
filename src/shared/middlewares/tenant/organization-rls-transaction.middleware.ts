import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Result of awaiting the per-request RLS transaction settlement step in the request lifecycle.
 *
 * @remarks
 * - **Algorithm:** legacy request-pinned transactions were removed; settlement always reports
 *   `no_transaction` because org-scoped work runs in `withAppDatabaseContext`.
 * - **Failure modes:** none — this is a compatibility stub for the lifecycle coordinator.
 * - **Side effects:** none.
 * - **Notes:** idempotency cache writes and on-commit dispatch proceed whenever settlement is
 *   `no_transaction` or `committed` (see `request-lifecycle.middleware.ts`).
 */
export type OrganizationRlsTransactionSettlementOutcome =
  | 'committed'
  | 'rolled_back'
  | 'no_transaction'
  | 'settle_failed';

/**
 * Compatibility no-op for the request lifecycle coordinator.
 *
 * @remarks
 * - **Algorithm:** returns `no_transaction` immediately — there is no outer HTTP transaction.
 * - **Failure modes:** none.
 * - **Side effects:** none.
 * - **Notes:** kept so post-response ordering (RLS settle → idempotency → outbox flush) stays stable.
 */
export async function settleAndAwaitOrganizationRlsTransaction(
  _request: FastifyRequest,
  _reply: FastifyReply,
): Promise<OrganizationRlsTransactionSettlementOutcome> {
  return 'no_transaction';
}

/**
 * No-op compatibility plugin retained for the request-lifecycle settlement
 * contract.
 *
 * @remarks
 * sec-M4: this plugin used to pin a pooled DB checkout for the duration of
 * the request. Now `withAppDatabaseContext` opens its own short-
 * lived transaction at each call site, so there is nothing for this plugin
 * to do — it registers, owns no hooks, and returns. It is NOT safe to delete
 * yet because `request-lifecycle.middleware.ts` imports
 * {@link OrganizationRlsTransactionSettlementOutcome} from this file and
 * branches on it during `onResponse`. A future cleanup that drops this no-op
 * must also fold the settlement outcome union into the lifecycle middleware,
 * or inline `'no_transaction'` everywhere it currently flows through this
 * function. Until then the no-op + the outcome union live together so the
 * type and the implementation cannot drift.
 */
const organizationRlsTransactionMiddlewarePlugin: FastifyPluginAsync = async () => {
  /* no-op — scoped RLS contexts only (sec-M4) */
};

export default fp(organizationRlsTransactionMiddlewarePlugin, {
  name: 'organization-rls-transaction-middleware',
});
