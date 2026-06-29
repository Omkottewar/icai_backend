import crypto from "node:crypto";
import { Router } from "express";
import { and, eq, gte, isNull, or } from "drizzle-orm";
import {
  Auth0Error,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  loginWithPassword,
  requestPasswordReset,
  signupWithPassword,
} from "../auth/auth0.js";
import {
  SESSION_COOKIE,
  signSessionToken,
  sessionCookieOptions,
} from "../auth/jwt.js";
import {
  findOrCreateUserFromAuth0,
  MissingEmailError,
  UnverifiedEmailError,
  NoAccountError,
} from "../auth/users.js";
import { getPostLoginPath } from "../auth/landingPath.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { loginLimiter, signupLimiter, forgotPasswordLimiter } from "../middleware/rateLimit.js";
import { validatePassword } from "../auth/password.js";
import { db } from "../../db/client.js";
import { roles, userRoleAssignments, icaiMemberMaster, siteSettings } from "../../schema/index.js";

export const authRouter = Router();

const STATE_COOKIE = "icai_oauth_state";
const ROLE_COOKIE  = "icai_signup_role";

// Cookie shape that matches what we set, so clearCookie actually deletes it
// in browsers that compare attributes (Safari, Chrome w/ partitioned cookies).
const tempCookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 10 * 60 * 1000,
};
const clearCookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

// Whitelist of self-signup roles.
const SELF_SIGNUP_ROLES = ["member", "student", "employer"] as const;
type SelfSignupRole = typeof SELF_SIGNUP_ROLES[number];

function parseRoleParam(raw: unknown): SelfSignupRole | null {
  if (typeof raw !== "string") return null;
  const normalised = raw.toLowerCase();
  return (SELF_SIGNUP_ROLES as readonly string[]).includes(normalised)
    ? (normalised as SelfSignupRole)
    : null;
}

// Public-name â†’ Auth0 connection-name. Add new social providers here.
const SOCIAL_CONNECTIONS: Record<string, string> = {
  google: "google-oauth2",
  microsoft: "windowslive",
  apple: "apple",
  linkedin: "linkedin",
  github: "github",
};

const appUrl = () => process.env.APP_URL ?? "http://localhost:5173";

/** Redirect the browser to /<path>?error=<msg> on the frontend. */
function redirectWithError(res: any, path: string, message: string) {
  res.redirect(`${appUrl()}${path}?error=${encodeURIComponent(message)}`);
}

// â”€â”€â”€ POST /api/auth/login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Embedded login: the form on /login posts here. No browser redirect to
// Auth0 â€” we call /oauth/token server-side, then set our own session cookie.
authRouter.post("/login", loginLimiter, sameOrigin, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      return res.status(400).json({ error: "missing_credentials", message: "Email and password are required." });
    }

    let tokens;
    try {
      tokens = await loginWithPassword(email, password);
    } catch (e) {
      if (e instanceof Auth0Error) {
        // Auth0 returns `invalid_grant` for wrong-password and unknown-user.
        // Map to a generic 401 so we don't leak which one it was.
        if (e.code === "invalid_grant") {
          return res.status(401).json({ error: "invalid_credentials", message: "Wrong email or password." });
        }
        if (e.code === "unauthorized_client" || e.code === "access_denied") {
          return res.status(500).json({
            error: "auth_misconfigured",
            message: "Embedded login is not enabled for this Auth0 application. In Auth0 dashboard: Application â†’ Settings â†’ Advanced â†’ Grant Types â†’ enable 'Password'.",
          });
        }
        if (e.code === "too_many_attempts") {
          return res.status(429).json({ error: "rate_limited", message: "Too many sign-in attempts. Please try again in a few minutes." });
        }
        return res.status(401).json({ error: "auth_failed", message: e.description ?? "Sign-in failed." });
      }
      throw e;
    }

    const profile = await fetchUserInfo(tokens.access_token);

    // Gate: refuse login until email is verified. Catches the case where a
    // user signed up but skipped the verification email, regardless of whether
    // the Auth0 tenant is configured to block unverified login itself.
    if (profile.email_verified === false) {
      return res.status(403).json({
        error: "email_unverified",
        message: "Please verify your email address before signing in. Check your inbox for the verification link.",
      });
    }

    let result: Awaited<ReturnType<typeof findOrCreateUserFromAuth0>>;
    try {
      result = await findOrCreateUserFromAuth0(profile);
    } catch (e) {
      if (e instanceof MissingEmailError) {
        return res.status(400).json({ error: "missing_email", message: "Your account is missing an email address." });
      }
      if (e instanceof UnverifiedEmailError) {
        return res.status(403).json({ error: "email_unverified", message: "Please verify your email address before signing in." });
      }
      if (e instanceof NoAccountError) {
        // Don't reveal whether the email is registered. A real user who just
        // signed up via our flow would already have local rows (we create them
        // in /signup before email verification) â€” so this branch only fires
        // for accounts that exist at Auth0 but never went through our app.
        // Returning the same 401 we return for wrong-password prevents an
        // attacker from probing valid emails via differentiated responses.
        return res.status(401).json({ error: "invalid_credentials", message: "Wrong email or password." });
      }
      throw e;
    }

    const { user, isNew } = result;
    const token = signSessionToken(user.id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions);
    const redirect = await getPostLoginPath(user.id, isNew);
    res.json({ ok: true, redirect });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/auth/check-mrn?mrn=… ──────────────────────────────────────────
