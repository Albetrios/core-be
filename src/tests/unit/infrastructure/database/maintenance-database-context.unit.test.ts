import { describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const executeMock = vi.fn().mockResolvedValue(undefined);
const transactionMock = vi.fn();

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: {
    transaction: (...arguments_: unknown[]) => transactionMock(...arguments_),
  },
}));

describe('withMaintenanceDatabaseContext', () => {
  it('sets app.global_retention_cleanup and passes transaction handle to callback', async () => {
    const callback = vi.fn().mockResolvedValue('ok');
    const databaseHandle = { execute: executeMock };

    transactionMock.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) => callback(databaseHandle),
    );

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      callback,
    );

    expect(result).toBe('ok');
    expect(executeMock).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(databaseHandle);
  });
});
