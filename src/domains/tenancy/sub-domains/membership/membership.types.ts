/**
 * Raw `tenancy.memberships` row shape from Drizzle. Holds internal numeric
 * ids and the soft-delete marker (`deleted_at`); do not return this shape
 * directly from HTTP handlers — serialize via {@link serializeMembership}.
 */
export interface MembershipRow {
  id: number;
  public_id: string;
  user_id: number;
  organization_id: number;
  role_id: number;
  status: string;
  invited_by_user_id: number | null;
  joined_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Embedded user summary on a membership response. Lets the frontend render a
 * members table (name, email, avatar) without an N+1 per-row user fetch. `id`
 * is the user's external public id; `avatar_url` is already presigned for read
 * (or an absolute provider URL), never a raw object key.
 */
export interface MembershipUserSummary {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}

/** Embedded role summary on a membership response (`id` = role public id). */
export interface MembershipRoleSummary {
  id: string;
  name: string;
}

/**
 * Embedded reference to a membership's live (pending, not accepted/revoked)
 * invitation, present only on `INVITED` rows. Lets the frontend drive Resend /
 * Revoke straight from the members table; `null` for `ACTIVE`/`SUSPENDED` rows.
 */
export interface MembershipInvitationRef {
  id: string;
  expires_at: string;
}

/**
 * Public HTTP response shape for a membership. All identifiers are external
 * public ids (or string-coerced numeric ids where the organization id is not yet
 * resolved); timestamps are ISO-8601 strings. The flat `user_id`/`role_id`
 * remain for back-compat; `user`/`role` embed the display summaries and
 * `invitation` carries the live invite on `INVITED` rows.
 */
export interface MembershipOutput {
  id: string;
  user_id: string;
  organization_id: string;
  role_id: string;
  status: string;
  joined_at: string | null;
  created_at: string;
  updated_at: string;
  user: MembershipUserSummary;
  role: MembershipRoleSummary;
  invitation: MembershipInvitationRef | null;
}
