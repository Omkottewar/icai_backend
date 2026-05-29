import type { Request, Response, NextFunction } from "express";

/**
 * Reject mutating requests whose Origin / Referer doesn't match our own host.
 * Simple CSRF defense for a same-origin SPA — no tokens to ship.
 *
 * Allowed origins are built from env at startup:
 *   APP_URLS  — comma-separated list. Entries may use `*` as a glob, e.g.
 *               `https://icai-frontend-*-om-kottewars-projects.vercel.app`
 *               to cover all Vercel preview deploys for one project.
 *   APP_URL   — singular fallback (backwards compatible).
 *   API_URL   — this server's own origin.
 *
 * In non-production, http://localhost:5173 and :4000 are auto-allowed so
 * `npm run dev` works without env setup.
 */

// Hardcoded production frontend origins. Baked in so the backend works
// without depending on Render env vars. Glob `*` is supported.
const FRONTEND_ORIGINS = [
  // Vercel preview + production deploys for icai-frontend
  "https://icai-frontend-*-om-kottewars-projects.vercel.app",
  "https://icai-frontend.vercel.app",
  "https://icai-frontend-om-kottewars-projects.vercel.app",
];

function buildMatchers(): Array<(origin: string) => boolean> {
  const raw = [
    ...FRONTEND_ORIGINS,
    ...(process.env.APP_URLS ?? "").split(","),
    process.env.APP_URL,
    process.env.API_URL,
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);

  if (process.env.NODE_ENV !== "production") {
    raw.push("http://localhost:5173", "http://localhost:4000");
  }

  return raw.map((pattern) => {
    if (pattern.includes("*")) {
      // Glob → regex. Escape regex specials, then turn * into .*
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
      return (origin: string) => re.test(origin);
    }
    let exact: string;
    try {
      exact = new URL(pattern).origin;
    } catch {
      return () => false;
    }
    return (origin: string) => origin === exact;
  });
}

const matchers = buildMatchers();

export function sameOrigin(req: Request, res: Response, next: NextFunction) {
  // Read-only requests don't need CSRF protection — cookies aren't sent
  // cross-site for SameSite=Lax on simple GETs anyway.
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const origin = req.get("origin");
  if (origin && matchers.some((m) => m(origin))) return next();

  const referer = req.get("referer");
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (matchers.some((m) => m(refererOrigin))) return next();
    } catch {
      /* malformed referer — fall through to reject */
    }
  }

  return res.status(403).json({ error: "cross_origin_request_blocked" });
}
