import { baseTemplate } from './base.template.js';
import { escapeHtml } from './escape-html.util.js';

/** Template variables for {@link invitationTemplate} — inviter, target organization, accept URL, and TTL. */
export interface InvitationTemplateData {
  inviterName: string;
  organizationName: string;
  acceptUrl: string;
  expiresInDays: number;
}

/**
 * Renders the member-invitation HTML email (wrapped in `baseTemplate`). Emitted
 * from `member-invitation.events` handlers; the `acceptUrl` must already include
 * the signed invitation token so the recipient can complete acceptance.
 *
 * @remarks
 * All user/tenant-controlled and URL values are passed through {@link escapeHtml}
 * before interpolation. `inviterName` and `organizationName` carry display names;
 * `acceptUrl` is server-generated but escaping ensures `&` query-string delimiters
 * are correctly encoded as `&amp;` in HTML attributes and prevents injection if the
 * URL-construction code ever changes.
 */
export function invitationTemplate(data: InvitationTemplateData): string {
  const inviterName = escapeHtml(data.inviterName);
  const organizationName = escapeHtml(data.organizationName);
  const acceptUrl = escapeHtml(data.acceptUrl);

  return baseTemplate({
    title: `You're invited to join ${data.organizationName}`,
    preheader: `${data.inviterName} invited you to join ${data.organizationName}.`,
    body: `
      <h1>You've been invited</h1>
      <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong>.</p>
      <p>Click the button below to accept the invitation. This link expires in ${data.expiresInDays} days.</p>
      <p style="text-align: center; margin: 32px 0;">
        <a href="${acceptUrl}" class="button">Accept Invitation</a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">If you weren't expecting this invitation, you can safely ignore this email.</p>
      <p style="font-size: 13px; color: #6b7280;">Or copy and paste this URL into your browser:</p>
      <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">${acceptUrl}</p>
    `,
  });
}
