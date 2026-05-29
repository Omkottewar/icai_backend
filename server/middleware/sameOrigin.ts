import type { Request, Response, NextFunction } from "express";

/**
 * Reject mutating requests whose Origin / Referer doesn't match our own host.
 * This is the simplest CSRF defense for a same-origin SPA — no tokens to ship.
 *
 * Relies on the browser sending Origin on state-changing requests, which all
 * modern browsers do. Falls back to Referer (also browser-set, not spoofable
 * by JS in a victim page).
 *
 * Allowed origins come from APP_URL (the frontend) and API_URL (this server).
 */
export function sameOrigin(req: Request, res: Response, next: NextFunction) {
  // Read-only requests don't need CSRF protection — cookies aren't sent
  // cross-site for SameSite=Lax on simple GETs anyway.
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const allowed = new Set(
    [process.env.APP_URL, process.env.API_URL]
      .filter(Boolean)
      .map((u) => new URL(u as string).origin),
  );
  // Local dev sometimes lacks env vars — allow localhost defaults.
  if (process.env.NODE_ENV !== "production") {
    allowed.add("http://localhost:5173");
    allowed.add("http://localhost:4000");
  }

  const origin = req.get("origin");
  if (origin && allowed.has(origin)) return next();

  const referer = req.get("referer");
  if (referer) {
    try {
      if (allowed.has(new URL(referer).origin)) return next();
    } catch {
      /* malformed referer — fall through to reject */
    }
  }

  return res.status(403).json({ error: "cross_origin_request_blocked" });
}
