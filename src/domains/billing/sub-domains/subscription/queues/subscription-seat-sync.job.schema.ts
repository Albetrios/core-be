import { z } from 'zod';
import { traceContextJobFieldsSchema } from '@/infrastructure/observability/tracing/trace-context-job-fields.schema.js';
import { dlqReplayJobFieldsSchema } from '@/infrastructure/queue/dlq/dlq-replay-job-fields.schema.js';

/**
 * Redis payload for a seat-quantity-sync job (REQ-4). Carries `organizationPublicId` so the
 * worker re-enters Postgres under the organization RLS context; the worker re-reads the authoritative
 * member count + active subscription rather than trusting any count baked into the job.
 */
export const subscriptionSeatSyncJobDataSchema = z
  .object({
    organizationPublicId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(128).optional(),
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .extend(traceContextJobFieldsSchema.shape)
  .extend(dlqReplayJobFieldsSchema.shape);

/** Inferred validated payload type for jobs on the seat-quantity-sync queue. */
export type SubscriptionSeatSyncJobDataValidated = z.infer<
  typeof subscriptionSeatSyncJobDataSchema
>;
