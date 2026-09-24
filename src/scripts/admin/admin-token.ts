/**
 * Print a super_admin access token for the k6 admin scenarios and Bull Board, minted by signing in.
 *
 * Access tokens are session-bound — the auth middleware accepts a token only while its session
 * exists, so a token signed without one is refused on every request — and super_admin is granted
 * only to an email on GLOBAL_ADMIN_EMAILS. So this tool signs in over the API as ADMIN_EMAIL
 * (default: the first GLOBAL_ADMIN_EMAILS entry) with ADMIN_PASSWORD (default: DEMO_PASSWORD, else
 * the demo default) against BASE_URL. Create that account first:
 *   DEMO_EMAIL=<admin email> DEMO_PASSWORD=<password> pnpm db:seed:demo-admin
 * A super_admin token lives GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS (default 5 minutes).
 *
 * Run: pnpm run tool:admin-token
 */
import '@/shared/config/load-env-files.js';
import { signInOverApi } from '@/scripts/admin/api-sign-in.util.js';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const API_PREFIX = `${BASE_URL}/api/v1`;
const ADMIN_EMAIL =
  process.env.ADMIN_EMAIL ??
  (process.env.GLOBAL_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim())
    .find((email) => email.length > 0) ??
  'demo@example.com';
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ?? process.env.DEMO_PASSWORD ?? 'DemoPassword123!';

/** The `role` claim of an access token (the payload is not verified here; the server did that). */
function roleClaimOf(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    role?: string;
  };
  return claims.role;
}

async function main() {
  const token = await signInOverApi({
    apiPrefix: API_PREFIX,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });

  const role = roleClaimOf(token);
  if (role !== 'super_admin') {
    console.error(
      `${ADMIN_EMAIL} signed in as ${role ?? 'an unknown role'}, not super_admin — add it to GLOBAL_ADMIN_EMAILS.`,
    );
    process.exit(1);
  }

  console.log('Copy for k6 admin scenario:');
  console.log('');
  console.log(`export ADMIN_TOKEN="${token}"`);
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
