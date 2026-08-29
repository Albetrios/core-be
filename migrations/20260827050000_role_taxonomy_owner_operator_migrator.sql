-- Role taxonomy — local mirrors live so agents never reason from a superuser-masked
-- local again. Five named roles, one semantic each:
--
--   core_be_owner     NOLOGIN  owns every schema/table/sequence — DDL + TRUNCATE
--                              authority; RLS-SUBJECT on data (FORCE binds owners)
--   core_be_migrator  NOLOGIN  dedicated migration login (member of core_be_owner);
--                              hosted may keep using the provider owner in
--                              DATABASE_MIGRATION_URL — same semantic slot
--   core_be_operator  NOLOGIN  test-harness / seed / ops fixtures (member of
--                              core_be_owner); LOCAL provisioning additionally grants
--                              LOGIN + BYPASSRLS (superuser-only attribute) so
--                              cross-tenant fixtures work — hosted never provisions it
--   core_be_app                runtime (DATABASE_URL) — RLS-subject
--   core_be_maintenance        bypass contexts (DATABASE_MAINTENANCE_URL) — RLS-subject
--
-- SECURITY DEFINER functions are deliberately NOT reassigned to core_be_owner:
-- a definer executes as its OWNER, and FORCE RLS binds a non-exempt owner — reassigning
-- would make every resolver (billing/tenancy/notify/audit resolve_*) silently return
-- ZERO rows (empirically reproduced). Functions stay owned by the migration-executing
-- role: local `core` (superuser, exempt) / hosted provider owner (BYPASSRLS via the
-- provider's elevated grant). Verify resolver behavior after hosted provisioning —
-- the rls-offboarding-regressions db.unit suite asserts it as core_be_app.
DO $$
BEGIN
	CREATE ROLE core_be_owner NOLOGIN;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	CREATE ROLE core_be_migrator NOLOGIN;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	CREATE ROLE core_be_operator NOLOGIN;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  database_name TEXT := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO core_be_owner, core_be_migrator, core_be_operator', database_name);
END $$;
--> statement-breakpoint
GRANT core_be_owner TO core_be_migrator WITH ADMIN OPTION;
--> statement-breakpoint
GRANT core_be_owner TO core_be_operator;
--> statement-breakpoint
-- The operator is the fixture super-role: membership in the two runtime roles lets the
-- test harness `SET LOCAL ROLE core_be_app / core_be_maintenance` to exercise real RLS
-- (after SET ROLE the current user is the RLS-subject role, so policies apply exactly
-- as they do for production connections).
GRANT core_be_app TO core_be_operator;
--> statement-breakpoint
GRANT core_be_maintenance TO core_be_operator;
--> statement-breakpoint
-- Fixture scratch space: harness suites create throwaway tables in `public`
-- (batch-delete FK probes, RLS scratch tables). PG15+ removed public CREATE for
-- non-owners, which the previous superuser harness never noticed.
GRANT USAGE, CREATE ON SCHEMA public TO core_be_operator;
--> statement-breakpoint
-- Migration-ledger access: the harness READS it (migrations-forward test, operator)
-- and the dedicated migrator WRITES it (recording applied files once
-- DATABASE_MIGRATION_URL points at core_be_migrator — the bootstrap superuser is then
-- needed only for a fresh clone's very first migrate). Created by migrate.ts before
-- any migration runs; guarded for exotic replays.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations') THEN
    GRANT SELECT ON TABLE public.schema_migrations TO core_be_operator;
    GRANT SELECT, INSERT ON TABLE public.schema_migrations TO core_be_migrator;
    -- migrate.ts opens with CREATE TABLE IF NOT EXISTS on the ledger — schema CREATE
    -- is checked even when the table already exists.
    GRANT USAGE, CREATE ON SCHEMA public TO core_be_migrator;
  END IF;
END $$;
--> statement-breakpoint
-- The role executing this migration keeps full DDL power over the reassigned objects
-- (future migrations run as the same role, or as core_be_migrator once dedicated).
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'core_be_owner', 'member') THEN
    EXECUTE format('GRANT core_be_owner TO %I WITH ADMIN OPTION', current_user);
  END IF;
END $$;
--> statement-breakpoint
-- Ownership sweep: schemas, tables, sequences → core_be_owner. Policies, indexes,
-- constraints, and grants ride along with their tables.
DO $$
DECLARE
  entry RECORD;
BEGIN
  FOR entry IN
    SELECT nspname FROM pg_namespace WHERE nspname IN ('auth','tenancy','billing','notify','audit','upload')
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO core_be_owner', entry.nspname);
  END LOOP;
  FOR entry IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname IN ('auth','tenancy','billing','notify','audit','upload')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO core_be_owner', entry.schemaname, entry.tablename);
  END LOOP;
  FOR entry IN
    SELECT schemaname, sequencename FROM pg_sequences
    WHERE schemaname IN ('auth','tenancy','billing','notify','audit','upload')
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO core_be_owner', entry.schemaname, entry.sequencename);
  END LOOP;
END $$;
