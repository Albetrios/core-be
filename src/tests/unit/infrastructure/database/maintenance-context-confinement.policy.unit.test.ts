import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_CONTEXTS,
  type MaintenanceContextKind,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';

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
  ],
  session_retention_cleanup: ['auth-session/workers/'],
  global_admin: [
    'user/user.service.ts', // admin user suspend / soft-delete / cross-user actor lookups
    'audit/audit.service.ts', // admin audit listing
    'notification/workers/notification.worker.ts', // cross-user recipient resolution
    'tests/helpers/rls-matrix.helper.ts',
  ],
  system_audit_insert: [
    'audit/audit.service.ts', // tenantless outbox staging
    'queue/dlq/', // DLQ replay audit entries
  ],
  audit_outbox_drain: ['audit/audit-outbox.repository.ts', 'audit/workers/'],
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