// Used by the signup form (member role) to pre-validate the MRN against the
// imported ICAI directory. Public — no PII returned beyond name + city +
// firm so the user can confirm "yes that's me" without revealing other
// directory rows. Returns { ok:true, exists, gating_enabled, profile? }.
authRouter.get("/check-mrn", async (req, res, next) => {
  try {
    const mrn = String(req.query.mrn ?? "").trim();
    if (!mrn) return res.status(400).json({ error: "missing_mrn" });

    const [flag] = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.key, "signup.mrn_gating_enabled"))
      .limit(1);
    const gatingEnabled = flag?.value === "true";

    const [row] = await db
      .select({
        mrn: icaiMemberMaster.mrn,
        name: icaiMemberMaster.name,
        city: icaiMemberMaster.city,
        firm_name: icaiMemberMaster.firm_name,
      })
      .from(icaiMemberMaster)
      .where(eq(icaiMemberMaster.mrn, mrn))
      .limit(1);

    return res.json({
      ok: true,
      exists: Boolean(row),
      gating_enabled: gatingEnabled,
      profile: row ?? null,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/signup ──────────────────────────────────────────────────
// Embedded signup. Creates the user in Auth0, then auto-logs them in so we
// can mint our own session cookie and create the local users row in one shot.
//
// MRN gating (Open Question #3): when role=member and the
// signup.mrn_gating_enabled site setting is 'true', the supplied mrn
// MUST exist in icai_member_master before we'll let the signup proceed.
authRouter.post("/signup", signupLimiter, sameOrigin, async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
      return res.status(400).json({ error: "missing_fields", message: "Email and password are required." });
    }
    const parsedRole = parseRoleParam(role);
    if (!parsedRole) {
      return res.status(400).json({ error: "invalid_role", message: "Please pick a valid role." });
    }
    // Our own password policy. Auth0 also enforces one â€” this is the floor.
    const pwError = validatePassword(password);
    if (pwError) {
      return res.status(400).json({ error: "weak_password", message: pwError });
    }

    // MRN gate (member role only). The flag is OFF by default so dev signups
    // keep working; the branch admin flips it on once they've imported the
    // ICAI directory and verified counts look right.
    if (parsedRole === "member") {
      const [flag] = await db
        .select()
        .from(siteSettings)
        .where(eq(siteSettings.key, "signup.mrn_gating_enabled"))
        .limit(1);
      if (flag?.value === "true") {
        const mrn = typeof req.body?.mrn === "string" ? req.body.mrn.trim() : "";
        if (!mrn) {
          return res.status(400).json({
            error: "mrn_required",
            message: "Membership Number (MRN) is required for member signup.",
          });
        }
        const [exists] = await db
          .select({ mrn: icaiMemberMaster.mrn })
          .from(icaiMemberMaster)
          .where(eq(icaiMemberMaster.mrn, mrn))
          .limit(1);
        if (!exists) {
          return res.status(403).json({
            error: "mrn_not_found",
            message:
              "We can't find this MRN in the Nagpur branch member master. " +
              "If you believe this is a mistake, please email nagpur@icai.org so the directory can be updated.",
          });
        }
      }
    }

    // 1. Create the user in Auth0's DB connection.
    try {
      await signupWithPassword({ email, password, name: typeof name === "string" ? name : undefined });
    } catch (e) {
      if (e instanceof Auth0Error) {
        if (e.code === "invalid_signup" || e.code === "user_exists") {
          return res.status(409).json({ error: "user_exists", message: "An account with this email already exists. Try signing in instead." });
        }
        if (e.code === "invalid_password") {
          return res.status(400).json({
            error: "weak_password",
            message: e.description ?? "Password does not meet the security requirements.",
          });
        }
        return res.status(400).json({ error: "signup_failed", message: e.description ?? "Could not create account." });
      }
      throw e;
    }

    // 2. Stash the intended role in a cookie so findOrCreateUserFromAuth0
    //    can stamp users.primary_role on the brand-new row.
    res.cookie(ROLE_COOKIE, parsedRole, tempCookieOpts);

    // 3. Auto-login to get an Auth0 access token (so we can call /userinfo
    //    and learn the new user's `sub`).
    let tokens;
    try {
      tokens = await loginWithPassword(email, password);
    } catch {
      // Account was created at Auth0 but auto-login failed (e.g. tenant
      // requires email verification before first login). Fall back to manual.
      res.clearCookie(ROLE_COOKIE, clearCookieOpts);
      return res.json({ ok: true, requiresLogin: true, message: "Account created. Please check your email to verify it, then sign in." });
    }

    const profile = await fetchUserInfo(tokens.access_token);

    // Create the local users + oauth_links rows up front, regardless of
    // verification status. If we wait until after the user verifies their
    // email, the intendedRole (which lives only in ROLE_COOKIE) is gone by
    // then â€” and the next /login call has no way to materialise the rows,
    // so it 404s with no_account. Creating now means step 1 (sub match) on
    // the next login finds the row immediately.
    let result: Awaited<ReturnType<typeof findOrCreateUserFromAuth0>>;
    try {
      result = await findOrCreateUserFromAuth0(profile, { intendedRole: parsedRole });
    } catch (e) {
      res.clearCookie(ROLE_COOKIE, clearCookieOpts);
      if (e instanceof UnverifiedEmailError) {
        return res.status(403).json({ error: "email_unverified", message: "Account created. Please verify your email before signing in." });
      }
      throw e;
    }

    res.clearCookie(ROLE_COOKIE, clearCookieOpts);

    // Rows are in place. Only mint a session if the email is verified â€”
    // unverified users can't reach /dashboard until they click the link and
    // sign in again, but their account is fully provisioned and waiting.
    if (profile.email_verified === false) {
      return res.json({
        ok: true,
        requiresVerification: true,
        message: "Account created. Please check your email for a verification link before signing in.",
      });
    }

    const { user, isNew } = result;
    const token = signSessionToken(user.id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions);
    const redirect = await getPostLoginPath(user.id, isNew);
    res.json({ ok: true, redirect });
  } catch (err) {
    next(err);
  }
});

