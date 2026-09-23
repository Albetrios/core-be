-- Backfill webhook:read + webhook:manage on existing TEAM org Owner roles.
--
-- Both codes were seeded into tenancy.permissions but granted to no role in any
-- organization, ever, so /notify/webhooks answered 403 to every caller including
-- the organization's own owner — and the frontend's integrations panel, which
-- gates its webhook section on webhook:read, rendered an API-keys list under a
-- heading promising "API keys and webhooks".
--
-- New TEAM orgs receive these via organization-provisioning.ts; this closes the
-- gap for orgs created before that bootstrap change. Mirrors the shape of
-- 20260628150000_team_owner_billing_permissions_backfill.sql.

-- The grant below carries an FK to tenancy.permissions, and that catalog is
-- reference data supplied by the seeders (permission.reference.seed.ts), not by
-- migrations. A database that has never been reference-seeded would therefore
-- fail this migration outright the moment it holds one TEAM Owner role. Insert
-- the two codes first, idempotently and with the seeder's exact name/category,
-- so the migration stands on its own wherever it runs.
-- Both tables are FORCE ROW LEVEL SECURITY, and FORCE binds table owners. The migration
-- login (`core_be_migrator`, a member of `core_be_owner` — see
-- 20260827050000_role_taxonomy_owner_operator_migrator) is therefore RLS-SUBJECT on data, by
-- design, so a data write here matches no policy arm and is rejected:
--   * `tenancy.permissions` is role-gated (`deny_all TO public`, `app_access TO core_be_app`);
--   * `tenancy.role_permissions` is per-organization, with WITH CHECK pinned to ONE
--     organization's GUC — and this backfill writes rows for MANY organizations in one
--     statement, which no single GUC or role arm can satisfy.
-- Hosted migrations run as the provider owner, which bypasses RLS, so this succeeded there and
-- failed only where the migrator is RLS-subject — which then blocked every later migration.
--
-- The existing role-access pattern (20260827020000: extend `*_app_access` to another role)
-- covers the first table but not the second. So for the duration of this transaction only, the
-- owner's exemption is restored by lifting FORCE, and FORCE is re-applied before commit.
--
-- The READ side needs it too, and that is the trap: `tenancy.roles` and
-- `tenancy.organizations` are FORCE RLS as well, and the backfill SELECTs from them. Lifting
-- FORCE only on the tables written lets the INSERT run but hands it zero source rows — it
-- "succeeds" and grants nothing, which is worse than the loud rejection it replaced.
-- `src/tests/security/rls/data-migration-as-owner.security.test.ts` pins this on real rows. That
-- is invisible to every other session: `ALTER TABLE` holds ACCESS EXCLUSIVE until commit, and a
-- failure anywhere rolls the whole file back, FORCE included (the runner executes a
-- transactional file inside one `sql.begin`). This is NOT `SET row_security`, which the
-- migration linter forbids because it leaks session-wide.
ALTER TABLE tenancy.permissions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.organizations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO tenancy.permissions (code, name, category)
VALUES
  ('webhook:read', 'View Webhooks', 'notify'),
  ('webhook:manage', 'Manage Webhooks', 'notify')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO tenancy.role_permissions (role_id, permission_code, created_by_user_id)
SELECT
  r.id,
  notify.code,
  COALESCE(r.created_by_user_id, o.owner_user_id)
FROM tenancy.roles r
INNER JOIN tenancy.organizations o ON o.id = r.organization_id
CROSS JOIN (
  VALUES
    ('webhook:read'),
    ('webhook:manage')
) AS notify (code)
WHERE r.is_system = true
  AND r.name = 'Owner'
  AND o.type = 'TEAM'
  AND o.deleted_at IS NULL
ON CONFLICT (role_id, permission_code) DO NOTHING;
--> statement-breakpoint
ALTER TABLE tenancy.permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.role_permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenancy.organizations FORCE ROW LEVEL SECURITY;
