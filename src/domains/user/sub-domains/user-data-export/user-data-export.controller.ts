import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  getRequestIdentifier,
  requireAuth,
  requireUserPrincipalDatabaseScope,
} from '@/shared/utils/http/request.util.js';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import type { UserDataExportService } from './user-data-export.service.js';
import { validateDataExportIdParam } from './user-data-export.validator.js';

/**
 * Build the GDPR export HTTP handler map (request/status). `requestExport` returns 202 because the
 * actual export runs asynchronously in a BullMQ worker; clients poll `getExportStatus` for the
 * presigned download URL once status flips to `completed`.
 */
export function createUserDataExportController(userDataExportService: UserDataExportService) {
  return {
    /**
     * POST /api/v1/users/me/data-export
     * GDPR: enqueue async export; poll GET :data_export_id for download URL.
     */
    async requestExport(request: FastifyRequest, reply: FastifyReply) {
      const requestId = getRequestIdentifier(request);
      const _auth = requireAuth(request);
      const data = await userDataExportService.requestExport(
        requireUserPrincipalDatabaseScope(request),
        { requestId },
      );
      return reply.status(202).send(successResponse(data, requestId));
    },

    /**
     * GET /api/v1/users/me/data-export/:data_export_id
     *
     * @remarks
     * sec-U6: every successful URL mint (download_url non-null on the response)
     * records a `user.data_export.url_minted` audit row. The GDPR export
     * contains the user's sessions, IPs, memberships, notifications, and audit
     * history — a session-token exfiltration would otherwise let the attacker
     * mint and download repeatedly with no post-hoc trail for either the user
     * or admins. Recording at the controller (not the service) keeps the
     * `request` boundary clean and lets the service stay pure.
     */
    async getExportStatus(request: FastifyRequest, _reply: FastifyReply) {
      const requestId = getRequestIdentifier(request);
      const auth = requireAuth(request);
      const { data_export_id: exportId } = validateDataExportIdParam(request.params);
      const data = await userDataExportService.getExportStatus(
        requireUserPrincipalDatabaseScope(request),
        exportId,
      );
      if (
        data !== null &&
        typeof data === 'object' &&
        'download_url' in data &&
        typeof data.download_url === 'string' &&
        data.download_url.length > 0
      ) {
        await recordScopedAuditEvent(request, {
          actorUserPublicId: auth.userId,
          action: 'user.data_export.url_minted',
          resource_type: 'user_data_export',
          metadata: { export_public_id: exportId },
        });
      }
      return successResponse(data, requestId);
    },
  };
}