// â”€â”€â”€ POST /api/auth/forgot-password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Always returns 200 to avoid leaking which emails are registered.
authRouter.post("/forgot-password", forgotPasswordLimiter, sameOrigin, async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (typeof email !== "string" || !email) {
      return res.status(400).json({ error: "missing_email", message: "Please enter your email." });
    }
    await requestPasswordReset(email).catch(() => {
      /* swallow â€” never reveal whether the email exists */
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// â”€â”€â”€ GET /api/auth/social/:provider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Kicks off the redirect-based flow for social IdPs (Google, Microsoft, â€¦).
// Social logins inherently require leaving the site â€” Auth0 can't proxy them
// invisibly. The callback below handles the round-trip back.
authRouter.get("/social/:provider", (req, res) => {
  const connection = SOCIAL_CONNECTIONS[req.params.provider];
  if (!connection) {
    return redirectWithError(res, "/login", "Unsupported sign-in provider.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, tempCookieOpts);

  const signup = req.query.mode === "signup";
  if (signup) {
    const role = parseRoleParam(req.query.role);
    if (role) res.cookie(ROLE_COOKIE, role, tempCookieOpts);
  }

  res.redirect(buildAuthorizeUrl(state, { signup, connection, forceAccountPicker: true }));
});

// â”€â”€â”€ GET /api/auth/callback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Only used by the social flow now. Embedded email/password never hits this.
authRouter.get("/callback", async (req, res, next) => {
  const clearTempCookies = () => {
    res.clearCookie(STATE_COOKIE, clearCookieOpts);
    res.clearCookie(ROLE_COOKIE,  clearCookieOpts);
  };

  try {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (error) {
      clearTempCookies();
      return redirectWithError(res, "/login", error_description ?? error);
    }
    if (!code || !state) {
      clearTempCookies();
      return redirectWithError(res, "/login", "Login was interrupted. Please try again.");
    }

    const cookieState = req.cookies?.[STATE_COOKIE];
    if (!cookieState || cookieState !== state) {
      clearTempCookies();
      return redirectWithError(res, "/login", "Your sign-in session expired. Please sign in again.");
    }

    // Code â†’ tokens â†’ profile
    const tokens = await exchangeCodeForTokens(code);
    const profile = await fetchUserInfo(tokens.access_token);

    const intendedRole = parseRoleParam(req.cookies?.[ROLE_COOKIE]);

    let result: Awaited<ReturnType<typeof findOrCreateUserFromAuth0>>;
    try {
      result = await findOrCreateUserFromAuth0(profile, { intendedRole });
    } catch (e) {
      clearTempCookies();
      if (e instanceof MissingEmailError) {
        return redirectWithError(res, "/login", "Your identity provider did not share an email address. Please try a different sign-in method.");
      }
      if (e instanceof UnverifiedEmailError) {
        return redirectWithError(res, "/login", "Please verify your email address with your identity provider before signing in.");
      }
      if (e instanceof NoAccountError) {
        return redirectWithError(res, "/signup", "No account exists for this email yet. Please create one.");
      }
      throw e;
    }

    const { user, isNew } = result;

    const token = signSessionToken(user.id);

    clearTempCookies();
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions);

    const redirect = await getPostLoginPath(user.id, isNew);
    res.redirect(`${appUrl()}${redirect}`);
  } catch (err) {
    next(err);
  }
});

// â”€â”€â”€ GET /api/auth/me â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns the logged-in user PLUS their currently-active role assignments
// (the real source of truth â€” primary_role is just a UI hint).
authRouter.get("/me", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: "unauthenticated" });
    const { id, name, email, phone, primary_role, locale, avatar_id, branch_id } = req.user;

    const now = new Date();
    const assignments = await db
      .select({
        code: roles.code,
        name: roles.name,
        scope_committee_id: userRoleAssignments.scope_committee_id,
        effective_from: userRoleAssignments.effective_from,
        effective_to: userRoleAssignments.effective_to,
      })
      .from(userRoleAssignments)
      .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
      .where(
        and(
          eq(userRoleAssignments.user_id, id),
          or(
            isNull(userRoleAssignments.effective_to),
            gte(userRoleAssignments.effective_to, now.toISOString().slice(0, 10)),
          ),
        ),
      );

    res.json({
      id, name, email, phone, primary_role, locale, avatar_id, branch_id,
      roles: assignments,
    });
  } catch (err) {
    next(err);
  }
});

// â”€â”€â”€ POST /api/auth/logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// We only clear our own session cookie. We don't redirect to Auth0's /v2/logout
// because (a) password users never opened an Auth0 browser session in the
// embedded flow, and (b) social users hit /authorize with prompt=login next
// time, so a stale Auth0 SSO cookie wouldn't be silently reused anyway.
authRouter.post("/logout", sameOrigin, async (_req, res, next) => {
  try {
    res.clearCookie(SESSION_COOKIE, clearCookieOpts);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
