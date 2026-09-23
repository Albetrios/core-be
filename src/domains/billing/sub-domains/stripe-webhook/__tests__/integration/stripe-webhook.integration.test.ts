import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { eq } from 'drizzle-orm';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectUnauthenticated, injectRoute } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { env } from '@/shared/config/env.config.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { stripe_webhook_events } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.schema.js';
import { buildStripeWebhookTestSignatureHeader } from '@/tests/contract/helpers/stripe-signature.js';
import type { FastifyInstance } from 'fastify';

describe('Stripe Webhook Sub-Domain — Integration', () => {
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
  });

  describe('POST /api/v1/billing/webhook', () => {
    it('should return 400 for missing signature', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/billing/webhook'),
        payload: { type: 'test' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 400 for invalid stripe-signature header', async () => {
      const response = await injectRoute(app, {
        method: 'POST',
        url: testApiPath('/billing/webhook'),
        headers: { 'stripe-signature': 'invalid' },
        payload: { type: 'customer.subscription.updated', data: { object: {} } },
      });
      expect(response.statusCode).toBe(400);
    });

    it('duplicate signed POST records a single webhook ledger row', async () => {
      const webhookSigningSecret = env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSigningSecret) {
        return;
      }

      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const plan = await createTestPlan();
      const subscription = await createTestSubscription({
        organizationId: organization.id,
        planId: plan.id,
        providerSubscriptionId: `sub_dup_${Date.now()}`,
      });

      const stripeEventId = `evt_dup_${Date.now()}`;
      const eventPayload = {
        id: stripeEventId,
        object: 'event',
        type: 'customer.subscription.updated',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: subscription.provider_subscription_id,
            object: 'subscription',
            status: 'active',
            items: {
              data: [
                {
                  current_period_start: Math.floor(Date.now() / 1000),
                  current_period_end: Math.floor(Date.now() / 1000) + 86_400,
                },
              ],
            },
          },
        },
      };
      const rawPayload = JSON.stringify(eventPayload);
      const stripeSignature = buildStripeWebhookTestSignatureHeader({
        rawPayload,
        webhookSigningSecret,
      });

      const firstPost = await injectRoute(app, {
        method: 'POST',
        url: testApiPath('/billing/webhook'),
        headers: {
          'stripe-signature': stripeSignature,
          'content-type': 'application/json',
        },
        payload: Buffer.from(rawPayload),
      });
      const secondPost = await injectRoute(app, {
        method: 'POST',
        url: testApiPath('/billing/webhook'),
        headers: {
          'stripe-signature': stripeSignature,
          'content-type': 'application/json',
        },
        payload: Buffer.from(rawPayload),
      });

      expect(firstPost.statusCode, firstPost.body).toBe(200);
      expect(secondPost.statusCode, secondPost.body).toBe(200);

      const firstBody = firstPost.json() as {
        data: { received: boolean };
        meta: { request_id: string };
      };
      expect(firstBody.data).toEqual({ received: true });
      expect(typeof firstBody.meta.request_id).toBe('string');
      expect(firstBody.meta.request_id.length).toBeGreaterThan(0);

      const ledgerRows = await database
        .select()
        .from(stripe_webhook_events)
        .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
      expect(ledgerRows).toHaveLength(1);
      expect(['processing', 'processed']).toContain(ledgerRows[0]?.processing_status);
    });
  });
});
