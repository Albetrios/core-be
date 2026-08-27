import type { AuditRepository } from './audit.repository.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';
import type { AuditLogFilters, AuditLogRecordInput } from './audit.types.js';
import { validateListAuditLogsQuery } from './audit.validator.js';
import { insertAuditOutboxRow } from './audit-outbox.repository.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  resolveVerifiedOrganizationPrincipalScope,
  resolveVerifiedUserPrincipalScope,
} from '@/shared/utils/identity/verified-principal-scope.util.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/principal-database.context.js';

/**
 * Collects the distinct internal user ids (actor + target) and organization ids referenced by a
 * page of audit-log rows, so {@link AuditService.list} can batch-resolve them to public ids in two
 * round trips. Extracted to keep that method's cognitive complexity within budget.
 */
function collectReferencedInternalIds(
  rows: readonly {
    actor_user_id: number | null;
    target_user_id: number | null;
    organization_id: number | null;
  }[],
): { userInternalIds: Set<number>; organizationInternalIds: Set<number> } {
  const userInternalIds = new Set<number>();
  const organizationInternalIds = new Set<number>();
  for (const row of rows) {
    if (row.actor_user_id != null) userInternalIds.add(row.actor_user_id);
    if (row.target_user_id != null) userInternalIds.add(row.target_user_id);
    if (row.organization_id != null) organizationInternalIds.add(row.organization_id);
  }
  return { userInternalIds, organizationInternalIds };
}

