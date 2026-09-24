/**
 * Sign in over the running API with a password and return the session's access token, for the
 * operator tools that mint k6 credentials (`tool:load-test-credentials`, `tool:admin-token`).
 *
 * @remarks
 * Access tokens are session-bound, so a tool that needs one signs in rather than signing a JWT
 * itself. Exits the process with a message on failure: a non-2xx login (its body is printed and
 * holds no secret) or a response without `access_token`, such as an MFA challenge. Every caller is
 * a CLI whose only useful reaction is to stop.
 */
export async function signInOverApi(options: {
  apiPrefix: string;
  email: string;
  password: string;
}): Promise<string> {
  const loginResponse = await fetch(`${options.apiPrefix}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.password }),
  });

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    console.error(`Login as ${options.email} failed:`, loginResponse.status, text);
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
  return token;
}
