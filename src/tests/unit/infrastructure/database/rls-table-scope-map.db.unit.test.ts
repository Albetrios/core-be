import { describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import {
  MAINTENANCE_CONTEXTS,
  SESSION_CONTEXTS,
} from '@/infrastructure/database/contexts/database-context.js';
import { EXPECTED_FORCE_RLS_TABLES } from '@/infrastructure/database/utils/force-rls-tables.constants.js';

/**
 * Phase 8 — the table→required-scope map. For every FORCE-RLS table this pins
 * EXACTLY which `app.*` GUCs its live policies reference, i.e. which scope
 * patterns can ever grant access to it. A migration that adds, drops, or
 * retargets a policy arm must update this map deliberately — silent policy
 * weakening (a new bypass GUC on a tenant table) or dead arms (a GUC no code
 * sets) can no longer slip through.
 *
 * Sources of truth:
 * - the LIVE database (`pg_policies.qual` / `with_check`) — final post-migration
 *   state, robust to later migrations replacing earlier policies;
 * - the scope registries in `database-context.ts` — the only legal GUC universe.
 */
const RLS_TABLE_SCOPE_MAP: Record<string, readonly string[]> = {
  // Tables whose policies carry no app.* GUC (application-access or claim-based
  // system tables kept under FORCE RLS for the owner-role discipline).
  'audit.dead_letter_jobs': [],
  'auth.mail_outbox': [],
  'auth.verification_tokens': [],
  'billing.plans': [],
  'billing.stripe_subscription_tombstones': [],
  'billing.stripe_webhook_events': [],
  'tenancy.permissions': [],

  'audit.logs': [
    'app.current_organization_id',
    'app.current_user_id',
    'app.global_admin',
    'app.global_retention_cleanup',
    'app.system_audit_insert',
  ],
  'audit.outbox': [
    'app.audit_outbox_drain',
    'app.current_organization_id',
    'app.system_audit_insert',
  ],
  'auth.auth_methods': ['app.current_user_id', 'app.global_admin'],
  'auth.mfa_methods': ['app.current_user_id'],
  'auth.mfa_recovery_codes': ['app.current_user_id'],
  'auth.sessions': [
    'app.current_session_public_id',
    'app.current_session_token_hash',
    'app.current_user_id',
    'app.session_retention_cleanup',
  ],
  'auth.user_data_exports': ['app.current_user_id', 'app.global_retention_cleanup'],
  'auth.user_notification_preferences': ['app.current_user_id'],
  'auth.user_settings': ['app.current_user_id'],
  'auth.users': ['app.current_user_id', 'app.global_admin'],
  'auth.webauthn_credentials': ['app.current_user_id'],
  'billing.subscriptions': ['app.current_organization_id', 'app.global_retention_cleanup'],
  'notify.notifications': [
    'app.current_organization_id',
    'app.current_user_id',
    'app.global_retention_cleanup',
  ],
  'notify.webhook_delivery_attempts': [
    'app.current_organization_id',
    'app.global_retention_cleanup',
  ],
  'notify.webhooks': ['app.current_organization_id', 'app.global_retention_cleanup'],
  'tenancy.api_keys': ['app.current_organization_id', 'app.global_retention_cleanup'],
  'tenancy.member_invitations': ['app.current_organization_id', 'app.global_retention_cleanup'],
  'tenancy.memberships': [
    'app.current_organization_id',
    'app.current_user_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.organization_notification_policies': [
    'app.current_organization_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.organization_settings': ['app.current_organization_id', 'app.global_retention_cleanup'],
  'tenancy.organizations': [
    'app.current_organization_id',
    'app.current_user_id',
    'app.global_retention_cleanup',
  ],
  'tenancy.role_permissions': ['app.current_organization_id', 'app.global_retention_cleanup'],
  'tenancy.roles': ['app.current_organization_id', 'app.global_retention_cleanup'],
  'upload.uploads': [
    'app.current_organization_id',
    'app.current_user_id',
    'app.global_retention_cleanup',
  ],
};

/** Identity GUCs set by the principal pattern (`buildIdentityGucStatement`). */
const PRINCIPAL_GUCS = ['app.current_organization_id', 'app.current_user_id'];

/**
 * GUCs a policy arm references but NO code path sets — every entry here is a
 * dead arm scheduled for removal by a migration. Shrink-only; currently empty
 * (the app.current_session_refresh_token_hash arm was dropped by the
 * rls_policy_initplan_hygiene migration).
 */
const KNOWN_DEAD_POLICY_GUCS = new Set<string>([]);

describe('RLS table → required-scope map (Phase 8)', () => {
  it('live pg_policies GUC references match the map exactly, table by table', async () => {
    const rows = await database.execute<{ table_key: string; gucs: string | null }>(
      drizzleSql`
        SELECT x.schemaname || '.' || x.tablename AS table_key,
               string_agg(DISTINCT x.guc, ',' ORDER BY x.guc) AS gucs
        FROM (
          SELECT p.schemaname, p.tablename, m[1] AS guc
          FROM pg_policies p,
          LATERAL regexp_matches(
            COALESCE(p.qual, '') || ' ' || COALESCE(p.with_check, ''),
            'app\\.[a-z_]+',
            'g'
          ) m
        ) x
        GROUP BY x.schemaname, x.tablename
      `,
    );
    const resultRows = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: { table_key: string; gucs: string | null }[] }).rows ?? []);
    const live = new Map(resultRows.map((row) => [row.table_key, row.gucs ?? '']));

    const actual: Record<string, readonly string[]> = {};
    for (const table of EXPECTED_FORCE_RLS_TABLES) {
      const key = `${table.schemaName}.${table.tableName}`;
      const gucs = live.get(key);
      actual[key] = gucs === undefined || gucs === '' ? [] : gucs.split(',');
    }

    expect(actual).toEqual(RLS_TABLE_SCOPE_MAP);
  });

  it('the map covers exactly the FORCE-RLS table set', () => {
    const expected = EXPECTED_FORCE_RLS_TABLES.map(
      (table) => `${table.schemaName}.${table.tableName}`,
    ).sort();
    expect(Object.keys(RLS_TABLE_SCOPE_MAP).sort()).toEqual(expected);
  });

  it('every mapped GUC is registry-known (or a documented dead arm)', () => {
    const legal = new Set<string>(PRINCIPAL_GUCS);
    for (const definition of Object.values(SESSION_CONTEXTS)) {
      legal.add(definition.guc);
    }
    for (const definition of Object.values(MAINTENANCE_CONTEXTS)) {
      if (definition.guc !== null) {
        legal.add(definition.guc);
      }
    }

    const unknown = Object.values(RLS_TABLE_SCOPE_MAP)
      .flat()
      .filter((guc) => !(legal.has(guc) || KNOWN_DEAD_POLICY_GUCS.has(guc)));
    expect(
      unknown,
      `Policy GUC(s) with no registry entry and no dead-arm note: ${unknown.join(', ')}. ` +
        'A policy arm must be armed by a scope-registry kind — or explicitly listed as dead.',
    ).toEqual([]);
  });
});
