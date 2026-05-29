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
