import rateLimit from "express-rate-limit";

// Rate limits sit in front of Auth0's own throttling. Auth0 will throttle too,
// but we want to fail fast at the edge before burning Auth0 quota, and to
// return a friendlier "try again in a moment" response.
//
// Limits are per-IP. behind a reverse proxy you'll want app.set("trust proxy", 1)
// in server/index.ts so req.ip resolves correctly.

const minutes = (n: number) => n * 60 * 1000;
const hours   = (n: number) => n * 60 * 60 * 1000;

const baseOpts = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many requests. Please wait a bit and try again." },
};

/** Sign-in: 10 attempts per 15 min per IP. Tighter than Auth0 to fail fast. */
export const loginLimiter = rateLimit({
  ...baseOpts,
  windowMs: minutes(15),
  limit: 10,
});

/** Sign-up: 5 per hour per IP. Stops the most basic bot signup attempts. */
export const signupLimiter = rateLimit({
  ...baseOpts,
  windowMs: hours(1),
  limit: 5,
});

/** Forgot password: 3 per hour per IP. Prevents email-bombing via our endpoint. */
export const forgotPasswordLimiter = rateLimit({
  ...baseOpts,
  windowMs: hours(1),
  limit: 3,
});
