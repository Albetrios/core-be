import { trace } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import {
  describeScope,
  MAINTENANCE_SCOPE,
  PRINCIPAL_SCOPE,
  SESSION_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: { transaction: vi.fn(async (_callback: (t: unknown) => Promise<unknown>) => null) },
}));

/**
 * The accepted scope enrichments describe, never decide: `describeScope` and
 * the OTel span attributes only RENDER a scope — neither can change what gets
 * armed, so neither can change row visibility.
 */
describe('scope observability enrichments (describe, never decide)', () => {
  it('describeScope renders each family, redacting session artifact values', () => {
    expect(
      describeScope(
        PRINCIPAL_SCOPE.JOB({
          organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
          userPublicId: 'usr_a1b2c3d4e5f6g7h8i9j0k',
        }),
      ),
    ).toBe('principal(job organization=org_a1b2c3d4e5f6g7h8i9j0k user=usr_a1b2c3d4e5f6g7h8i9j0k)');
    expect(describeScope(MAINTENANCE_SCOPE.GLOBAL_ADMIN)).toBe('maintenance(GLOBAL_ADMIN)');
    const rendered = describeScope(SESSION_SCOPE.ARTIFACT({ sessionTokenHash: 'secret-hash' }));
    expect(rendered).toBe('session(sessionTokenHash set)');
    expect(rendered).not.toContain('secret-hash');
  });

  it('stamps the active span with scope attributes on maintenance contexts', async () => {
    const setAttribute = vi.fn();
    const spy = vi
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue({ setAttribute } as unknown as ReturnType<typeof trace.getActiveSpan>);
    try {
      await withMaintenanceDatabaseContext(
        MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER,
        async () => undefined,
      );
    } catch {
      // The mocked pool may reject deeper in the runtime — attributes are set first.
    }
    expect(setAttribute).toHaveBeenCalledWith('rls.scope.family', 'maintenance');
    expect(setAttribute).toHaveBeenCalledWith('rls.scope.kind', 'SYSTEM_TABLE_WORKER');
    spy.mockRestore();
  });
});
