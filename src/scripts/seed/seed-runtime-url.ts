/**
 * Seed/fixture runtime URL selection — import FIRST (right after the env-file loader)
 * in every seed/fixture entrypoint, before anything can touch the database connection.
 *
 * @remarks
 * - **Notes:** with local↔live parity, `DATABASE_URL` is the RLS-subject `core_be_app`
 *   login — cross-tenant seed inserts would be rejected under it. Elevated fixture
 *   work belongs to `core_be_operator` (owner-member; BYPASSRLS locally), carried by
 *   the optional `DATABASE_OPERATOR_URL`. When it is set, seeds run on it; when unset
 *   (CI's superuser service container, legacy local setups) the plain `DATABASE_URL`
 *   keeps working unchanged. Mirrors the `DATABASE_MIGRATION_URL ?? DATABASE_URL`
 *   precedent in `migrate.ts`.
 */
if (process.env.DATABASE_OPERATOR_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_OPERATOR_URL;
}
