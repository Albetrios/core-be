import { sql as drizzleSql } from 'drizzle-orm';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/request-database.context.js';

/**
 * `SET LOCAL ROLE core_be_app` on a context-wrapper transaction handle so RLS
 * security tests connected as the privileged `core` owner role exercise the
 * policies the application role sees in production.
 *
 * @remarks
 * Call as the FIRST statement inside a context-wrapper callback (the GUCs the
 * wrapper already set persist across `SET ROLE`, so ordering after the wrapper's
 * own `set_config` is safe). This replaces the former `useApplicationDatabaseRole`
 * option on the production wrappers — role switching is a test-harness concern,
 * not a production code path.
 */
export async function applyApplicationDatabaseRole(
  databaseHandle: RequestScopedPostgresDatabase,
): Promise<void> {
  await databaseHandle.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
}
