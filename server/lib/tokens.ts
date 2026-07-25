import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC-signed short tokens for public-URL flows that need to identify a user
// without a session cookie (e.g. job-alert confirmation link, unsubscribe
// preference centre). Encoding the (user_id, purpose, exp) triple into a
// signed token means we don't need a token table — verification is a pure
// HMAC check plus an expiry compare.
//
// Payload format:   <b64url(user_id).b64url(purpose).b64url(exp)>.<sig>
// The signature covers all three parts joined by "." so tampering any of
// them invalidates the token.

function b64url(input: Buffer | string): string {
  const b = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function secret(): string {
  // Reuse the JWT secret so we don't multiply the number of secrets ops has
  // to manage. If the JWT secret ever rotates, tokens issued before rotation
  // stop verifying — that's fine for these short-lived links.
  const s = process.env.SESSION_JWT_SECRET || process.env.JWT_SECRET;
  if (!s) {
    // In dev without a secret, fall back to a fixed dev-only string so links
    // still work when the developer forgot to set it. Loud console warning.
    // eslint-disable-next-line no-console
    console.warn("[tokens] SESSION_JWT_SECRET not set — using dev fallback");
    return "dev-insecure-token-secret";
  }
  return s;
}

function sign(input: string): string {
  return b64url(createHmac("sha256", secret()).update(input).digest());
}

export type TokenPurpose =
  | "job_alert_confirm"
  | "job_alert_manage";

/**
 * Issue a signed token. `ttlSeconds` controls how long the link stays valid;
 * pass a longer TTL for manage links (they're bookmarkable) and a shorter one
 * for confirm links (they should be acted on quickly).
 */
export function issueToken(user_id: string, purpose: TokenPurpose, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const parts = [b64url(user_id), b64url(purpose), b64url(String(exp))];
  const body = parts.join(".");
  return `${body}.${sign(body)}`;
}

/**
 * Verify a token and return the user_id it identifies, or null if the token
 * is malformed, tampered with, expired, or for the wrong purpose.
 */
export function verifyToken(token: string, expectedPurpose: TokenPurpose): string | null {
  if (typeof token !== "string" || token.length < 8) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [uidPart, purposePart, expPart, sig] = parts;
  const body = `${uidPart}.${purposePart}.${expPart}`;
  const expected = sign(body);
  // Constant-time compare — same-length strings only, so guard first.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let user_id: string, purpose: string, exp: number;
  try {
    user_id = b64urlDecode(uidPart);
    purpose = b64urlDecode(purposePart);
    exp     = Number(b64urlDecode(expPart));
  } catch { return null; }
  if (!user_id || purpose !== expectedPurpose) return null;
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  return user_id;
}
