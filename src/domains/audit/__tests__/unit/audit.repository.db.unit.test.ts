import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { AuditRepository } from '@/domains/audit/audit.repository.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { ValidationError } from '@/shared/errors/index.js';

describe('AuditRepository (database)', () => {
  const repository = new AuditRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('creates and lists audit logs with filters', async () => {
    const actor = await createTestUser({ email: 'audit-actor@example.com' });

    await repository.insert({
      actor_user_id: actor.id,
      action: 'user.login',
      resource_type: 'user',
      resource_id: actor.id,
      metadata: { ip: '127.0.0.1' },
    });

    const listed = await repository.findWithFilters({
      limit: 20,
      actor_user_id: actor.id,
    });
    expect(listed.items.length).toBeGreaterThanOrEqual(1);
    expect(listed.items[0]?.action).toBe('user.login');
  });

  it('findWithFilters applies optional filters and findRecent returns latest rows', async () => {
    const actor = await createTestUser({ email: 'audit-filter@example.com' });

    await repository.insert({
      actor_user_id: actor.id,
      action: 'organization.updated',
      resource_type: 'organization',
      resource_id: 1,
      severity: 'WARNING',
    });

    const filtered = await repository.findWithFilters({
      limit: 10,
      actor_user_id: actor.id,
      resource_type: 'organization',
      action: 'organization.updated',
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(filtered.items.some((row) => row.action === 'organization.updated')).toBe(true);

    const recent = await repository.findRecent(5);
    expect(recent.length).toBeGreaterThanOrEqual(1);
  });

  it('findWithFilters supports organization_id and unfiltered pagination', async () => {
    const actor = await createTestUser({ email: 'audit-organization@example.com' });
    const organization = await createTestOrganization({ ownerUserId: actor.id });

    await repository.insert({
      organization_id: organization.id,
      actor_user_id: actor.id,
      action: 'organization.viewed',
      resource_type: 'organization',
      resource_id: organization.id,
    });

    const byOrganization = await repository.findWithFilters({
      limit: 10,
      organization_id: organization.id,
    });
    expect(byOrganization.items.some((row) => row.action === 'organization.viewed')).toBe(true);

    const unfiltered = await repository.findWithFilters({ limit: 5 });
    expect(unfiltered.items.length).toBeGreaterThanOrEqual(1);
  });

  it('findWithFilters ignores null optional filters', async () => {
    const actor = await createTestUser({ email: 'audit-null-filters@example.com' });
    await repository.insert({
      actor_user_id: actor.id,
      action: 'user.viewed',
      resource_type: 'user',
      resource_id: actor.id,
    });

    const listed = await repository.findWithFilters({
      limit: 10,
      organization_id: null,
      actor_user_id: null,
      resource_type: null,
      action: null,
      from: null,
      to: null,
    } as never);

    expect(listed.items.some((row) => row.action === 'user.viewed')).toBe(true);
  });

  // sec-r4-D2: resolveOrganizationPublicIdsByInternalIds must filter out
  // soft-deleted organizations so a deleted org's public id does not leak into
  // serialized audit-log responses.
  it('resolveOrganizationPublicIdsByInternalIds omits soft-deleted organizations (sec-r4-D2)', async () => {
    const owner = await createTestUser({ email: 'audit-d2-owner@example.com' });
    const liveOrganization = await createTestOrganization({ ownerUserId: owner.id });
    const deletedOrganization = await createTestOrganization({ ownerUserId: owner.id });

    // Soft-delete one organization after creation.
    await database
      .update(organizations)
      .set({ deleted_at: new Date() })
      .where(eq(organizations.id, deletedOrganization.id));

    const resolved = await repository.resolveOrganizationPublicIdsByInternalIds([
      liveOrganization.id,
      deletedOrganization.id,
    ]);

    expect(resolved.get(liveOrganization.id)).toBe(liveOrganization.public_id);
    expect(resolved.has(deletedOrganization.id)).toBe(false);
  });

  // sec-U12: an opaque cursor minted under one filter set used to apply to ANY
  // future request, because the cursor encoded only `(created_at, id)`. An
  // admin could paginate with `?actor_user_id=A&after=<cursor>` and then swap
  // to `?actor_user_id=B&after=<cursor>` and the cursor would still "work" —
  // mixing result sets in confusing ways. Bind the normalized filter set into
  // the cursor (SHA-256 fingerprint) and refuse a cursor whose fingerprint
  // does not match the current request.
  describe('cursor filter-binding (sec-U12)', () => {
    it('rejects a cursor minted with a different filter set', async () => {
      const actorA = await createTestUser({ email: 'audit-bind-a@example.com' });
      const actorB = await createTestUser({ email: 'audit-bind-b@example.com' });

      // Seed two rows so the first page mints a `nextCursor`.
      for (let n = 0; n < 5; n += 1) {
        await repository.insert({
          actor_user_id: actorA.id,
          action: 'user.viewed',
          resource_type: 'user',
          resource_id: actorA.id,
        });
      }

      const firstPage = await repository.findWithFilters({
        limit: 2,
        actor_user_id: actorA.id,
      });
      expect(firstPage.nextCursor).toBeTruthy();

      // Re-using the cursor with a different actor filter must be refused —
      // the cursor was minted on the actorA query and cannot apply to actorB.
      await expect(
        repository.findWithFilters({
          limit: 2,
          actor_user_id: actorB.id,
          ...(firstPage.nextCursor !== null ? { after: firstPage.nextCursor } : {}),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts a cursor whose fingerprint matches the current filter set', async () => {
      const actor = await createTestUser({ email: 'audit-bind-match@example.com' });

      for (let n = 0; n < 4; n += 1) {
        await repository.insert({
          actor_user_id: actor.id,
          action: 'user.viewed',
          resource_type: 'user',
          resource_id: actor.id,
        });
      }

      const firstPage = await repository.findWithFilters({
        limit: 2,
        actor_user_id: actor.id,
      });
      expect(firstPage.nextCursor).toBeTruthy();

      const secondPage = await repository.findWithFilters({
        limit: 2,
        actor_user_id: actor.id,
        ...(firstPage.nextCursor !== null ? { after: firstPage.nextCursor } : {}),
      });
      // Cursor accepted — second page returns rows (the four inserts span >2
      // pages at limit=2).
      expect(secondPage.items.length).toBeGreaterThan(0);
    });
  });

  // The `include_total` count(*) is the expensive path the route's dedicated rate limit exists
  // to protect (audit.routes.ts) — yet no DB test proved it actually computes. The default
  // (keyset-only, no count) and the opt-in real count were both unverified end to end.
  it('findWithFilters returns null total by default and a real count(*) when include_total is true', async () => {
    const actor = await createTestUser({ email: 'audit-total@example.com' });
    const COUNT = 3;
    for (let n = 0; n < COUNT; n += 1) {
      await repository.insert({
        actor_user_id: actor.id,
        action: `user.counted.${n}`,
        resource_type: 'user',
        resource_id: actor.id,
      });
    }

    const withoutTotal = await repository.findWithFilters({ limit: 20, actor_user_id: actor.id });
    expect(withoutTotal.total).toBeNull();

    const withTotal = await repository.findWithFilters({
      limit: 20,
      actor_user_id: actor.id,
      include_total: true,
    });
    expect(withTotal.total).toBe(COUNT);
  });

  // GDPR export correctness: `listActivityForUserDataExport` feeds the user's data-export bundle.
  // A wrong filter would leak another user's activity into the subject's export; a wrong limit
  // would truncate it. Only mocked from the user-data-export side — never run against real SQL.
  it('listActivityForUserDataExport returns only the subject actor rows, capped at the limit', async () => {
    const subject = await createTestUser({ email: 'audit-export-subject@example.com' });
    const other = await createTestUser({ email: 'audit-export-other@example.com' });

    // Another actor's activity must never appear in the subject's export.
    await repository.insert({
      actor_user_id: other.id,
      action: 'other.login',
      resource_type: 'user',
      resource_id: other.id,
    });
    for (let n = 0; n < 3; n += 1) {
      await repository.insert({
        actor_user_id: subject.id,
        action: `subject.action.${n}`,
        resource_type: 'user',
        resource_id: subject.id,
      });
    }

    const activity = await repository.listActivityForUserDataExport(subject.id, 2);

    // Capped at the limit, and every row is the subject's — no cross-actor leak.
    expect(activity).toHaveLength(2);
    expect(activity.every((row) => row.action.startsWith('subject.action.'))).toBe(true);
  });
});
