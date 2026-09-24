/**
 * Print a super_admin access token for the k6 admin scenarios and Bull Board, minted by signing in.
 *
 * Access tokens are session-bound — the auth middleware accepts a token only while its session
 * exists — and super_admin is granted only to an email on GLOBAL_ADMIN_EMAILS. The token this tool
 * used to sign on its own had no session behind it, so every request carrying it got 401: the
 * nightly's admin and audit-list scenarios failed on every request.
 *
 * It now signs in over the API as ADMIN_EMAIL (default: the first GLOBAL_ADMIN_EMAILS entry) with
 * ADMIN_PASSWORD (default: DEMO_PASSWORD, else the demo default) against BASE_URL. Create that
 * account first:  DEMO_EMAIL=<admin email> DEMO_PASSWORD=<password> pnpm db:seed:demo-admin
 * A super_admin token lives GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS (default 5 minutes).
 *
 * Run: pnpm run tool:admin-token
 */
import '@/shared/config/load-env-files.js';

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
  const loginResponse = await fetch(`${API_PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    console.error(`Login as ${ADMIN_EMAIL} failed:`, loginResponse.status, text);
    process.exit(1);
  }

  const loginBody = (await loginResponse.json()) as {
    data?: { access_token?: string };
  };
  const token = loginBody.data?.access_token;
  if (!token) {
    console.error('Login response missing access_token');
    process.exit(1);
  }

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
