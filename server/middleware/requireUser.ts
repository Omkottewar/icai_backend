import type { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE, getUserBySessionToken } from "../auth/jwt.js";

export type AuthedRequest = Request & {
  user?: NonNullable<Awaited<ReturnType<typeof getUserBySessionToken>>>;
};

/**
 * Extracts the session JWT from either an HttpOnly cookie (web browser)
 * OR an "Authorization: Bearer <jwt>" header (mobile app / any non-
 * cookie client). Same token format either way — it's just the transport
 * that differs.
 */
function extractSessionToken(req: Request): string | null {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
}

/**
 * Verifies the session JWT and loads the user. Returns 401 if no valid
 * token is present. Attaches req.user on success.
 */
export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = extractSessionToken(req);
  if (!token) return res.status(401).json({ error: "unauthenticated" });

  const user = await getUserBySessionToken(token);
  if (!user) return res.status(401).json({ error: "unauthenticated" });

  req.user = user;
  next();
}

/**
 * Soft auth — attaches req.user if a valid session cookie/header is
 * present, but does NOT 401 if missing/invalid. Use this for endpoints
 * that return different (typically richer) data when the requester is
 * authenticated but should still respond to anonymous callers.
 */
export async function optionalUser(req: AuthedRequest, _res: Response, next: NextFunction) {
  const token = extractSessionToken(req);
  if (!token) return next();
  try {
    const user = await getUserBySessionToken(token);
    if (user) req.user = user;
  } catch {
    // Bad/expired token — treat as anonymous; do not surface the error.
  }
  next();
}
