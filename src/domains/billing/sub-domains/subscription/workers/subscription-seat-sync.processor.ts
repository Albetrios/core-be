import type { SubscriptionSeatSyncJobData } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';

/**
 * Narrow service contract the seat-sync processor needs (REQ-4) — kept minimal so the worker
 * composition root supplies only the subscription service.
 *
 * @remarks
 * - **Algorithm:** structural type alias; the single method reconciles the Stripe quantity for an organization.
 * - **Failure modes:** none — type only (the implementer's failures propagate to the processor).
 * - **Side effects:** none on this type.
 * - **Notes:** satisfied by billing's `SubscriptionService`; declared narrowly so the worker does not
 *   depend on the full container surface.
 */
export type SubscriptionSeatSyncService = {
  syncSeatQuantityForOrganization(
    organizationPublicId: string,
    idempotencyKey?: string,
  ): Promise<void>;
};

/**
 * Worker entry point for `subscription-seat-sync` jobs (REQ-4): pushes the org's current member
 * count to the Stripe subscription quantity and persists the synced `subscriptions.seats`.
 *
 * @remarks
 * - **Algorithm:** pure delegate to {@link SubscriptionSeatSyncService.syncSeatQuantityForOrganization},
 *   which phases its own DB contexts around the Stripe call (no checkout held across the round trip).
 *   The worker logs the tenant-scoped boundary; this function just forwards the organization id + idempotency key.
 * - **Failure modes:** a Stripe outage propagates so BullMQ retries with backoff; each enqueue is a
 *   distinct job that re-reads the live member count, so the newest job reconciles the final state.
 * - **Side effects:** at most one Stripe update + one local `subscriptions.seats` write per run.
 * - **Notes:** the job carries `organizationPublicId`; the service (not this processor) establishes
 *   the organization RLS context, so no worker repository handle is threaded here.
 */
export async function processSubscriptionSeatSyncJob(
  jobData: SubscriptionSeatSyncJobData,
  service: SubscriptionSeatSyncService,
): Promise<void> {
  const { organizationPublicId, idempotencyKey } = jobData;
  await service.syncSeatQuantityForOrganization(organizationPublicId, idempotencyKey);
}
