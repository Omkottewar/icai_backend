// Thin wrappers around Auth0's OAuth 2.0 / Database-connection endpoints.
// Docs: https://auth0.com/docs/api/authentication
//
// Two flows are used here:
//
//  1. Embedded (default for email/password) — Resource Owner Password Grant.
//     The browser posts credentials to our Express server, which calls
//     /oauth/token with grant_type=password-realm. No Auth0-hosted page.
//
//  2. Redirect (only for social connections) — standard Authorization Code.
//     /authorize → user authenticates with the provider → /callback?code=...
//     → POST /oauth/token. Used because social IdPs require a redirect.
//
// Embedded login requires the Auth0 application to have the Password grant
// enabled and the tenant Default Directory set to the DB connection.

const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
};

const domain = () => required("AUTH0_DOMAIN");
const clientId = () => required("AUTH0_CLIENT_ID");
const clientSecret = () => required("AUTH0_CLIENT_SECRET");
const callbackUrl = () => required("AUTH0_CALLBACK_URL");
const dbConnection = () => process.env.AUTH0_CONNECTION ?? "Username-Password-Authentication";

/** Auth0 returned a non-2xx response. Carries the structured error fields. */
export class Auth0Error extends Error {
  status: number;
  code?: string;
  description?: string;
  constructor(status: number, code: string | undefined, description: string | undefined) {
    super(description || code || `Auth0 error ${status}`);
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

/** Build the /authorize URL for social (or any redirect-based) sign-in. */
export function buildAuthorizeUrl(
  state: string,
  opts: { signup?: boolean; forceAccountPicker?: boolean; connection?: string } = {},
): string {
  const u = new URL(`https://${domain()}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId());
  u.searchParams.set("redirect_uri", callbackUrl());
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", state);
  if (opts.signup) u.searchParams.set("screen_hint", "signup");
  if (opts.forceAccountPicker) u.searchParams.set("prompt", "login");
  if (opts.connection) u.searchParams.set("connection", opts.connection);
  return u.toString();
}

/** Exchange the ?code= we received on the social callback for tokens. */
export async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  id_token: string;
  expires_in: number;
}> {
  const r = await fetch(`https://${domain()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
      redirect_uri: callbackUrl(),
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Auth0 token exchange failed: ${r.status} ${body}`);
  }
  return r.json();
}

/**
 * Resource Owner Password Grant — exchange username+password for tokens
 * without a browser redirect. Used by the embedded login form.
 */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<{ access_token: string; id_token: string; expires_in: number }> {
  const r = await fetch(`https://${domain()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // The "realm" variant lets us target a specific DB connection without
      // relying on the tenant's Default Directory being set.
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: dbConnection(),
      client_id: clientId(),
      client_secret: clientSecret(),
      username,
      password,
      scope: "openid profile email",
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({} as { error?: string; error_description?: string }));
    throw new Auth0Error(r.status, body.error, body.error_description ?? body.error);
  }
  return r.json();
}

/** Create a new user in Auth0's database connection. */
export async function signupWithPassword(args: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ _id: string; email: string }> {
  const r = await fetch(`https://${domain()}/dbconnections/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId(),
      connection: dbConnection(),
      email: args.email,
      password: args.password,
      name: args.name,
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({} as { code?: string; error?: string; description?: string; error_description?: string; message?: string }));
    throw new Auth0Error(
      r.status,
      body.code ?? body.error,
      body.description ?? body.error_description ?? body.message,
    );
  }
  return r.json();
}

/**
 * Trigger Auth0's password-reset email. Auth0 returns 200 even for unknown
 * emails (to prevent user enumeration), so callers should always respond ok.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await fetch(`https://${domain()}/dbconnections/change_password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId(),
      email,
      connection: dbConnection(),
    }),
  });
}

/** Resolve the access token to a user profile (sub, email, email_verified, name, picture). */
export async function fetchUserInfo(accessToken: string): Promise<{
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}> {
  const r = await fetch(`https://${domain()}/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Auth0 userinfo failed: ${r.status}`);
  return r.json();
}

/** URL we redirect the browser to so Auth0 also clears its SSO session. */
export function buildLogoutUrl(returnTo: string): string {
  const u = new URL(`https://${domain()}/v2/logout`);
  u.searchParams.set("client_id", clientId());
  u.searchParams.set("returnTo", returnTo);
  return u.toString();
}
