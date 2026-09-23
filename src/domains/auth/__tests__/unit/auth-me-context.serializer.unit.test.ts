import { describe, expect, it } from 'vitest';
import { serializeAuthMeContext } from '@/domains/auth/auth-me-context.serializer.js';
import type { AuthMeContextData } from '@/domains/auth/auth-me-context.types.js';
import type { OrganizationOutput } from '@/domains/tenancy/sub-domains/organization/organization.types.js';

const organization = (id: string, type: 'PERSONAL' | 'TEAM'): OrganizationOutput => ({
  id,
  name: `Org ${id}`,
  slug: type === 'TEAM' ? `org-${id}` : null,
  type,
  status: 'ACTIVE',
  logo_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const baseData = (overrides: Partial<AuthMeContextData> = {}): AuthMeContextData => ({
  user: {
    id: 'usr_1',
    email: 'a@b.com',
    is_email_verified: true,
    is_mfa_enabled: false,
    first_name: 'A',
    last_name: 'B',
    job_title: null,
    avatar_url: null,
    status: 'ACTIVE',
    onboarding_completed: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  activeOrganization: organization('org_active', 'TEAM'),
  myPermissions: ['organization:read', 'membership:manage'],
  globalRole: null,
  ...overrides,
});

describe('serializeAuthMeContext', () => {
  it('passes through user, active organization, permissions, and global role', () => {
    const output = serializeAuthMeContext(baseData());
    expect(output.user.id).toBe('usr_1');
    expect(output.active_organization?.id).toBe('org_active');
    expect(output.my_permissions).toEqual(['organization:read', 'membership:manage']);
    expect(output.global_role).toBeNull();
  });

  // The switcher list moved to `GET /users/me/organizations`, which pages.
  // Embedded here it was a flat array with no cursor, filled by a
  // default-paginated read — a caller in more than 25 organizations was
  // silently truncated with no way to ask for the rest.
  it('does not carry the organization list', () => {
    const output = serializeAuthMeContext(baseData());
    expect(output).not.toHaveProperty('organizations');
  });

  it('serializes a caller with no active organization', () => {
    const output = serializeAuthMeContext(
      baseData({ activeOrganization: null, myPermissions: [] }),
    );
    expect(output.active_organization).toBeNull();
    expect(output.my_permissions).toEqual([]);
  });
});
