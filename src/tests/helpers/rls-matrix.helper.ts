import { sql as drizzleSql } from 'drizzle-orm';
import { withMaintenanceDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { sql } from '@/infrastructure/database/connection.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { logs } from '@/domains/audit/audit.schema.js';
import { organization_settings } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.schema.js';
import { organization_notification_policies } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.schema.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';
import { user_settings } from '@/domains/user/sub-domains/user-settings/user-settings.schema.js';
import { user_data_exports } from '@/domains/user/sub-domains/user-data-export/user-data-export.schema.js';
import { webauthn_credentials } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.schema.js';
import { mfa_recovery_codes } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.schema.js';
import { mfa_methods } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-method.schema.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';

import {
  EXPECTED_FORCE_RLS_TABLES,
  forceRlsTableKey as tableKey,
  type ForceRlsTableRef,
} from '@/infrastructure/database/utils/force-rls-tables.constants.js';

export type { ForceRlsTableRef };
export { EXPECTED_FORCE_RLS_TABLES, tableKey };

export type RlsTenantFixture = {
  organizationAPublicId: string;
  organizationBPublicId: string;
  rowIdsByTable: Map<string, { organizationA: number; organizationB: number }>;
};

/**
 * User-scoped FORCE-RLS tables (audit #7) — isolated by `app.current_user_public_id` rather than
 * `app.current_organization_public_id`. Asserted for cross-user denial in the RLS matrix.
 */
export const USER_SCOPED_FORCE_RLS_TABLES: ForceRlsTableRef[] = [
  { schemaName: 'auth', tableName: 'users' },
  { schemaName: 'auth', tableName: 'auth_methods' },
  { schemaName: 'auth', tableName: 'user_settings' },
  { schemaName: 'auth', tableName: 'user_data_exports' },
  { schemaName: 'auth', tableName: 'webauthn_credentials' },
  { schemaName: 'auth', tableName: 'mfa_recovery_codes' },
  { schemaName: 'auth', tableName: 'mfa_methods' },
];

/** Two-user fixture for asserting cross-user denial on the user-scoped FORCE-RLS tables. */
export type RlsUserFixture = {
  userAPublicId: string;
  userBPublicId: string;
  /** Internal ids and email of user A, for exercising the pre-session SECURITY DEFINER resolvers. */
  userAInternalId: number;
  userAEmail: string;
  /** OAuth credential linked to user A for the `resolve_auth_method_by_provider` resolver test. */
  oauthProvider: string;
  oauthProviderUserId: string;
  rowIdsByTable: Map<string, { userA: number; userB: number }>;
};

/** Tables excluded from generic UPDATE/DELETE matrix (policy shape or parent FK setup). */
export const RLS_MATRIX_SKIP_CRUD_TABLES = new Set([
  tableKey('tenancy', 'organizations'),
  tableKey('tenancy', 'member_invitations'),
  tableKey('tenancy', 'role_permissions'),
  tableKey('tenancy', 'organization_settings'),
  tableKey('notify', 'webhook_delivery_attempts'),
  tableKey('auth', 'verification_tokens'),
  // sec-U3: audit.logs is append-only — REVOKE UPDATE causes UPDATE to throw
  // `permission denied` (instead of silently affecting 0 rows), and DELETE
  // outside the retention context silently affects 0 rows but the matrix's
  // SELECT-then-UPDATE-then-DELETE shape doesn't fit. The audit-append-only
  // dedicated test file (audit-append-only.security.test.ts) covers both
  // semantics precisely.
  tableKey('audit', 'logs'),
  // audit.outbox has no generic tenant SELECT policy — reads require the `app.audit_outbox_drain`
  // GUC (drain worker) and writes are organization-scoped INSERT-only / drain-gated, so the generic organization CRUD
  // matrix does not fit. Its dedicated test (audit-outbox-insert-rls.security.test.ts) covers the
  // INSERT isolation precisely; FORCE/drift coverage comes from EXPECTED_FORCE_RLS_TABLES.
  tableKey('audit', 'outbox'),
]);

export async function grantCoreBeAppRoleForTests(): Promise<void> {
  await sql`GRANT core_be_app TO CURRENT_USER`.catch(() => undefined);
}

/**
 * Lists every table with `FORCE ROW LEVEL SECURITY` enabled in the live database.
 *
 * @remarks
 * - **Algorithm:** reads `pg_class.relforcerowsecurity` joined to `pg_namespace`, including both
 *   ordinary tables (`relkind = 'r'`) and partitioned parents (`relkind = 'p'`) so partitioned
 *   tables such as `audit.logs` / `notify.notifications` are represented by their parent.
 * - **Failure modes:** none beyond a DB connection error; returns `[]` when nothing is forced.
 * - **Side effects:** none — read-only catalog query.
 * - **Notes:** partition children (`relispartition = true`) are excluded because the parent already
 *   represents the policy; including them would surface every child as `extra` drift.
 */
export async function listForceRlsTablesFromDatabase(): Promise<ForceRlsTableRef[]> {
  const rows = await sql<{ schema_name: string; table_name: string }[]>`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND c.relispartition = false
      AND c.relforcerowsecurity = true
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname
  `;
  return rows.map((row) => ({ schemaName: row.schema_name, tableName: row.table_name }));
}

export async function isForceRlsEnabled(schemaName: string, tableName: string): Promise<boolean> {
  const rows = await sql<{ relforcerowsecurity: boolean }[]>`
    SELECT c.relforcerowsecurity
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schemaName} AND c.relname = ${tableName}
  `;
  return rows[0]?.relforcerowsecurity === true;
}

export async function executeAsCoreBeAppTenant<T>(
  organizationPublicId: string | null,
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
    const tenantValue = organizationPublicId ?? '';
    await transaction.execute(
      drizzleSql`SELECT set_config('app.current_organization_public_id', ${tenantValue}, true)`,
    );
    return callback(transaction as unknown as typeof database);
  });
}

