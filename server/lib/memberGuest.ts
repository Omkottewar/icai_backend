// Tokens for members who register for events by membership number (MRN)
// without logging in.
//
//   • guest token   — issued after the member enters the email OTP. Lets the
//                     browser call the event-register endpoint as that member
//                     for 2 hours. Sent in the `X-Guest-Token` header.
//   • payment view  — lets a guest open /payments/result for one payment.
//
// Both are signed with a key DERIVED from JWT_SECRET, so a guest token can
// never be used as a login session (session tokens use JWT_SECRET itself).

import type { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../schema/index.js";
import { SESSION_COOKIE, getUserBySessionToken } from "../auth/jwt.js";
import type { AuthedRequest } from "../middleware/requireUser.js";

const GUEST_TTL_SECONDS = 2 * 60 * 60;
const PAYVIEW_TTL_SECONDS = 30 * 24 * 60 * 60;

function derivedSecret(purpose: string): string {
  const base = process.env.JWT_SECRET;
  if (!base || base.length < 32) throw new Error("JWT_SECRET is missing or too short (need ≥ 32 chars).");
  return createHash("sha256").update(`${base}:${purpose}`).digest("hex");
}

export function signGuestToken(userId: string, mrn: string): string {
  return jwt.sign({ typ: "member_guest", mrn }, derivedSecret("member-guest"), { subject: userId, expiresIn: GUEST_TTL_SECONDS });
}

export function verifyGuestToken(token: string): { userId: string; mrn: string } | null {
  try {
    const c = jwt.verify(token, derivedSecret("member-guest")) as jwt.JwtPayload;
    if (c.typ !== "member_guest" || !c.sub) return null;
    return { userId: c.sub, mrn: String(c.mrn ?? "") };
  } catch {
    return null;
  }
}

export function signPaymentViewToken(paymentId: string): string {
  return jwt.sign({ typ: "payview" }, derivedSecret("payment-view"), { subject: paymentId, expiresIn: PAYVIEW_TTL_SECONDS });
}

export function verifyPaymentViewToken(token: string, paymentId: string): boolean {
  try {
    const c = jwt.verify(token, derivedSecret("payment-view")) as jwt.JwtPayload;
    return c.typ === "payview" && c.sub === paymentId;
  } catch {
    return false;
  }
}

export type GuestAwareRequest = AuthedRequest & { isGuest?: boolean; guestMrn?: string };

// Logged-in session first; otherwise a valid X-Guest-Token. 401 if neither.
export async function requireUserOrGuest(req: GuestAwareRequest, res: Response, next: NextFunction) {
  const cookie = req.cookies?.[SESSION_COOKIE];
  const auth = req.headers.authorization;
  const session = cookie || (auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "");
  if (session) {
    const user = await getUserBySessionToken(session);
    if (user) { req.user = user; return next(); }
  }

  const guestHeader = String(req.headers["x-guest-token"] ?? "").trim();
  const claims = guestHeader ? verifyGuestToken(guestHeader) : null;
  if (!claims) return res.status(401).json({ error: "unauthenticated" });

  const [user] = await db.select().from(users).where(and(
    eq(users.id, claims.userId),
    isNull(users.deleted_at),
    inArray(users.status, ["active", "pending_approval"]),
  )).limit(1);
  if (!user) return res.status(401).json({ error: "unauthenticated" });

  req.user = user;
  req.isGuest = true;
  req.guestMrn = claims.mrn;
  next();
}
