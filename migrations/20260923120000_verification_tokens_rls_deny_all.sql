-- `auth.verification_tokens` holds password-reset and email-OTP token hashes, and it was the
-- ONLY FORCE RLS table in the schema whose policy restricted nothing: a single
-- `verification_tokens_application_access` granted `TO public` with `USING (true)` and
-- `WITH CHECK (true)`. FORCE RLS was therefore on in name only — any role that could reach the
-- table could read or tamper with every reset and OTP hash, and isolation rested entirely on
-- the application remembering to scope by `user_id` in SQL.
--
-- `schema-rls-parity.global.test.ts` never caught it because it asserts a table DECLARES force
-- RLS, not that its policies filter anything.
--
-- Apply the same deny-all + runtime-role pair every other system table already uses
-- (20260520000001_system_tables_rls_deny_all, 20260611010200_plans_permissions_rls_deny_all).
-- This is role gating, not row gating: `core_be_app` keeps full access, so every existing call
-- site — including the ones that inherit a caller's context rather than opening their own —
-- behaves exactly as before. What changes is that a non-application credential is now denied.

ALTER TABLE auth.verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.verification_tokens FORCE ROW LEVEL SECURITY;

-- The permissive TO public policy this replaces.
DROP POLICY IF EXISTS verification_tokens_application_access ON auth.verification_tokens;

DROP POLICY IF EXISTS verification_tokens_deny_all ON auth.verification_tokens;
CREATE POLICY verification_tokens_deny_all ON auth.verification_tokens
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS verification_tokens_app_access ON auth.verification_tokens;
CREATE POLICY verification_tokens_app_access ON auth.verification_tokens
  AS PERMISSIVE
  FOR ALL
  TO core_be_app
  USING (true)
  WITH CHECK (true);