/**
 * Owns the canonical write + read paths for the audit log.
 *
 * @remarks
 * P0-#2 (audit outbox): {@link AuditService.record} now stages every audit row in
 * `audit.outbox` inside the caller's business transaction instead of opening a
 * fresh org-scoped transaction per row. The audit drain worker
 * ({@link auditOutboxDrainProcessor}) reads PENDING rows out-of-band, resolves
 * actor / target / organization public ids to internal ids, and inserts them into
 * `audit.logs`. Effects:
 *  - bulk operations no longer pay one new transaction per audit row;
 *  - audit accuracy improves — the outbox row commits atomically with the
 *    business write, so an audit can never appear without the action it audits
 *    (and vice versa);
 *  - the read path ({@link AuditService.list}) is unchanged.
 *
 * Failure modes for `record`:
 *  - RLS rejects the outbox INSERT when the caller's `app.current_organization_id`
 *    does not match the supplied `organization_public_id`. The thrown error
 *    bubbles to the audit-record wrapper, which catches + logs (the business
 *    write itself is never failed by an audit problem).
 *
 * Side effects: one INSERT into `audit.outbox`. No events emitted — audit is
 * still a write target, not an emitter.
 */
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly organizationService: OrganizationService,
    private readonly userService: UserService,
  ) {}

  /**
   * Stages an audit row in `audit.outbox` for asynchronous drain into `audit.logs`.
   *
   * @remarks
   * Algorithm:
   * 1. Validate that the caller supplied at least one actor identifier
   *    (`actorUserPublicId` or `actorApiKeyPublicId`) — otherwise we cannot
   *    attribute the row and silently drop it (preserving the prior contract).
   * 2. Build the outbox payload from the supplied public ids and free-form
   *    metadata, then call {@link insertAuditOutboxRow} which enrolls in the
   *    caller's request transaction.
   *
   * Failure modes:
   * - Missing actor → logged at warn, no-op (best-effort by contract).
   * - DB write failure → bubbles to caller; callers should go through
   *   `recordAuditEvent` so the failure is caught and logged.
   *
   * Side effects: one INSERT in the caller's open transaction.
   */
  async record(input: AuditLogRecordInput): Promise<void> {
    const hasActor =
      (typeof input.actorUserPublicId === 'string' && input.actorUserPublicId.length > 0) ||
      (typeof input.actorApiKeyPublicId === 'string' && input.actorApiKeyPublicId.length > 0);
    if (!hasActor) {
      logger.warn({ action: input.action }, 'audit.record.missingActor');
      return;
    }

    const insert = (): Promise<number> =>
      insertAuditOutboxRow({
        actorUserPublicId: input.actorUserPublicId,
        actorApiKeyPublicId: input.actorApiKeyPublicId,
        targetUserPublicId: input.target_user_public_id ?? undefined,
        organizationPublicId: input.organization_public_id ?? undefined,
        action: input.action,
        resourceType: input.resource_type,
        resourceId: input.resource_id ?? null,
        ipAddress: input.ip_address ?? null,
        userAgent: input.user_agent ?? null,
        severity: input.severity ?? 'INFO',
        metadata: input.metadata ?? {},
      });

    // sec-R10: the `audit.outbox` INSERT is gated by RLS (audit_outbox_tenant_isolation_insert:
    // org rows need `app.current_organization_id`, tenantless rows need `app.system_audit_insert`).
    // Post-sec-M4 the per-request org RLS transaction is a no-op and controllers emit audit AFTER
    // the service's withOrganizationDatabaseContext block has closed — so without establishing the
    // matching context here the bare-pool INSERT is rejected under the production core_be_app role
    // and the row is silently dropped by `recordAuditEvent`. Open the right context per row.
    if (input.organization_public_id) {
      await withPrincipalDatabaseContext(
        resolveVerifiedOrganizationPrincipalScope(input.organization_public_id),
        insert,
      );
    } else {
      await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.system_audit_insert, insert);
    }
  }

  /**
   * Lists audit log rows matching the supplied query (cursor paginated).
   *
   * @remarks
   * Algorithm:
   * 1. `validateListAuditLogsQuery` runs Zod validation and throws
   *    `ValidationError` on bad input.
   * 2. Translate optional public ids (`organization_id`, `actor_user_id`) to
   *    internal ids; when a supplied public id cannot be resolved, return an
   *    empty page immediately so the query never broadens to all visible rows.
   * 3. Repository runs the cursor-paginated query, optionally including the
   *    `total` count when `include_total === 'true'` (expensive on large
   *    histories — caller must opt in).
   *
   * Failure modes: invalid query → `ValidationError` → 400. Unknown public id
   * in a supplied filter → empty page (no repository call).
   *
   * Side effects: read-only.
   *
   * Notes: caller must already hold `audit-log:read` on the organization (enforced
   * at the tenancy route via `requireOrganizationPermission`).
   */
  async listForOrganization(organization_public_id: string, query: Record<string, unknown>) {
    return withPrincipalDatabaseContext(
      resolveVerifiedOrganizationPrincipalScope(organization_public_id),
      () => this.list(query),
    );
  }

  /**
   * Lists audit log rows for the global admin console under an explicit
   * cross-tenant RLS context.
   *
   * @remarks
   * Algorithm: wraps {@link AuditService.list} in `withMaintenanceDatabaseContext`
   * so the read runs inside a transaction with `SET LOCAL app.global_admin = true`.
   * The `audit_logs_tenant_isolation` policy honours this escape hatch, so the
   * cross-tenant listing is RLS-correct even under FORCE RLS / least-privilege
   * roles instead of silently depending on the table-owner bypass.
   *
   * Failure modes: invalid query → `ValidationError` → 400 (raised inside the
   * wrapped `list`).
   *
   * Side effects: read-only; opens one pinned transaction for the listing.
   *
   * Notes: callers must already hold a global admin role (enforced at the route
   * level via `requireRole(SUPER_ADMIN, ADMIN)`); this context bypasses tenant
   * isolation and must never be reachable without that gate.
   */
  async listForAdmin(query: Record<string, unknown>) {
    return withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () => this.list(query));
  }

  async list(query: Record<string, unknown>) {
    const parsed = validateListAuditLogsQuery(query);

    let organization_id: number | undefined;
    let actor_user_id: number | undefined;

    if (parsed.organization_id) {
      const organization = await this.organizationService.findOrganizationByPublicId(
        parsed.organization_id,
      );
      if (!organization) {
        return {
          items: [],
          resolution: { userPublicIds: new Map(), organizationPublicIds: new Map() },
          total: parsed.include_total === 'true' ? 0 : null,
          limit: parsed.limit,
          has_more: false,
          next_cursor: null,
        };
      }
      organization_id = organization.id;
    }

    if (parsed.actor_user_id) {
      const user = await this.userService.findUserRecordByPublicId(parsed.actor_user_id);
      if (!user) {
        return {
          items: [],
          resolution: { userPublicIds: new Map(), organizationPublicIds: new Map() },
          total: parsed.include_total === 'true' ? 0 : null,
          limit: parsed.limit,
          has_more: false,
          next_cursor: null,
        };
      }
      actor_user_id = user.id;
    }

    const filters: AuditLogFilters = omitUndefined({
      organization_id,
      actor_user_id,
      resource_type: parsed.resource_type,
      action: parsed.action,
      from: parsed.from,
      to: parsed.to,
      after: parsed.after,
      limit: parsed.limit,
      include_total: parsed.include_total === 'true',
    });

    const { items, total, hasMore, nextCursor } = await this.repository.findWithFilters(filters);

    // sec-re-08: batch-resolve every actor + target user id and every organization id
    // referenced on this page to its public id. The serializer surfaces those public
    // ids in place of the bigserials (which sec-re-08 drops). One SECURITY DEFINER
    // query + one in-context SELECT, no N+1 — and an empty page short-circuits both.
    const { userInternalIds, organizationInternalIds } = collectReferencedInternalIds(items);
    const [userPublicIds, organizationPublicIds] = await Promise.all([
      this.repository.resolveUserPublicIdsByInternalIds([...userInternalIds]),
      this.repository.resolveOrganizationPublicIdsByInternalIds([...organizationInternalIds]),
    ]);

    return {
      items,
      resolution: { userPublicIds, organizationPublicIds },
      total,
      limit: parsed.limit,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  }

  /**
   * Lists audit rows where the user is the actor, for GDPR data-export bundles (user-scoped RLS).
   */
  async listActivityForUserDataExport(options: { userPublicId: string; limit: number }) {
    const user = await this.userService.requireUserRecordByPublicId(options.userPublicId);
    return withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(options.userPublicId),
      (_databaseHandle) => this.repository.listActivityForUserDataExport(user.id, options.limit),
    );
  }
}