async function queryCountInTransaction(
  transaction: typeof database,
  schemaName: string,
  tableName: string,
): Promise<number> {
  const qualified = `"${schemaName}"."${tableName}"`;
  const result = await transaction.execute(
    drizzleSql.raw(`SELECT count(*)::int AS count FROM ${qualified}`),
  );
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: { count: number }[] }).rows ?? []);
  return Number(rows[0]?.count ?? 0);
}

export async function countRowsAsTenant(
  schemaName: string,
  tableName: string,
  organizationPublicId: string | null,
): Promise<number> {
  return executeAsCoreBeAppTenant(organizationPublicId, async (transaction) =>
    queryCountInTransaction(transaction, schemaName, tableName),
  );
}

/**
 * Runs `callback` as the least-privilege `core_be_app` role with `app.current_user_public_id` set, so
 * user-scoped FORCE-RLS policies (audit #7) are exercised exactly as they are in production under a
 * non-superuser connection.
 */
export async function executeAsCoreBeAppUser<T>(
  userPublicId: string | null,
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
    await transaction.execute(
      drizzleSql`SELECT set_config('app.current_user_public_id', ${userPublicId ?? ''}, true)`,
    );
    return callback(transaction as unknown as typeof database);
  });
}

/** Counts rows in a user-scoped table under the supplied `app.current_user_public_id` context. */
export async function countRowsAsUser(
  schemaName: string,
  tableName: string,
  userPublicId: string | null,
): Promise<number> {
  return executeAsCoreBeAppUser(userPublicId, async (transaction) =>
    queryCountInTransaction(transaction, schemaName, tableName),
  );
}

/**
 * Runs `callback` as the least-privilege `core_be_app` role with `app.global_admin = 'true'`, the
 * admin escape hatch set in production by {@link withMaintenanceDatabaseContext}. Used to prove the
 * cross-user admin branch of the `auth.users` / `auth.auth_methods` policies (audit #7) under a
 * non-superuser connection.
 */
