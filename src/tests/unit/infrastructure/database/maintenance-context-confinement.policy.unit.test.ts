import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_CONTEXTS,
  type MaintenanceContextKind,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Policy: each maintenance (bypass) scope kind may only be referenced from the
 * code paths that legitimately hold that authority — workers, admin-authorized
 * flows, and trusted system code. The allowlist below is per kind and iterated
 * from the same registry the wrapper dispatches on, so a new kind cannot ship
 * without declaring who may use it.
 */
const ALLOWED_PATH_FRAGMENTS: Record<MaintenanceContextKind, readonly string[]> = {
  global_retention_cleanup: [
    '/workers/', // retention / tombstone / offboarding processors across domains
    'notification.repository.ts', // retention delete helper invoked by the notify retention worker
    'worker-runtime/worker-processor.util.ts', // runGlobalRetentionWorkerJob
    'scripts/ops/', // operator reconcile scripts
    // Tombstoning soft-delete: sec-new-D3 hides the tombstoned NEW row from the tenant
    // SELECT arm, so the final UPDATE must carry the retention arm (see the service).
    'organization/organization.service.ts',
  ],
  session_retention_cleanup: ['auth-session/workers/'],
  global_admin: [
    'user/user.service.ts', // admin user suspend / soft-delete / cross-user actor lookups
    'audit/audit.service.ts', // admin audit listing
    'notification/workers/notification.worker.ts', // cross-user recipient resolution
    'queue/dlq/dlq-replay.util.ts', // replay-audit actor lookup (cross-user read)
    'tests/helpers/rls-matrix.helper.ts',
  ],
  system_audit_insert: [
    'audit/audit.service.ts', // tenantless outbox staging
    'queue/dlq/', // DLQ replay audit entries
  ],
  audit_outbox_drain: ['audit/audit-outbox.repository.ts', 'audit/workers/'],
  system_table_retention: [
    'stripe-webhook/workers/', // stripe_webhook_events ledger retention (non-RLS table)
  ],
  system_table_worker: [
    'notification/workers/notification.worker.ts', // web-push subscription reads outside a request
    'stripe-webhook/stripe-webhook.service.ts', // webhook-event ledger claim/settle
    'stripe-webhook/workers/', // catchup / reclaim processors over the ledger
    'infrastructure/mail/workers/', // mail outbox reads/settles around external sends
    'metrics/business-metrics.ts', // Prometheus gauges over system tables
    'queue/commit-dispatch/commit-dispatch.executor.ts', // commit-dispatch store access
    'queue/dlq/dlq-auto-retry.processor.ts', // DLQ replay bookkeeping
  ],
};

describe('maintenance-context confinement', () => {
  it.each(Object.keys(MAINTENANCE_CONTEXTS) as MaintenanceContextKind[])(
    'MAINTENANCE_SCOPE.%s is referenced only from its allowlisted paths (and tests)',
    (kind) => {
      let output = '';
      try {
        output = execFileSync(
          'grep',
          ['-rl', `MAINTENANCE_SCOPE.${kind}`, 'src', '--include=*.ts'],
          { encoding: 'utf8' },
        );
      } catch {
        // no matches — trivially confined
      }

      const offenders = output
        .split('\n')
        .filter(Boolean)
        .filter((filePath) => !/\.test\.ts$/.test(filePath))
        .filter(
          (filePath) =>
            !ALLOWED_PATH_FRAGMENTS[kind].some((fragment) => filePath.includes(fragment)),
        );

      expect(
        offenders,
        `MAINTENANCE_SCOPE.${kind} referenced outside its allowlisted paths: ${offenders.join(', ')}. ` +
          'Bypass authority is per-path — extend ALLOWED_PATH_FRAGMENTS deliberately, never casually.',
      ).toEqual([]);
    },
  );
});
