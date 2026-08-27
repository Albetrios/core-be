import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Policy: the verified-principal minters (`resolveVerifiedUserPrincipalScope` /
 * `resolveVerifiedOrganizationPrincipalScope`) create a principal scope from an
 * id the CALLER has already authenticated or resolved — a port/pre-token
 * authority, not a request token. Every importer is therefore enumerated here:
 * a new import is a new claim of "I verified this identity myself" and must be
 * added to this ledger deliberately, with the verification path understood.
 */
const VERIFIED_MINTER_MODULE = 'shared/utils/identity/verified-principal-scope.util';
const AUTH_REEXPORT_MODULE = 'auth/shared/verified-user-principal-scope.util';

/** Importers of the shared verified-minter module (ledger — additions are deliberate). */
const ALLOWED_IMPORTERS = [
  // The auth-domain re-export shim (its own importers are ledgered below).
  'src/domains/auth/shared/verified-user-principal-scope.util.ts',
  // Admin/system flows resolving actors outside a token scope.
  'src/domains/audit/audit.service.ts',
  // Stripe-webhook–driven billing mutations (org resolved from the Stripe event).
  'src/domains/billing/sub-domains/subscription/subscription.service.ts',
  // Event-handler + worker recipient resolution (ids come from trusted job payloads).
  'src/domains/notify/sub-domains/notification/notification.service.ts',
  'src/domains/notify/sub-domains/notification/workers/notification.worker.ts',
  // Invite flow: inviter's request acts on the invited user / target org.
  'src/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.service.ts',
  'src/domains/tenancy/sub-domains/membership/membership.service.ts',
  // API-key authentication resolves the org from the verified key itself.
  'src/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.service.ts',
  // Provisioning / pre-token org bootstrap and active-org resolution at login.
  'src/domains/tenancy/sub-domains/organization/organization-provisioning.ts',
  'src/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.ts',
  'src/domains/tenancy/sub-domains/organization/organization.service.ts',
  'src/domains/tenancy/sub-domains/organization/resolve-active-organization.ts',
  // Permission resolution for an org the middleware already validated.
  'src/domains/tenancy/sub-domains/permission/authorization.service.ts',
  // Post-verification uploads + user lifecycle flows keyed on resolved ids.
  'src/domains/upload/upload.service.ts',
  'src/domains/user/sub-domains/user-data-export/user-data-export.service.ts',
  'src/domains/user/sub-domains/user-settings/user-settings.service.ts',
  'src/domains/user/user.service.ts',
  // Post-commit dispatch recovery replays rows staged under a verified identity.
  'src/infrastructure/queue/commit-dispatch/commit-dispatch.executor.ts',
] as const;

/** Importers of the auth-domain re-export (login/MFA/WebAuthn pre-token flows). */
const ALLOWED_AUTH_REEXPORT_IMPORTERS = [
  'src/domains/auth/auth.service.ts',
  'src/domains/auth/sub-domains/auth-method/auth-method.service.ts',
  'src/domains/auth/sub-domains/auth-mfa/auth-mfa.service.ts',
  'src/domains/auth/sub-domains/auth-session/auth-session.service.ts',
  'src/domains/auth/sub-domains/auth-webauthn/webauthn.service.ts',
] as const;

function productionImportersOf(moduleFragment: string): string[] {
  let output = '';
  try {
    output = execFileSync('grep', ['-rl', moduleFragment, 'src', '--include=*.ts'], {
      encoding: 'utf8',
    });
  } catch {
    // no matches
  }
  return output
    .split('\n')
    .filter(Boolean)
    .filter((filePath) => !/\.test\.ts$/.test(filePath))
    .sort();
}

describe('verified-principal-scope usage ledger', () => {
  it('the shared verified minters are imported only by ledgered files', () => {
    const actual = productionImportersOf(VERIFIED_MINTER_MODULE);
    expect(actual).toEqual([...ALLOWED_IMPORTERS].sort());
  });

  it('the auth re-export is imported only by ledgered auth services', () => {
    const actual = productionImportersOf(AUTH_REEXPORT_MODULE).filter(
      (filePath) => !filePath.endsWith('auth/shared/verified-user-principal-scope.util.ts'),
    );
    expect(actual).toEqual([...ALLOWED_AUTH_REEXPORT_IMPORTERS].sort());
  });
});
