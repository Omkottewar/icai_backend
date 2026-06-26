import type { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE, getUserBySessionToken } from "../auth/jwt.js";

export type AuthedRequest = Request & {
  user?: NonNullable<Awaited<ReturnType<typeof getUserBySessionToken>>>;
};

/**
 * Verifies the JWT cookie and loads the user. Returns 401 if no valid
 * token is present. Attaches req.user on success.
 */
export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: "unauthenticated" });

  const user = await getUserBySessionToken(token);
  if (!user) return res.status(401).json({ error: "unauthenticated" });

  req.user = user;
  next();
}

/**
 * Soft auth — attaches req.user if a valid session cookie is present,
 * but does NOT 401 if missing/invalid. Use this for endpoints that
 * return different (typically richer) data when the requester is
 * authenticated but should still respond to anonymous callers.
 */
export async function optionalUser(req: AuthedRequest, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  try {
    const user = await getUserBySessionToken(token);
    if (user) req.user = user;
  } catch {
    // Bad/expired token — treat as anonymous; do not surface the error.
  }
  next();
}
