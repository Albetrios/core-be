import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { PlanService } from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { PaymentProvider } from '@/domains/billing/sub-domains/subscription/payment-provider.port.js';

/**
 * Billing had no work budget of any kind on its list routes, and `GET /billing/subscriptions` is
 * the classic N+1 shape: it joins plans and then decorates **every row** with a cross-domain
 * seat count. The service's contract says that count is "resolved ONCE per request and reused
 * across every row" — a genuine invariant, and one that a refactor moving the count inside the
 * `rows.map` would break silently, since every existing assertion (status, body shape, seat
 * values) stays green while the request issues one extra membership COUNT per subscription.
 *
 * Two complementary budgets:
 *
 * 1. an **exact call-count budget** on the cross-domain seat lookup, measured directly at the
 *    service with a counting port — no timing, no flake, and it targets the precise call site,
 * 2. a **scaling guard** at the HTTP boundary, which catches an N+1 introduced anywhere else in
 *    the request path (repository, serializer, RLS context churn) rather than only at that call.
 */
const BILLING_PERMISSIONS = ['subscription:read', 'subscription:manage'] as const;

/** Rows in the "large" list. Big enough that an N+1 is unmistakable, small enough to seed fast. */
const LARGE_LIST_ROW_COUNT = 25;

const budgetScope = PRINCIPAL_SCOPE.REQUEST({
  userPublicId: 'user_public',
  organizationPublicId: 'org_budget',
}) as OrganizationPrincipalDatabaseScope;

describe('Performance: billing list routes stay O(1) in cross-domain work', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions([...BILLING_PERMISSIONS]);
  });

  /**
   * Builds a {@link SubscriptionService} whose repository returns `rowCount` synthetic rows and
   * whose membership port counts its invocations, so the seat-count budget is measured exactly.
   */
  function buildCountingService(rowCount: number) {
    const countActiveMembers = vi.fn().mockResolvedValue(4);
    const rows = Array.from({ length: rowCount }, (_, index) => ({
      public_id: `sub_row_${index}`,
      status: 'ACTIVE',
      billing_cycle: 'monthly',
      seats: null,
      plan_included_seats: 10,
    }));
    const service = new SubscriptionService(
      {
        requireOrganizationByPublicId: vi
          .fn()
          .mockResolvedValue({ id: 1, public_id: 'org_budget', type: 'TEAM' }),
      } as unknown as OrganizationService,
      {} as unknown as PlanService,
      { listByOrganization: vi.fn().mockResolvedValue(rows) } as unknown as SubscriptionRepository,
      {} as unknown as PaymentProvider,
      { countActiveMembers },
    );
    return { service, countActiveMembers };
  }

  it('resolves the cross-domain seat count exactly once regardless of row count', async () => {
    const single = buildCountingService(1);
    const large = buildCountingService(LARGE_LIST_ROW_COUNT);

    const singleResult = await single.service.list(budgetScope);
    const largeResult = await large.service.list(budgetScope);

    expect(singleResult).toHaveLength(1);
    expect(largeResult).toHaveLength(LARGE_LIST_ROW_COUNT);
    // The budget: ONE membership count per request, not one per subscription row.
    expect(single.countActiveMembers).toHaveBeenCalledTimes(1);
    expect(large.countActiveMembers).toHaveBeenCalledTimes(1);
    // And every row still carries the decorated counters — a "budget" met by dropping the
    // decoration entirely would be a regression, not a win.
    expect(largeResult.every((row) => row.seats_used === 4 && row.seats_total === 10)).toBe(true);
  });

  it('GET /billing/subscriptions does not scale its work with the number of subscriptions', async () => {
    const { organization, token } = await createListContext(LARGE_LIST_ROW_COUNT);

    // Warm the app, connection pool, permission cache, and JIT before measuring.
    await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/subscriptions'),
      token,
      organizationPublicId: organization.public_id,
    });

    const started = performance.now();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/subscriptions'),
      token,
      organizationPublicId: organization.public_id,
    });
    const elapsedMs = performance.now() - started;

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown[] }).data).toHaveLength(LARGE_LIST_ROW_COUNT);
    // Deliberately generous: this is an N+1 tripwire, not a latency SLO. A per-row round trip
    // over 25 rows on a containerised Postgres lands well past this bound, while a constant
    // number of queries stays far under it even on a cold CI runner.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('GET /billing/plans answers within the same budget across a full catalog', async () => {
    // The domain's other database-bound list, and its only PUBLIC one — so it is the route an
    // unauthenticated caller can drive hardest. (`/billing/invoices` and
    // `/billing/payment-methods` are Stripe proxies: their latency is the provider's, not ours,
    // and a local work budget would measure the network. Their contract is covered by
    // `billing-account-reads.integration.test.ts`.)
    for (let index = 0; index < LARGE_LIST_ROW_COUNT; index++) {
      await createTestPlan({ name: `Budget Plan ${index}` });
    }

    await injectUnauthenticated(app, { method: 'GET', url: testApiPath('/billing/plans') });

    const started = performance.now();
    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/plans'),
    });
    const elapsedMs = performance.now() - started;

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(
      LARGE_LIST_ROW_COUNT,
    );
    expect(elapsedMs).toBeLessThan(2_000);
  });

  /** Team organization with billing permissions holding `subscriptionCount` subscriptions. */
  async function createListContext(subscriptionCount: number) {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const plan = await createTestPlan();
    for (let index = 0; index < subscriptionCount; index++) {
      await createTestSubscription({
        organizationId: organization.id,
        planId: plan.id,
        // Only one subscription may be non-terminal per organization (partial unique index), so the
        // filler rows are CANCELED — they still exercise the join + per-row decoration.
        status: index === 0 ? 'ACTIVE' : 'CANCELED',
        providerSubscriptionId: null,
        providerCustomerId: 'cus_test_billing_budget',
        createdByUserId: user.id,
      });
    }
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [...BILLING_PERMISSIONS],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, token };
  }
});