export async function executeAsCoreBeAppGlobalAdmin<T>(
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
    await transaction.execute(drizzleSql`SELECT set_config('app.global_admin', 'true', true)`);
    return callback(transaction as unknown as typeof database);
  });
}

/** Counts rows in a table under the `app.global_admin = 'true'` admin escape hatch. */
export async function countRowsAsGlobalAdmin(
  schemaName: string,
  tableName: string,
): Promise<number> {
  return executeAsCoreBeAppGlobalAdmin(async (transaction) =>
    queryCountInTransaction(transaction, schemaName, tableName),
  );
}

export async function updateRowAsTenant(
  schemaName: string,
  tableName: string,
  rowId: number,
  organizationPublicId: string,
): Promise<number> {
  const qualified = `"${schemaName}"."${tableName}"`;
  return executeAsCoreBeAppTenant(organizationPublicId, async (transaction) => {
    const result = await transaction.execute(
      drizzleSql.raw(`UPDATE ${qualified} SET id = id WHERE id = ${rowId}`),
    );
    return Number((result as { rowCount?: number }).rowCount ?? 0);
  });
}

export async function deleteRowAsTenant(
  schemaName: string,
  tableName: string,
  rowId: number,
  organizationPublicId: string,
): Promise<number> {
  const qualified = `"${schemaName}"."${tableName}"`;
  return executeAsCoreBeAppTenant(organizationPublicId, async (transaction) => {
    const result = await transaction.execute(
      drizzleSql.raw(`DELETE FROM ${qualified} WHERE id = ${rowId}`),
    );
    return Number((result as { rowCount?: number }).rowCount ?? 0);
  });
}

