import jwt, { type JwtPayload } from "jsonwebtoken";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../schema/index.js";

export const SESSION_COOKIE = "icai_session";
const TOKEN_TTL_DAYS = 30;
const TOKEN_TTL_SECONDS = TOKEN_TTL_DAYS * 86_400;

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET is missing or too short (need â‰¥ 32 chars).");
  }
  return secret;
}

export type SessionClaims = JwtPayload & { sub: string };

/** Sign a JWT for the given user id. Returned string goes into the cookie. */
export function signSessionToken(userId: string): string {
  return jwt.sign({}, getSecret(), {
    subject: userId,
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

/**
 * Verify the cookie and load the live user. Returns null on any failure:
 * bad signature, expired token, deleted user, or non-active status. We still
 * hit the DB so suspended/deleted accounts cannot keep using an unexpired
 * token â€” JWTs have no revocation list of their own.
 */
export async function getUserBySessionToken(token: string) {
  let claims: SessionClaims;
  try {
    claims = jwt.verify(token, getSecret()) as SessionClaims;
  } catch {
    return null;
  }
  if (!claims.sub) return null;

  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.id, claims.sub),
        isNull(users.deleted_at),
        eq(users.status, "active"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/** Cookie options shared by login + logout. */
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: TOKEN_TTL_SECONDS * 1000,
};
