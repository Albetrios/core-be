import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectRoute } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { buildStripeWebhookTestSignatureHeader } from '@/tests/contract/helpers/stripe-signature.js';
import { stripe_webhook_events } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.schema.js';
import { database } from '@/infrastructure/database/connection.js';
import { env } from '@/shared/config/env.config.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Replay defence for the PUBLIC webhook ingress, end to end.
 *
 * A `Stripe-Signature` header stays cryptographically valid forever — the secret does not
 * change when the delivery is captured — so only two things stop an attacker from replaying a
 * recorded webhook indefinitely: the signed timestamp measured against
 * `STRIPE_WEBHOOK_TOLERANCE_SECONDS` (halved to 150s by audit #22) and the ledger's unique
 * event id. Both were proven at the unit layer (`stripe-webhook-construct-event.unit.test.ts`
 * mocks the tolerance directly); neither was observed at the route, where the raw-body capture,
 * the ingress plugin, and the ledger write all have to line up for the defence to hold.
 *
 * Placed in the integration tier rather than `src/tests/security/` deliberately: the security
 * project shares one global per-IP rate-limit budget (`RATE_LIMIT_MAX`, keyed on `127.0.0.1`
 * in Redis) across every file running in parallel, and these cases each post several webhooks.
 */
describe('Stripe webhook — replay defence', () => {
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

  /**
   * Builds a `customer.subscription.updated` payload for a real local subscription so an
   * accepted delivery has something to reconcile against. Pass `timestampSeconds` to sign the
   * payload as of an arbitrary moment — the shape of a captured-and-replayed delivery.
   */
  async function buildSignedWebhookFixture(options: { timestampSeconds?: number } = {}) {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const plan = await createTestPlan();
    const subscription = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      providerSubscriptionId: `sub_replay_${generatePublicId('subscription')}`,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const stripeEventId = `evt_replay_${generatePublicId('subscription')}`;
    const rawPayload = JSON.stringify({
      id: stripeEventId,
      object: 'event',
      type: 'customer.subscription.updated',
      created: nowSeconds,
      data: {
        object: {
          id: subscription.provider_subscription_id,
          object: 'subscription',
          status: 'active',
          items: {
            data: [
              {
                current_period_start: nowSeconds,
                current_period_end: nowSeconds + 86_400,
              },
            ],
          },
        },
      },
    });
    const signature = buildStripeWebhookTestSignatureHeader({
      rawPayload,
      webhookSigningSecret: env.STRIPE_WEBHOOK_SECRET as string,
      ...(options.timestampSeconds !== undefined
        ? { timestampSeconds: options.timestampSeconds }
        : {}),
    });
    return { stripeEventId, rawPayload, signature };
  }

  function postWebhook(rawPayload: string, signature: string) {
    return injectRoute(app, {
      method: 'POST',
      url: testApiPath('/billing/webhook'),
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload: Buffer.from(rawPayload),
    });
  }

  /** Seconds-since-epoch a full day beyond the configured tolerance window. */
  function staleTimestampSeconds(): number {
    return Math.floor(Date.now() / 1000) - (env.STRIPE_WEBHOOK_TOLERANCE_SECONDS + 86_400);
  }

  it('refuses a delivery signed outside the tolerance window', async () => {
    if (!env.STRIPE_WEBHOOK_SECRET) return;
    // The HMAC still verifies — the secret has not changed — so only the timestamp check can
    // reject this. That makes it a direct test of the replay window, not of signing.
    const { rawPayload, signature } = await buildSignedWebhookFixture({
      timestampSeconds: staleTimestampSeconds(),
    });

    const response = await postWebhook(rawPayload, signature);

    expect(response.statusCode).toBe(400);
  });

  it('writes no ledger row for a refused stale delivery', async () => {
    if (!env.STRIPE_WEBHOOK_SECRET) return;
    // Rejection must happen before ingestion: a ledger row for a refused delivery would both
    // pollute the reclaim sweep and let an attacker seed arbitrary event ids.
    const { stripeEventId, rawPayload, signature } = await buildSignedWebhookFixture({
      timestampSeconds: staleTimestampSeconds(),
    });

    await postWebhook(rawPayload, signature);

    const rows = await database
      .select()
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
    expect(rows).toHaveLength(0);
  });

  it('accepts a fresh delivery and deduplicates its replay to a single ledger row', async () => {
    if (!env.STRIPE_WEBHOOK_SECRET) return;
    // The contrast that makes the two refusals meaningful: inside the window the identical
    // construction is accepted, and the ledger's unique event id absorbs the replay — a
    // replayed delivery inside the window is idempotent rather than reprocessed.
    const { stripeEventId, rawPayload, signature } = await buildSignedWebhookFixture();

    const first = await postWebhook(rawPayload, signature);
    const replay = await postWebhook(rawPayload, signature);

    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    const rows = await database
      .select()
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
    expect(rows).toHaveLength(1);
  });
});
