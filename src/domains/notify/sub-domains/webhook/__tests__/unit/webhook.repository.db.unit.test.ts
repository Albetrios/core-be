import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { WebhookRepository } from '@/domains/notify/sub-domains/webhook/webhook.repository.js';
import { webhooks } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('WebhookRepository (database)', () => {
  const repository = new WebhookRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('creates, finds, updates, and soft-deletes webhooks', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const created = await repository.create({
      organization_id: organization.id,
      url: 'https://example.com/hook',
      encrypted_secret: 'secret',
      events: ['subscription.updated'],
      is_enabled: true,
      created_by_user_id: user.id,
    });

    const found = await repository.findByPublicId(created.public_id, organization.id);
    expect(found?.url).toBe('https://example.com/hook');

    const listed = await repository.listByOrganization(organization.id, { limit: 20 });
    expect(listed.items.length).toBeGreaterThanOrEqual(1);
    expect(listed.total).toBeNull();

    const updated = await repository.update(
      created.public_id,
      organization.id,
      { url: 'https://example.com/updated', is_enabled: false },
      user.id,
    );
    expect(updated?.is_enabled).toBe(false);

    const deleted = await repository.softDelete(created.public_id, organization.id);
    expect(deleted?.deleted_at).not.toBeNull();

    const subscribed = await repository.listEnabledSubscribedToEvent(
      organization.id,
      'subscription.updated',
    );
    expect(subscribed).toHaveLength(0);
  });

  it('audit-#4: re-creating at a soft-deleted URL resurrects the row (upsert), no unique violation', async () => {
    // Verifies the audit-#4 finding is a non-issue: create() upserts ON CONFLICT
    // (organization_id, url) and clears deleted_at, so re-adding a webhook at a
    // previously deleted URL succeeds by resurrecting the existing row rather than
    // throwing a unique violation. The full unique index is required for this.
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const url = 'https://example.com/recreatable-hook';

    const first = await repository.create({
      organization_id: organization.id,
      url,
      encrypted_secret: 'secret-v1',
      events: ['subscription.updated'],
      is_enabled: true,
      created_by_user_id: user.id,
    });
    const deleted = await repository.softDelete(first.public_id, organization.id);
    expect(deleted?.deleted_at).not.toBeNull();

    const recreated = await repository.create({
      organization_id: organization.id,
      url,
      encrypted_secret: 'secret-v2',
      events: ['subscription.updated'],
      is_enabled: true,
      created_by_user_id: user.id,
    });

    // Same row, resurrected: deleted_at cleared and the secret/events updated.
    expect(recreated.public_id).toBe(first.public_id);
    expect(recreated.deleted_at).toBeNull();
    const found = await repository.findByPublicId(recreated.public_id, organization.id);
    expect(found?.url).toBe(url);
  });

  it('listEnabledSubscribedToEvent returns enabled webhooks for event', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    await repository.create({
      organization_id: organization.id,
      url: 'https://example.com/subscribed',
      encrypted_secret: 'secret',
      events: ['subscription.updated'],
      is_enabled: true,
      created_by_user_id: user.id,
    });

    const subscribed = await repository.listEnabledSubscribedToEvent(
      organization.id,
      'subscription.updated',
    );
    expect(subscribed.length).toBeGreaterThanOrEqual(1);
    expect(subscribed[0]?.url).toBe('https://example.com/subscribed');
  });

  it('listEnabledSubscribedToEvent paginates past the first page of webhooks', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const baseCreatedAt = Date.now();

    for (let index = 0; index < 11; index += 1) {
      const created = await repository.create({
        organization_id: organization.id,
        url: `https://example.com/hook-${index}-${baseCreatedAt}`,
        encrypted_secret: 'secret',
        events: index === 10 ? ['subscription.updated'] : ['user.created'],
        is_enabled: index !== 0,
        created_by_user_id: user.id,
      });
      const orderedCreatedAt = new Date(baseCreatedAt + index * 1_000);
      await database
        .update(webhooks)
        .set({ created_at: orderedCreatedAt, updated_at: orderedCreatedAt })
        .where(eq(webhooks.id, created.id));
    }

    const subscribed = await repository.listEnabledSubscribedToEvent(
      organization.id,
      'subscription.updated',
      10,
    );

    expect(subscribed).toHaveLength(1);
    expect(subscribed[0]?.url).toContain('hook-10-');
  });

  describe('listByOrganization (keyset cursor pagination)', () => {
    async function createWebhooks(organizationId: number, userId: number, count: number) {
      const baseCreatedAt = Date.now();
      for (let index = 0; index < count; index += 1) {
        const created = await repository.create({
          organization_id: organizationId,
          url: `https://example.com/hook-${index}-${baseCreatedAt}`,
          encrypted_secret: 'secret',
          events: ['subscription.updated'],
          is_enabled: true,
          created_by_user_id: userId,
        });
        const orderedCreatedAt = new Date(baseCreatedAt + index * 1_000);
        await database
          .update(webhooks)
          .set({ created_at: orderedCreatedAt, updated_at: orderedCreatedAt })
          .where(eq(webhooks.id, created.id));
      }
    }

    it('omits total by default, sets has_more=true, and returns opaque next_cursor when more pages exist', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      await createWebhooks(organization.id, user.id, 3);

      const page1 = await repository.listByOrganization(organization.id, { limit: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.next_cursor).toBeTypeOf('string');
      expect(page1.next_cursor).not.toBe('');
      expect(page1.total).toBeNull();
    });

    it('navigating with `after` returns the next batch and stops at the final page', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      await createWebhooks(organization.id, user.id, 3);

      const page1 = await repository.listByOrganization(organization.id, { limit: 2 });
      expect(page1.has_more).toBe(true);
      expect(page1.next_cursor).toBeTypeOf('string');

      const page2 = await repository.listByOrganization(organization.id, {
        limit: 2,
        after: page1.next_cursor!,
      });

      const page1Ids = new Set(page1.items.map((item) => item.id));
      for (const item of page2.items) {
        expect(page1Ids.has(item.id)).toBe(false);
      }
      expect(page1.items.length + page2.items.length).toBe(3);
      expect(page2.has_more).toBe(false);
      expect(page2.next_cursor).toBeNull();
    });

    it('returns has_more=false and next_cursor=null when the page exactly fits the limit', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      await createWebhooks(organization.id, user.id, 2);

      const result = await repository.listByOrganization(organization.id, { limit: 2 });

      expect(result.items).toHaveLength(2);
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
    });

    it('returns empty result without total when no rows match', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });

      const result = await repository.listByOrganization(organization.id, { limit: 10 });

      expect(result.items).toEqual([]);
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
      expect(result.total).toBeNull();
    });

    it('returns total when include_total=true is requested', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      await createWebhooks(organization.id, user.id, 3);

      const result = await repository.listByOrganization(organization.id, {
        limit: 2,
        include_total: true,
      });

      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(2);
      expect(result.has_more).toBe(true);
    });

    it('does not include soft-deleted webhooks in results or total', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      await createWebhooks(organization.id, user.id, 2);

      const all = await repository.listByOrganization(organization.id, {
        limit: 10,
        include_total: true,
      });
      const firstPublicId = all.items[0]!.public_id;
      await repository.softDelete(firstPublicId, organization.id);

      const afterDelete = await repository.listByOrganization(organization.id, {
        limit: 10,
        include_total: true,
      });

      expect(afterDelete.items).toHaveLength(1);
      expect(afterDelete.total).toBe(1);
    });
  });

  describe('chk_webhooks_updated invariant (updated_at never precedes created_at)', () => {
    it('soft-delete and update succeed even when created_at is ahead of now()', async () => {
      const user = await createTestUser({ email: 'webhook-updated-at@test.com' });
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const created = await repository.create({
        organization_id: organization.id,
        url: 'https://example.com/future-hook',
        encrypted_secret: 'secret',
        events: ['subscription.updated'],
        is_enabled: true,
        created_by_user_id: user.id,
      });

      // Force the flake condition: created_at AHEAD of now() (set updated_at too so the row stays
      // valid). Previously a later mutation's `updated_at = now()` would be < created_at and violate
      // chk_webhooks_updated; greatest(created_at, now()) keeps the invariant true.
      const future = new Date(Date.now() + 60 * 60 * 1000);
      await database
        .update(webhooks)
        .set({ created_at: future, updated_at: future })
        .where(eq(webhooks.public_id, created.public_id));

      // update() must not violate the CHECK...
      const updated = await repository.update(
        created.public_id,
        organization.id,
        { is_enabled: false },
        user.id,
      );
      expect(updated?.is_enabled).toBe(false);

      // ...and neither must soft-delete.
      const deleted = await repository.softDelete(created.public_id, organization.id);
      expect(deleted?.deleted_at).not.toBeNull();
    });

    it('route-audit C3: re-adding a soft-deleted webhook with created_at ahead of now() holds the invariant', async () => {
      const user = await createTestUser({ email: 'webhook-c3@test.com' });
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const created = await repository.create({
        organization_id: organization.id,
        url: 'https://example.com/c3-hook',
        encrypted_secret: 'secret',
        events: ['subscription.updated'],
        is_enabled: true,
        created_by_user_id: user.id,
      });

      // Soft-delete, then force created_at (and updated_at, to stay valid) into the future.
      await repository.softDelete(created.public_id, organization.id);
      const future = new Date(Date.now() + 60 * 60 * 1000);
      await database
        .update(webhooks)
        .set({ created_at: future, updated_at: future })
        .where(eq(webhooks.public_id, created.public_id));

      // Re-add (same organization+url) resurrects the row via onConflictDoUpdate. Pre-fix, updated_at =
      // new Date() (JS clock) could be < the future created_at and violate chk_webhooks_updated;
      // greatest(created_at, now()) keeps it valid.
      const revived = await repository.create({
        organization_id: organization.id,
        url: 'https://example.com/c3-hook',
        encrypted_secret: 'secret-rotated',
        events: ['subscription.updated'],
        is_enabled: true,
        created_by_user_id: user.id,
      });
      expect(revived.public_id).toBe(created.public_id);
      expect(revived.deleted_at).toBeNull();
    });
  });
});
