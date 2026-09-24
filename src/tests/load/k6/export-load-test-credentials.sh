#!/usr/bin/env bash
#
# Mints the k6 load-test credentials against the running API and exports them to later GitHub
# Actions steps through $GITHUB_ENV: TEST_TOKEN (the demo user, scoped to its team organization),
# TEST_ORG_ID and ADMIN_TOKEN.
#
# Access tokens live 15 minutes (ACCESS_TOKEN_EXPIRY_SECONDS), shorter than the nightly run, so
# scheduled-k6-load-slo.yml calls this before the gate and again before each long block of
# scenarios — a token minted once expired partway through the informational scenarios.
set -euo pipefail
: "${GITHUB_ENV:?GITHUB_ENV must be set — this script runs inside a GitHub Actions job}"

CREDENTIALS_OUTPUT="$(pnpm tool:load-test-credentials 2>&1)"
TOKEN="$(printf '%s\n' "$CREDENTIALS_OUTPUT" | sed -n 's/^export TEST_TOKEN="\([^"]*\)"/\1/p')"
ORGANIZATION_PUBLIC_ID="$(printf '%s\n' "$CREDENTIALS_OUTPUT" | sed -n 's/^export TEST_ORG_ID="\([^"]*\)"/\1/p')"
if [ -z "$TOKEN" ] || [ -z "$ORGANIZATION_PUBLIC_ID" ]; then
  printf '%s\n' "$CREDENTIALS_OUTPUT"
  echo "::error::Could not parse TEST_TOKEN or TEST_ORG_ID from tool:load-test-credentials"
  exit 1
fi

ADMIN_OUTPUT="$(pnpm tool:admin-token 2>&1)"
ADMIN_TOKEN_VALUE="$(printf '%s\n' "$ADMIN_OUTPUT" | sed -n 's/^export ADMIN_TOKEN="\([^"]*\)"/\1/p')"
if [ -z "$ADMIN_TOKEN_VALUE" ]; then
  printf '%s\n' "$ADMIN_OUTPUT"
  echo "::error::Could not parse ADMIN_TOKEN from tool:admin-token"
  exit 1
fi

echo "::add-mask::$TOKEN"
echo "::add-mask::$ADMIN_TOKEN_VALUE"
{
  echo "TEST_TOKEN<<EOF_TEST_TOKEN"
  echo "$TOKEN"
  echo "EOF_TEST_TOKEN"
  echo "TEST_ORG_ID<<EOF_TEST_ORG_ID"
  echo "$ORGANIZATION_PUBLIC_ID"
  echo "EOF_TEST_ORG_ID"
  echo "ADMIN_TOKEN<<EOF_ADMIN_TOKEN"
  echo "$ADMIN_TOKEN_VALUE"
  echo "EOF_ADMIN_TOKEN"
} >> "$GITHUB_ENV"
echo "Load-test credentials exported (TEST_ORG_ID=$ORGANIZATION_PUBLIC_ID)."
