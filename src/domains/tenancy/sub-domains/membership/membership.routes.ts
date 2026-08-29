import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  EXPENSIVE_AUTHED_RATE_LIMIT,
  MODERATE_AUTHED_RATE_LIMIT,
  ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
  STRICT_AUTHED_RATE_LIMIT,
  STRICT_PUBLIC_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import type { MembershipService } from './membership.service.js';
import type { MemberInvitationService } from './member-invitation/member-invitation.service.js';
import {
  acceptMemberInvitationDto,
  invitationIdParamsDto,
  resendMemberInvitationDto,
} from './member-invitation/member-invitation.dto.js';
import {
  createMembershipDto,
  membershipIdParamsDto,
  transferOwnershipDto,
  updateMembershipDto,
} from './membership.dto.js';
import { createMembershipController } from './membership.controller.js';
import { createMemberInvitationController } from './member-invitation/member-invitation.controller.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';

/** Services required to wire the membership and member-invitation routes. */
export interface MembershipRoutesDeps {
  membershipService: MembershipService;
  memberInvitationService: MemberInvitationService;
}

/**
 * Fastify plugin that registers active-organization membership routes (list,
 * get, create, update, delete, plus self-service leave / transfer-ownership)
 * and the member-invitation routes (organization-scoped create/list/cancel/resend plus
 * the cross-organization `/invitations/:invitation_id/accept` user-facing endpoint).
 * Permission-gated routes are protected with
 * `requireOrganizationPermission(MEMBERSHIP_*|INVITATION_MANAGE)`; public
 * accept has only a strict rate limit.
 */