export async function seedRlsMatrixFixtures(): Promise<RlsTenantFixture> {
  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  const organizationA = await createTestOrganization({ ownerUserId: ownerA.id });
  const organizationB = await createTestOrganization({ ownerUserId: ownerB.id });
  const plan = await createTestPlan();
  const periodStart = new Date();
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const roleA = await createRoleWithPermissions({
    organizationId: organizationA.id,
    permissionCodes: [],
    createdByUserId: ownerA.id,
  });
  const roleB = await createRoleWithPermissions({
    organizationId: organizationB.id,
    permissionCodes: [],
    createdByUserId: ownerB.id,
  });
  const membershipA = await createMembership({
    userId: ownerA.id,
    organizationId: organizationA.id,
    roleId: roleA.id,
  });
  const membershipB = await createMembership({
    userId: ownerB.id,
    organizationId: organizationB.id,
    roleId: roleB.id,
  });

  const rowIdsByTable = new Map<string, { organizationA: number; organizationB: number }>();

  rowIdsByTable.set(tableKey('tenancy', 'organizations'), {
    organizationA: organizationA.id,
    organizationB: organizationB.id,
  });
  rowIdsByTable.set(tableKey('tenancy', 'memberships'), {
    organizationA: membershipA.id,
    organizationB: membershipB.id,
  });
  rowIdsByTable.set(tableKey('tenancy', 'roles'), {
    organizationA: roleA.id,
    organizationB: roleB.id,
  });

  await database.insert(organization_settings).values({ organization_id: organizationA.id });
  await database.insert(organization_settings).values({ organization_id: organizationB.id });

  const [policyA] = await database
    .insert(organization_notification_policies)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      notification_type: 'billing.usage_threshold',
      channel: 'EMAIL',
    })
    .returning();
  const [policyB] = await database
    .insert(organization_notification_policies)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      notification_type: 'billing.usage_threshold',
      channel: 'EMAIL',
    })
    .returning();
  rowIdsByTable.set(tableKey('tenancy', 'organization_notification_policies'), {
    organizationA: policyA!.id,
    organizationB: policyB!.id,
  });

  const [apiKeyA] = await database
    .insert(api_keys)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      name: 'key-a',
      key_hash: 'hash-a',
      key_prefix: 'prefix-a',
      created_by_user_id: ownerA.id,
    })
    .returning();
  const [apiKeyB] = await database
    .insert(api_keys)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      name: 'key-b',
      key_hash: 'hash-b',
      key_prefix: 'prefix-b',
      created_by_user_id: ownerB.id,
    })
    .returning();
  rowIdsByTable.set(tableKey('tenancy', 'api_keys'), {
    organizationA: apiKeyA!.id,
    organizationB: apiKeyB!.id,
  });

  const webhookA = await createTestWebhook({ organizationId: organizationA.id });
  const webhookB = await createTestWebhook({ organizationId: organizationB.id });
  rowIdsByTable.set(tableKey('notify', 'webhooks'), {
    organizationA: webhookA.id,
    organizationB: webhookB.id,
  });

  const [notificationA] = await database
    .insert(notifications)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      user_id: ownerA.id,
      type: 'TEST',
      title: 'A',
      message: 'body',
    })
    .returning();
  const [notificationB] = await database
    .insert(notifications)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      user_id: ownerB.id,
      type: 'TEST',
      title: 'B',
      message: 'body',
    })
    .returning();
  rowIdsByTable.set(tableKey('notify', 'notifications'), {
    organizationA: notificationA!.id,
    organizationB: notificationB!.id,
  });

  const [subscriptionA] = await database
    .insert(subscriptions)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationA.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'ACTIVE',
      current_period_start: periodStart,
      current_period_end: periodEnd,
    })
    .returning();
  const [subscriptionB] = await database
    .insert(subscriptions)
    .values({
      public_id: generatePublicId('organization'),
      organization_id: organizationB.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'ACTIVE',
      current_period_start: periodStart,
      current_period_end: periodEnd,
    })
    .returning();
  rowIdsByTable.set(tableKey('billing', 'subscriptions'), {
    organizationA: subscriptionA!.id,
    organizationB: subscriptionB!.id,
  });

  const [auditA] = await database
    .insert(logs)
    .values({
      organization_id: organizationA.id,
      actor_user_id: ownerA.id,
      action: 'test.action',
      resource_type: 'organization',
    })
    .returning();
  const [auditB] = await database
    .insert(logs)
    .values({
      organization_id: organizationB.id,
      actor_user_id: ownerB.id,
      action: 'test.action',
      resource_type: 'organization',
    })
    .returning();
  rowIdsByTable.set(tableKey('audit', 'logs'), {
    organizationA: auditA!.id,
    organizationB: auditB!.id,
  });

  const [uploadA] = await database
    .insert(uploads)
    .values({
      public_id: generatePublicId('organization'),
      user_id: ownerA.id,
      organization_id: organizationA.id,
      file_name: 'a.png',
      file_key: 'org-a/a.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
      status: 'PENDING',
    })
    .returning();
  const [uploadB] = await database
    .insert(uploads)
    .values({
      public_id: generatePublicId('organization'),
      user_id: ownerB.id,
      organization_id: organizationB.id,
      file_name: 'b.png',
      file_key: 'org-b/b.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
      status: 'PENDING',
    })
    .returning();
  rowIdsByTable.set(tableKey('upload', 'uploads'), {
    organizationA: uploadA!.id,
    organizationB: uploadB!.id,
  });

  return {
    organizationAPublicId: organizationA.public_id,
    organizationBPublicId: organizationB.public_id,
    rowIdsByTable,
  };
}

/**
 * Seeds two users each owning one row in every user-scoped FORCE-RLS table (audit #7) so the matrix
 * can assert that user A — under `app.current_user_public_id = A` — sees its own row but zero of user B's.
 *
 * @remarks
 * - **Algorithm:** insert via the superuser `database` handle (RLS-exempt) so seeding is independent
 *   of the policies under test; record both row ids per table keyed by `<schema>.<table>`.
 * - **Failure modes:** none beyond DB errors; relies on {@link createTestUser} for valid users.
 * - **Side effects:** writes one row per user-scoped table for each of the two users.
 */
