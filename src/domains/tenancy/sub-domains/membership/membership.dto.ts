import { z } from 'zod';
import { listSearchSortSchema } from '@/shared/utils/http/list-query.util.js';
import { trimmedEmail, trimmedStringMinMax } from '@/shared/utils/validation/validation.util.js';

/** Zod schema for the `:membership_id` path param (get/get-permissions/update/delete membership). */
export const membershipIdParamsDto = z
  .object({
    membership_id: trimmedStringMinMax(1, 28),
  })
  .strict();

/**
 * Zod schema for the `POST /organization/memberships` request body — the
 * "Add member" action (REQ-1). Identifies the invitee by `email` (a new
 * address provisions a bare ACTIVE user; an existing one resolves to that
 * account), the `role_id` by public id, and an optional invitation
 * `expires_in_days` (1–365, default 7). The membership is always created
 * `INVITED`; the invitee is emailed a token and becomes `ACTIVE` on accept.
 */
export const createMembershipDto = z
  .object({
    email: trimmedEmail(),
    role_id: trimmedStringMinMax(1, 28),
    expires_in_days: z.number().int().min(1).max(365).optional().default(7),
  })
  .strict();

/**
 * Zod schema for the `PATCH /organization/memberships/:membership_id`
 * request body. The membership `status` and/or `role_id` are mutable here
 * (REQ-3: change a member's role). At least one field must be provided.
 */
export const updateMembershipDto = z
  .object({
    status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED']).optional(),
    role_id: trimmedStringMinMax(1, 28).optional(),
  })
  .strict()
  .refine((value) => value.status !== undefined || value.role_id !== undefined, {
    message: 'Provide at least one of status or role_id',
  });

/**
 * Zod schema for the `GET /organization/memberships` list query: cursor pagination plus optional
 * `q` (free-text search over the member's email / first name / last name), `sort` (`name` |
 * `created_at`), and `order` (`asc` | `desc`). Brings memberships to parity with the roles / api-key
 * lists (`listSearchSortSchema`) so the FE can sort the members table server-side. `sort` / `order`
 * are `.optional()` (a defaulted param serializes as `required`, a breaking contract change); the
 * repository defaults to `created_at` ascending to preserve the pre-sort ordering. Sorting by `name`
 * orders by the member's `auth.users` display name and is resolved through a SECURITY DEFINER
 * function (that table is FORCE RLS — a plain join under organization-only context matches zero rows).
 */
export const listMembershipsQueryDto = listSearchSortSchema(['name', 'created_at'] as const);

/**
 * Zod schema for the `POST /organization/transfer-ownership` request
 * body. `new_owner_user_id` is the target user's public id.
 */
export const transferOwnershipDto = z
  .object({
    new_owner_user_id: trimmedStringMinMax(1, 28),
  })
  .strict();

/** Validated body inferred from {@link createMembershipDto}. */
export type CreateMembershipInput = z.infer<typeof createMembershipDto>;
/** Validated body inferred from {@link updateMembershipDto}. */
export type UpdateMembershipInput = z.infer<typeof updateMembershipDto>;
/** Validated query inferred from {@link listMembershipsQueryDto}. */
export type ListMembershipsQueryInput = z.infer<typeof listMembershipsQueryDto>;
/** Validated body inferred from {@link transferOwnershipDto}. */
export type TransferOwnershipInput = z.infer<typeof transferOwnershipDto>;