export function membershipRoutes(deps: MembershipRoutesDeps): FastifyPluginAsync {
  const membershipController = createMembershipController(deps.membershipService);
  const invitationController = createMemberInvitationController(deps.memberInvitationService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    // Membership CRUD
    zodApplication.get(
      '/organization/memberships',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.MEMBERSHIP_READ)],
        schema: {
          summary: 'List memberships',
          description:
            'Returns all memberships in the organization with their roles. Requires MEMBERSHIP_READ permission.',
          tags: ['Membership'],
        },
      },
      membershipController.listMemberships,
    );
    zodApplication.get<{ Params: { membership_id: string } }>(
      '/organization/memberships/:membership_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.MEMBERSHIP_READ)],
        schema: {
          summary: 'Get membership',
          description:
            'Returns a single membership including user details and role. Requires MEMBERSHIP_READ permission.',
          tags: ['Membership'],
          params: membershipIdParamsDto,
        },
      },
      membershipController.getMembership,
    );
    zodApplication.get<{ Params: { membership_id: string } }>(
      '/organization/memberships/:membership_id/permissions',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.MEMBERSHIP_READ)],
        schema: {
          summary: 'Get membership permissions',
          description:
            'Returns all effective permissions for a membership (from role). Requires MEMBERSHIP_READ permission.',
          tags: ['Membership'],
          params: membershipIdParamsDto,
        },
      },
      membershipController.getMembershipPermissions,
    );
    zodApplication.post(
      '/organization/memberships',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor) alongside the
        // required idempotency key. Mirrors the invitation-create pattern.
        config: { ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config, idempotencyRequired: true },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE)],
        schema: {
          summary: 'Add member by email',
          description:
            'Adds a member by email: provisions or resolves the user, creates an INVITED membership with the given role, and emails an invitation token. The invitee becomes ACTIVE on accept. Requires MEMBERSHIP_MANAGE permission.',
          tags: ['Membership'],
          body: createMembershipDto,
        },
      },
      membershipController.createMembership,
    );
    zodApplication.patch<{ Params: { membership_id: string } }>(
      '/organization/memberships/:membership_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE)],
        schema: {
          summary: 'Update membership',
          description:
            "Updates a membership's status and/or role (suspend, reactivate, or change role). Requires MEMBERSHIP_MANAGE permission.",
          tags: ['Membership'],
          params: membershipIdParamsDto,
          body: updateMembershipDto,
        },
      },
      membershipController.updateMembership,
    );
    zodApplication.delete<{ Params: { membership_id: string } }>(
      '/organization/memberships/:membership_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE)],
        schema: {
          summary: 'Remove membership',
          description:
            'Removes a member from the organization. Requires MEMBERSHIP_MANAGE permission.',
          tags: ['Membership'],
          params: membershipIdParamsDto,
        },
      },
      membershipController.deleteMembership,
    );
    zodApplication.post(
      '/organization/leave',
      {
        // sec-r4-I3: self-service exit revokes the caller's membership row.
        // Without a cap, a session-token holder (or compromised script) could
        // loop the endpoint against arbitrary organization ids to probe membership
        // existence by status code. Cap at the moderate-authed tier (30/60s).
        ...MODERATE_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        schema: {
          summary: 'Leave organization',
          description:
            'Allows the authenticated user to leave the organization. Owners cannot leave without transferring ownership first.',
          tags: ['Membership'],
        },
      },
      membershipController.leaveOrganization,
    );
    zodApplication.post(
      '/organization/transfer-ownership',
      {
        // sec-r4-I3: ownership transfer is effectively irreversible (no
        // automatic recovery if the new owner is malicious). Cap at the
        // expensive-authed tier (5 req / 5 min) so a hijacked owner session
        // cannot pivot multiple tenants in rapid succession. Preserve
        // idempotencyRequired by merging into a single config object.
        config: { idempotencyRequired: true, ...EXPENSIVE_AUTHED_RATE_LIMIT.config },
        onRequest: [app.authenticate],
        schema: {
          summary: 'Transfer organization ownership',
          description:
            'Transfers ownership of the organization to another member. Only the current owner can perform this action.',
          tags: ['Membership'],
          body: transferOwnershipDto,
        },
      },
      membershipController.transferOwnership,
    );

    // ── Org-admin invitations (active organization, INVITATION_MANAGE) ──
    // Adding a member (which issues the invitation) is `POST /organization/memberships` (REQ-1);
    // these routes manage an already-issued invitation.
    zodApplication.delete<{ Params: { invitation_id: string } }>(
      '/organization/invitations/:invitation_id',
      {
        // sec-r4-I3: invitation revocation is an organization-scoped admin mutation.
        // Cap per (organization, actor) so a single admin cannot churn invitations and
        // a cross-tenant probe cannot exhaust a victim org's bucket.
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.INVITATION_MANAGE)],
        schema: {
          summary: 'Revoke invitation',
          description: 'Revokes a pending invitation. Requires INVITATION_MANAGE permission.',
          tags: ['Invitation'],
          params: invitationIdParamsDto,
        },
      },
      invitationController.revokeMemberInvitation,
    );
    zodApplication.post<{ Params: { invitation_id: string } }>(
      '/organization/invitations/:invitation_id/resend',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.INVITATION_MANAGE)],
        ...STRICT_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Resend invitation',
          description:
            'Resends the invitation email with a new expiry. Requires INVITATION_MANAGE permission.',
          tags: ['Invitation'],
          params: invitationIdParamsDto,
          body: resendMemberInvitationDto,
        },
      },
      invitationController.resendInvitation,
    );

    // ── Recipient invitations (the invited user, cross-organization, auth-only) ──
    zodApplication.post<{ Params: { invitation_id: string } }>(
      '/invitations/:invitation_id/accept',
      {
        // sec-T4: accept now requires authentication and (in the service)
        // an invitee-email match. The previous unauthenticated route let
        // anyone who got hold of the invitation URL flip the victim's
        // pending membership to ACTIVE without the victim's interaction.
        onRequest: [app.authenticate],
        ...STRICT_PUBLIC_RATE_LIMIT,
        schema: {
          summary: 'Accept invitation',
          description:
            "Accepts a pending invitation using the invitation token. Requires authentication; the authenticated user's email must match the invitee email on the invitation. Activates the invitee's pre-existing membership (sets it ACTIVE).",
          tags: ['Invitation'],
          params: invitationIdParamsDto,
          body: acceptMemberInvitationDto,
        },
      },
      invitationController.acceptMemberInvitation,
    );
  };
}