export async function seedUserScopedRlsFixtures(): Promise<RlsUserFixture> {
  const userA = await createTestUser();
  const userB = await createTestUser();
  const rowIdsByTable = new Map<string, { userA: number; userB: number }>();

  // auth.users: the two seeded user rows are themselves the isolation subjects (audit #7). Keyed by
  // public_id in the owner policy, but recorded by internal id so the generic matrix can probe by id.
  rowIdsByTable.set(tableKey('auth', 'users'), { userA: userA.id, userB: userB.id });

  const oauthProvider = 'google';
  const oauthProviderUserId = `rls-google-${userA.id}`;
  const [authMethodA] = await database
    .insert(auth_methods)
    .values({
      public_id: generatePublicId('organization'),
      user_id: userA.id,
      method_type: 'OAUTH',
      provider: oauthProvider,
      provider_user_id: oauthProviderUserId,
      is_primary: true,
    })
    .returning();
  const [authMethodB] = await database
    .insert(auth_methods)
    .values({
      public_id: generatePublicId('organization'),
      user_id: userB.id,
      method_type: 'PASSWORD',
      is_primary: true,
    })
    .returning();
  rowIdsByTable.set(tableKey('auth', 'auth_methods'), {
    userA: authMethodA!.id,
    userB: authMethodB!.id,
  });

  await database.insert(user_settings).values({ user_id: userA.id });
  await database.insert(user_settings).values({ user_id: userB.id });
  // user_settings PK is user_id, so isolation is keyed by the user row id itself.
  rowIdsByTable.set(tableKey('auth', 'user_settings'), { userA: userA.id, userB: userB.id });

  const [exportA] = await database
    .insert(user_data_exports)
    .values({ public_id: generatePublicId('organization'), user_id: userA.id, status: 'pending' })
    .returning();
  const [exportB] = await database
    .insert(user_data_exports)
    .values({ public_id: generatePublicId('organization'), user_id: userB.id, status: 'pending' })
    .returning();
  rowIdsByTable.set(tableKey('auth', 'user_data_exports'), {
    userA: exportA!.id,
    userB: exportB!.id,
  });

  const [credentialA] = await database
    .insert(webauthn_credentials)
    .values({
      public_id: generatePublicId('webauthnCredential'),
      user_id: userA.id,
      credential_id: generatePublicId('organization'),
      public_key: 'key-a',
    })
    .returning();
  const [credentialB] = await database
    .insert(webauthn_credentials)
    .values({
      public_id: generatePublicId('webauthnCredential'),
      user_id: userB.id,
      credential_id: generatePublicId('organization'),
      public_key: 'key-b',
    })
    .returning();
  rowIdsByTable.set(tableKey('auth', 'webauthn_credentials'), {
    userA: credentialA!.id,
    userB: credentialB!.id,
  });

  const [recoveryA] = await database
    .insert(mfa_recovery_codes)
    .values({ user_id: userA.id, code_hash: 'hash-a' })
    .returning();
  const [recoveryB] = await database
    .insert(mfa_recovery_codes)
    .values({ user_id: userB.id, code_hash: 'hash-b' })
    .returning();
  rowIdsByTable.set(tableKey('auth', 'mfa_recovery_codes'), {
    userA: recoveryA!.id,
    userB: recoveryB!.id,
  });

  const [methodA] = await database
    .insert(mfa_methods)
    .values({ public_id: generatePublicId('organization'), user_id: userA.id, method_type: 'TOTP' })
    .returning();
  const [methodB] = await database
    .insert(mfa_methods)
    .values({ public_id: generatePublicId('organization'), user_id: userB.id, method_type: 'TOTP' })
    .returning();
  rowIdsByTable.set(tableKey('auth', 'mfa_methods'), { userA: methodA!.id, userB: methodB!.id });

  return {
    userAPublicId: userA.public_id,
    userBPublicId: userB.public_id,
    userAInternalId: userA.id,
    userAEmail: userA.email,
    oauthProvider,
    oauthProviderUserId,
    rowIdsByTable,
  };
}
