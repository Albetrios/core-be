/**
 * Member-invitation bulk seeder — creates a few pending invitations per organization in the
 * registry. Each invitation is backed by a fresh `INVITED` membership (the invitee is a registry
 * user not already a member of that org) joined to the org's Admin role, then a
 * `tenancy.member_invitations` row with the SHA-256 `token_hash` of the raw token. When
 * `counts.edgeCases` is set, the last invitation per org is created already-expired (past
 * `created_at`/`expires_at`).
 *
 * Idempotency: the per-(org, slot) `token_hash` is a deterministic SHA-256 marker and is unique,
 * so re-runs skip slots that already exist; the backing INVITED membership is created with
 * `seedMembership` only for slots that need a new invitation.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { member_invitations } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.schema.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { seedMembership, seedMemberInvitation } from '@/domains/tenancy/seed/tenancy.seed.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkInviteeEmail } from './member-invitation.faker.js';

/** Target number of pending invitations to maintain per organization. */
const INVITATIONS_PER_ORG = 2;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic 64-char invitation token hash for a given org + slot (idempotency marker). */
function invitationTokenHash(organizationPublicId: string, slot: number): string {
  return createHash('sha256').update(`seed-invite:${organizationPublicId}:${slot}`).digest('hex');
}

/** Resolves the org's Admin (system) role id, used as the placeholder role for invited members. */
async function findAdminRoleId(organizationId: number): Promise<number | null> {
  const [row] = await getRequestDatabase()
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.organization_id, organizationId), eq(roles.name, 'Admin')))
    .limit(1);
  return row?.id ?? null;
}

/** Returns the set of `user_id`s with any existing membership row in the organization. */
async function existingMemberUserIds(organizationId: number): Promise<Set<number>> {
  const rows = await getRequestDatabase()
    .select({ user_id: memberships.user_id })
    .from(memberships)
    .where(eq(memberships.organization_id, organizationId));
  return new Set(rows.map((row) => row.user_id));
}

/**
 * Seeds pending invitations + backing INVITED memberships per registry organization.
 *
 * @remarks
 * Algorithm: per organization, look up its Admin role and existing member ids, then for each
 * not-yet-seeded slot pick a registry user who is not already a member, create an INVITED
 * membership, and insert an invitation with a deterministic `token_hash` (expired in edge-case
 * mode). Side effects: inserts into `tenancy.memberships` and `tenancy.member_invitations`.
 * Failure modes: warns and returns early when either pool is empty; skips a slot when no eligible
 * invitee or Admin role is available; otherwise propagates DB errors.
 */
export async function seedMemberInvitationsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  const users = context.registry.users;
  if (organizations.length === 0 || users.length === 0) {
    context.logger.warn(
      'seed.bulk.member-invitation: empty organization or user pool; run the user and tenancy seeders first',
    );
    return;
  }

  const database = getRequestDatabase();
  let created = 0;
  const now = Date.now();

  for (const organization of organizations) {
    created += await seedOrganizationMemberInvitations({ organization, context, database, now });
  }
  context.logger.info(
    { organizations: organizations.length, created },
    'seed.bulk.member-invitation: invitations seeded',
  );
}

/**
 * Seeds one organization's pending invitations + backing INVITED memberships, returning the
 * number created. Returns 0 when the org has no Admin role; stops early when the registry has no
 * remaining eligible (non-member) invitee.
 */
async function seedOrganizationMemberInvitations(options: {
  organization: SeedContext['registry']['organizations'][number];
  context: SeedContext;
  database: ReturnType<typeof getRequestDatabase>;
  now: number;
}): Promise<number> {
  const { organization, context, database, now } = options;
  const adminRoleId = await findAdminRoleId(organization.id);
  if (adminRoleId === null) return 0;

  const slotHashes = Array.from({ length: INVITATIONS_PER_ORG }, (_, slot) =>
    invitationTokenHash(organization.public_id, slot),
  );
  const existingInvites = await database
    .select({ token_hash: member_invitations.token_hash })
    .from(member_invitations)
    .where(inArray(member_invitations.token_hash, slotHashes));
  const existingHashes = new Set(existingInvites.map((row) => row.token_hash));
  const memberUserIds = await existingMemberUserIds(organization.id);
  const users = context.registry.users;

  let created = 0;
  for (let slot = 0; slot < INVITATIONS_PER_ORG; slot += 1) {
    const tokenHash = slotHashes[slot] as string;
    if (existingHashes.has(tokenHash)) continue;

    const invitee = users.find((user) => !memberUserIds.has(user.id));
    if (!invitee) break;
    memberUserIds.add(invitee.id);

    const isExpiredEdgeCase = context.counts.edgeCases && slot === INVITATIONS_PER_ORG - 1;
    const createdAt = isExpiredEdgeCase ? new Date(now - 30 * ONE_DAY_MS) : new Date(now);
    const expiresAt = isExpiredEdgeCase
      ? new Date(now - 23 * ONE_DAY_MS)
      : new Date(now + 7 * ONE_DAY_MS);

    const membership = await seedMembership({
      user_id: invitee.id,
      organization_id: organization.id,
      role_id: adminRoleId,
      status: 'INVITED',
      invited_by_user_id: organization.ownerUserId,
      created_by_user_id: organization.ownerUserId,
    });
    if (!membership) continue;

    await seedMemberInvitation({
      membership_id: membership.id,
      email: generateBulkInviteeEmail(context.faker),
      token_hash: tokenHash,
      invited_by_user_id: organization.ownerUserId,
      expires_at: expiresAt,
      created_by_user_id: organization.ownerUserId,
      created_at: createdAt,
    });
    created += 1;
  }
  return created;
}
