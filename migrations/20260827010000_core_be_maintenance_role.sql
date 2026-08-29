-- B-track pass 2 groundwork: dedicated maintenance role for RLS-bypass contexts.
--
-- `core_be_maintenance` mirrors `core_be_app`'s data-plane grants. It is created
-- NOLOGIN: an operator enables login per environment (ALTER ROLE ... LOGIN PASSWORD)
-- and provisions DATABASE_MAINTENANCE_URL — see
-- docs/deployment/runbooks/maintenance-database-role.md. Until then nothing connects
-- as this role and runtime behavior is unchanged.
--
-- Policy arms are NOT tightened here. Once every hosted environment has provisioned
-- the URL, a follow-up migration adds `current_user = 'core_be_maintenance'` to the
-- bypass arms (global_retention_cleanup / session_retention_cleanup / global_admin /
-- system_audit_insert / audit_outbox_drain), making bypass authority a
-- connection-level property instead of a GUC-only one.
DO $$
BEGIN
	CREATE ROLE core_be_maintenance NOLOGIN;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  database_name text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO core_be_maintenance', database_name);
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA auth, tenancy, billing, notify, audit, upload TO core_be_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth, tenancy, billing, notify, audit, upload TO core_be_maintenance;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth, tenancy, billing, notify, audit, upload TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA notify GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA upload GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT USAGE, SELECT ON SEQUENCES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy GRANT USAGE, SELECT ON SEQUENCES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT USAGE, SELECT ON SEQUENCES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA notify GRANT USAGE, SELECT ON SEQUENCES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT USAGE, SELECT ON SEQUENCES TO core_be_maintenance;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA upload GRANT USAGE, SELECT ON SEQUENCES TO core_be_maintenance;
