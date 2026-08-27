import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { ForbiddenError } from '@/shared/errors/index.js';
import { getRequestIdentifier, requirePrincipal } from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import type { MemberInvitationService } from './member-invitation.service.js';

/**
 * Builds the HTTP handler map for the invitation routes that remain after REQ-1: the org-scoped
 * `revoke` / `resend` under `/organization/invitations/:invitation_id` and the invitee-facing
 * `/invitations/:invitation_id/accept`. Adding a member now issues the invitation via
 * `POST /organization/memberships`, so the standalone create/list, the invitee pending-list, and
 * decline routes were removed.
 */
export function createMemberInvitationController(service: MemberInvitationService) {
  return {
    acceptMemberInvitation: async (request: FastifyRequest, _reply: FastifyReply) => {
      // sec-T4: route is `app.authenticate`-gated; the service binds the invitee email to the acting
      // user's email. API-key principals cannot accept invitations (no user identity to bind to).
      const auth = requirePrincipal(request);
      if (auth.kind !== 'user') {
        throw new ForbiddenError('errors:invitationEmailMismatch');
      }
      const { invitation_id: rawAcceptId } = (request.params as { invitation_id: string }) ?? {
        invitation_id: '',
      };
      // sec-new-T2: reject malformed path params before reaching the service layer.
      const invitationId = validatePublicIdParam(rawAcceptId ?? '', 'invitation_id');
      const data = await service.accept(invitationId, request.body, auth.userId);
      return successResponse(data, getRequestIdentifier(request));
    },
    revokeMemberInvitation: async (request: FastifyRequest, reply: FastifyReply) => {
      requirePrincipal(request);
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      // sec-new-T2: reject malformed path params before reaching the service layer.
      const { invitation_id: rawRevokeId } = request.params as { invitation_id: string };
      const invitationId = validatePublicIdParam(rawRevokeId ?? '', 'invitation_id');
      await service.revoke(scope, invitationId);
      return reply.code(204).send();
    },
    resendInvitation: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      // sec-new-T2: reject malformed path params before reaching the service layer.
      const { invitation_id: rawResendId } = request.params as { invitation_id: string };
      const invitationId = validatePublicIdParam(rawResendId ?? '', 'invitation_id');
      // R1 / TEN-34: regenerated token is delivered only via email, never returned.
      const invitation = await service.resend(scope, invitationId, request.body, {
        requestId: getRequestIdentifier(request),
      });
      return successResponse({ invitation }, getRequestIdentifier(request));
    },
  };
}
