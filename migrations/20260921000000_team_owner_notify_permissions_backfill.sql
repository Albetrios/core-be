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
INSERT INTO tenancy.permissions (code, name, category)
VALUES
  ('webhook:read', 'View Webhooks', 'notify'),
  ('webhook:manage', 'Manage Webhooks', 'notify')
ON CONFLICT (code) DO NOTHING;

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
