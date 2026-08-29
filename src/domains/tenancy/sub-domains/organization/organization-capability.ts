import { UnprocessableEntityError } from '@/shared/errors/index.js';

/**
 * A team-only capability a caller may attempt to exercise on an organization.
 * Selects the matching i18n rejection key in {@link assertTeamOrganization} when
 * the target is a PERSONAL organization.
 *
 * - `MEMBERS` — add or invite a second member (collaboration).
 * - `ROLES` — create or manage custom member roles.
 * - `MUTATION` — owner-level structural change (delete or transfer ownership).
 * - `BILLING` — manage the organization subscription (create / change plan / cancel / resume).
 */
export type OrganizationCapability = 'MEMBERS' | 'ROLES' | 'MUTATION' | 'BILLING';

/** Organization `type` for a single-owner account workspace (no collaboration). */
const PERSONAL_ORGANIZATION_TYPE = 'PERSONAL';

/** Maps an attempted {@link OrganizationCapability} to its PERSONAL-organization rejection key. */
const CAPABILITY_REJECTION_KEY: Record<OrganizationCapability, string> = {
  MEMBERS: 'errors:personalOrganizationNoMembers',
  ROLES: 'errors:personalOrganizationNoRoles',
  MUTATION: 'errors:personalOrganizationImmutable',
  BILLING: 'errors:personalOrganizationNoBilling',
};

/**
 * Guards a team-only capability: rejects with 422 when `organization` is a
 * PERSONAL organization, otherwise returns without effect.
 *
 * @param organization - The target organization (only `type` is read).
 * @param capability - The capability being attempted; selects the i18n key.
 * @throws UnprocessableEntityError When the organization is PERSONAL — the organization
 *   `type` is immutable, so retrying the identical request can never succeed
 *   (422 `unprocessable_entity`, not 409).
 *
 * @remarks
 * - **Algorithm:** if `type === 'PERSONAL'`, throw `UnprocessableEntityError`
 *   keyed by {@link CAPABILITY_REJECTION_KEY}; otherwise no-op.
 * - **Failure modes:** PERSONAL organization ⇒ 422 `unprocessable_entity`.
 * - **Side effects:** none (pure guard; throws or returns).
 * - **Notes:** single point of enforcement for the personal-vs-team rule, shared by
 *   member-invitation, membership (add member / transfer ownership), member-role,
 *   organization delete, and subscription billing (create / change-plan / cancel /
 *   resume). Team-only affordances are NOT advertised on the API response; a client
 *   derives them from the organization `type` and gates the action itself on the
 *   caller's permissions (e.g. `subscription:manage`).
 */
export function assertTeamOrganization(
  organization: { type: string },
  capability: OrganizationCapability,
): void {
  if (organization.type === PERSONAL_ORGANIZATION_TYPE) {
    throw new UnprocessableEntityError(CAPABILITY_REJECTION_KEY[capability]);
  }
}
