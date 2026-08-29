import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { registerAuditContainer } from '@/domains/audit/audit.container.js';
import { registerAuthContainer } from '@/domains/auth/auth.container.js';
import { registerBillingContainer } from '@/domains/billing/billing.container.js';
import { registerNotifyContainer } from '@/domains/notify/notify.container.js';
import { registerTenancyContainer } from '@/domains/tenancy/tenancy.container.js';
import { registerUploadContainer } from '@/domains/upload/upload.container.js';
import { registerUserContainer } from '@/domains/user/user.container.js';

async function registerDomainContainers(application: FastifyInstance): Promise<void> {
  registerUserContainer(application);
  registerTenancyContainer(application);
  registerAuditContainer(application);
  registerAuthContainer(application);
  registerBillingContainer(application);
  registerNotifyContainer(application);
  registerUploadContainer(application);

  application.userDomain.userService.wireOffboardingServices({
    authSessionService: application.authDomain.authSessionService,
    authMethodService: application.authDomain.authMethodService,
    uploadService: application.uploadDomain.uploadService,
    userDataExportService: application.userDomain.userDataExportService,
    // route-audit-#2 follow-up: block deleting a user who still owns organizations.
    organizationOwnership: application.tenancyDomain.organizationService,
  });

  application.tenancyDomain.organizationService.wireOffboardingUploadService(
    application.uploadDomain.uploadService,
    // route-audit-#2: cancel the org's active subscription on organization delete so billing stops.
    application.billingDomain.subscriptionService,
  );

  // REQ-4: break the membership↔subscription cycle by late-wiring. billing was built with the
  // tenancy membership service (for seats_used); now inject billing's subscription service into the
  // membership service so add-member enforces the seat limit and reconciles the Stripe quantity.
  application.tenancyDomain.membershipService.wireSeatEnforcement(
    application.billingDomain.subscriptionService,
  );

  application.userDomain.userDataExportService.wireCrossDomainServices({
    authSessionService: application.authDomain.authSessionService,
    membershipService: application.tenancyDomain.membershipService,
    notificationService: application.notifyDomain.notificationService,
    auditService: application.auditDomain.auditService,
  });
}

/** Registers all domain containers on the Fastify instance (composition root). */
export const domainContainersPlugin = fp(registerDomainContainers, {
  name: 'domain-containers',
});
