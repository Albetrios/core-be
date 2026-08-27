import { describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const maintenancePoolHandle = { tag: 'maintenance-pool' };

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: { tag: 'shared-pool' },
  getMaintenanceDatabase: () => maintenancePoolHandle,
}));

describe('maintenance context pool selection', () => {
  it('non-transactional maintenance kinds hand the callback the maintenance pool handle', async () => {
    // Outside worker runtime the system_table_worker kind passes the pool straight
    // through — routing it via getMaintenanceDatabase() is what lets an operator
    // move ALL bypass contexts onto the dedicated core_be_maintenance connection
    // by provisioning DATABASE_MAINTENANCE_URL (no code change).
    await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.system_table_worker, async (handle) => {
      expect(handle).toBe(maintenancePoolHandle);
    });
  });
});
