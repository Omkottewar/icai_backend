import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users, oauthLinks } from "../../schema/index.js";

type Auth0Profile = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

type IntendedRole = "member" | "student" | "employer";

// Typed errors so /callback can branch on them and redirect with friendly
// messages instead of leaking 500s to the browser.
export class MissingEmailError extends Error {
  constructor() { super("Identity provider did not return an email address"); }
}
export class UnverifiedEmailError extends Error {
  constructor() { super("Email address is not verified"); }
}
export class NoAccountError extends Error {
  constructor() { super("No account exists for this email â€” please sign up"); }
}

const PG_UNIQUE_VIOLATION = "23505";
const isPgUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === PG_UNIQUE_VIOLATION;

/**
 * Find a user by their Auth0 `sub`, or create one if this is a signup.
 *
 * Strategy:
 *  1. Lookup oauth_links(provider='auth0', external_id=sub). Match â†’ done.
 *  2. Lookup users by email. Match AND email is verified â†’ link & return.
 *     Match BUT unverified â†’ refuse (account-takeover guard).
 *  3. No match: create new user, but ONLY if this is a signup flow
 *     (intendedRole provided). Login flow throws NoAccountError so the
 *     caller can redirect to /signup.
 *
 * The returned `isNew` is the caller's signal for "send this user to
 * /onboarding instead of /dashboard". We define it as "phone is empty"
 * because routes/onboarding.ts sets users.phone as the first thing it
 * writes â€” so a null phone reliably means the user never completed the
 * onboarding form (regardless of whether the row was created seconds ago
 * during /signup or weeks ago by a user who bailed mid-flow).
 *
 * Race-safe: if a parallel request creates the user between our check and
 * our insert, the unique-violation triggers a re-fetch by email.
 */
export async function findOrCreateUserFromAuth0(
  profile: Auth0Profile,
  opts: { intendedRole?: IntendedRole | null } = {},
) {
  if (!profile.email) throw new MissingEmailError();

  // 1. Match by provider+sub â€” always trusted (Auth0 owns this mapping)
  const linked = await db
    .select({ user: users })
    .from(oauthLinks)
    .innerJoin(users, eq(users.id, oauthLinks.user_id))
    .where(
      and(
        eq(oauthLinks.provider, "auth0"),
        eq(oauthLinks.external_id, profile.sub),
      ),
    )
    .limit(1);
  if (linked[0]) {
    await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, linked[0].user.id));
    return { user: linked[0].user, isNew: !linked[0].user.phone };
  }

  // 2. Match by email â€” but only if Auth0 says the email is verified.
  //    Without this check, an attacker could sign up with someone else's
  //    email (no verification) and silently take over their account.
  const byEmail = await db
    .select()
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);
  if (byEmail[0]) {
    if (!profile.email_verified) throw new UnverifiedEmailError();

    await db.insert(oauthLinks).values({
      user_id: byEmail[0].id,
      provider: "auth0",
      external_id: profile.sub,
      last_synced_at: new Date(),
    });
    await db.update(users).set({ last_login_at: new Date() }).where(eq(users.id, byEmail[0].id));
    return { user: byEmail[0], isNew: !byEmail[0].phone };
  }

  // 3. Brand-new user. Only allowed in signup flow (intendedRole present).
  //    A plain /login that hits an unknown email should NOT silently create
  //    an account with a guessed role â€” instead, push the user to /signup.
  if (!opts.intendedRole) throw new NoAccountError();

  const role = opts.intendedRole;
  try {
    const [created] = await db
      .insert(users)
      .values({
        name: profile.name ?? profile.email,
        email: profile.email,
        primary_role: role,
        last_login_at: new Date(),
      })
      .returning();

    await db.insert(oauthLinks).values({
      user_id: created.id,
      provider: "auth0",
      external_id: profile.sub,
      last_synced_at: new Date(),
    });

    return { user: created, isNew: true };
  } catch (e) {
    // Race: another request inserted the same email between our check and
    // our insert. Re-fetch and treat as a returning user.
    if (isPgUniqueViolation(e)) {
      const refetched = await db
        .select()
        .from(users)
        .where(eq(users.email, profile.email))
        .limit(1);
      if (refetched[0]) {
        // Make sure the oauth_links row exists for our sub
        await db
          .insert(oauthLinks)
          .values({
            user_id: refetched[0].id,
            provider: "auth0",
            external_id: profile.sub,
            last_synced_at: new Date(),
          })
          .onConflictDoNothing();
        return { user: refetched[0], isNew: !refetched[0].phone };
      }
    }
    throw e;
  }
}
