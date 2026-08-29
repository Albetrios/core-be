import { z } from 'zod';
import { trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';

/**
 * Zod schema for routes that carry the `invitation_id` path param — the organization-scoped
 * revoke / resend under `/organization/invitations/:invitation_id` and the
 * invitee-facing `/invitations/:invitation_id/accept`.
 */
export const invitationIdParamsDto = z
  .object({
    invitation_id: trimmedStringMinMax(1, 28),
  })
  .strict();

/**
 * Zod schema for the `POST /invitations/:invitation_id/accept` request body —
 * carries the raw invitation token that is SHA-256 compared against the stored
 * `token_hash`.
 */
export const acceptMemberInvitationDto = z
  .object({
    token: trimmedStringMinMax(1, 512),
  })
  .strict();

/**
 * Zod schema for the `POST /organization/invitations/:invitation_id/resend`
 * request body. Regenerates the token and pushes the expiry by the supplied
 * number of days (1–365, default 7).
 */
export const resendMemberInvitationDto = z
  .object({
    expires_in_days: z.number().int().min(1).max(365).optional().default(7),
  })
  .strict();

/** Validated body inferred from {@link acceptMemberInvitationDto}. */
export type AcceptMemberInvitationInput = z.infer<typeof acceptMemberInvitationDto>;
/** Validated body inferred from {@link resendMemberInvitationDto}. */
export type ResendMemberInvitationInput = z.infer<typeof resendMemberInvitationDto>;
