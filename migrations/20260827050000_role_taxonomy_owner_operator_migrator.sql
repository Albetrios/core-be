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
-- PG16+ (hosted 42501 fix): make creator self-grants SET-capable for roles created
-- in this session — `ALTER ... OWNER TO core_be_owner` requires membership WITH SET,
-- and a non-superuser executor cannot self-elevate SET afterwards (self-administration
-- was removed in PG16). Session-scoped USERSET GUC; superusers are unaffected.
SET createrole_self_grant = 'inherit, set';
--> statement-breakpoint
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
--
-- Hosted 42501/0LP01 fix — the ownership sweep below needs membership WITH SET in
-- core_be_owner, and PG16+ removed self-administration (an executor can NEVER grant
-- itself the missing SET; a pg_has_role 'member' guard is satisfied by an
-- inherit-only createrole_self_grant, which is exactly how the first Neon deploy
-- failed while local superusers sailed through). Layered ensure:
--   1. superuser → nothing needed;
--   2. SET-capable membership already present → done;
--   3. try a normal grant (works when the executor holds independent ADMIN);
--   4. half-provisioned state (role exists, owns nothing, no SET path): recreate it —
--      the createrole_self_grant session setting above makes the creator's implicit
--      membership SET-capable;
--   5. role already owns objects and no path to SET → fail LOUDLY with the manual fix.
DO $$
DECLARE
  has_set_membership BOOLEAN;
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RETURN;
  END IF;
  SELECT COALESCE(bool_or(membership.set_option), FALSE)
    INTO has_set_membership
    FROM pg_auth_members membership
   WHERE membership.roleid = 'core_be_owner'::regrole
     AND membership.member = current_user::regrole;
  IF has_set_membership THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE format('GRANT core_be_owner TO %I WITH ADMIN TRUE, SET TRUE, INHERIT TRUE', current_user);
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM pg_shdepend dependency
    WHERE dependency.refobjid = 'core_be_owner'::regrole AND dependency.deptype = 'o'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'core_be_owner already owns objects but %s has no SET-capable membership; run as a role with independent ADMIN: GRANT core_be_owner TO %s WITH ADMIN TRUE, SET TRUE, INHERIT TRUE',
      current_user, current_user);
  END IF;
  -- The role owns no objects (checked above) but may hold ACL grants (e.g. the
  -- database CONNECT granted earlier in this file) which block DROP ROLE (2BP01);
  -- DROP OWNED clears them and needs only membership, not SET.
  EXECUTE 'DROP OWNED BY core_be_owner';
  EXECUTE 'DROP ROLE core_be_owner';
  EXECUTE 'CREATE ROLE core_be_owner NOLOGIN';
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO core_be_owner', current_database());
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
