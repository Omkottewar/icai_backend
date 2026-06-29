import "dotenv/config";
import { setDefaultResultOrder } from "node:dns";

// Prefer IPv4 when resolving any hostname (Supabase, SMTP, etc.).
// Without this, hosts like Render/Fly/Railway that lack outbound IPv6 fail
// with ENETUNREACH on connections to dual-stack services that happen to
// return the AAAA record first. The local machine almost always has full
// IPv6, so this is a no-op in dev and a bug-fix in prod.
//
// Must run before any module that opens a socket — keep it at the top of
// the entry file, above the `db/client` import chain.
setDefaultResultOrder("ipv4first");

import express from "express";
import cookieParser from "cookie-parser";
import { join } from "node:path";
import { authRouter } from "./routes/auth.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { adminRouter } from "./routes/admin/index.js";
import { publicEventsRouter } from "./routes/events.js";
import { registrationsRouter } from "./routes/registrations.js";
import { publicCommitteesRouter } from "./routes/committees.js";
import { checklistTemplatesRouter } from "./routes/checklistTemplates.js";
import { checklistInstancesRouter } from "./routes/checklistInstances.js";
import { branchRouter } from "./routes/branch.js";
import { forumRouter } from "./routes/forum.js";
import { eventChatRouter } from "./routes/eventChat.js";
import { siteRouter } from "./routes/site.js";
import { announcementsRouter } from "./routes/announcements.js";
import { employerRouter } from "./routes/employer.js";
import { attachEventChatSocket } from "./lib/eventChatSocket.js";
import { startEscalationCron } from "./lib/escalations.js";
import { startPragyaanIngestCron } from "./lib/pragyaan/scheduler.js";
import { roomsRouter } from "./routes/rooms.js";
import { runNotificationHealthcheck } from "./lib/notifyHealthcheck.js";
import { publicJobsRouter } from "./routes/jobs.js";
import { membersRouter } from "./routes/members.js";
import { mockTestsRouter } from "./routes/mockTests.js";
import { mockTestAttemptsRouter } from "./routes/mockTestAttempts.js";
import { notificationsRouter } from "./routes/notifications.js";
import { pushRouter } from "./routes/push.js";
import { checklistTasksRouter } from "./routes/checklistTasks.js";
import { resourcesRouter } from "./routes/resources.js";
import { branchContentRouter } from "./routes/branchContent.js";
import { grievancesRouter } from "./routes/grievances.js";
import { pragyaanRouter } from "./routes/pragyaan.js";
import { studentSuggestionsRouter } from "./routes/studentSuggestions.js";

const app = express();

// The API sits behind a reverse proxy on every cloud host (Render, Railway,
// Fly, nginx, etc.). Without this, req.ip resolves to the proxy's own address
// and every request looks like it came from one IP — which trips the rate
// limiters for everyone at once. One hop = trust the immediate proxy only,
// safe in dev (no forwarded header) and in any single-proxy deployment.
app.set("trust proxy", 1);

// Bumped from the default 100kb so event-banner uploads (base64-encoded
// images up to 6 MB AND videos up to 100 MB on the file endpoint) fit
// through the JSON parser. Base64 inflates by ~33%, so 150 MB gives the
// 100 MB video cap (≈ 134 MB base64) comfortable headroom.
app.use(express.json({ limit: "150mb" }));
app.use(cookieParser());

// Serve uploaded banners/certificates. Local-disk-backed for the MVP;
// swap for Supabase Storage signed URLs later without changing the public
// /uploads/<bucket>/<file> URL shape.
app.use("/uploads", express.static(join(process.cwd(), "uploads"), {
  maxAge: "1d",
  fallthrough: false,
}));

// Edge-cache helper for public read endpoints. Adds Cache-Control with
// stale-while-revalidate semantics so Vercel's Mumbai edge serves repeat
// GETs in <50ms without hitting Render. Self-skips when:
//   • the request method isn't GET (writes are never cached)
//   • the request carries an auth cookie (so dashboards / personalised
//     pages can't be served stale to the wrong user)
//   • the response status isn't 2xx (Vercel won't cache 4xx/5xx anyway,
//     but no point setting the header)
function publicCache(maxAgeSec: number, swrSec = Math.max(300, maxAgeSec * 5)) {
  return (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (req.method !== "GET") return next();
    const cookieHeader = req.headers.cookie ?? "";
    const hasAuthCookie = /\bsession=/.test(cookieHeader) || /\baccess_token=/.test(cookieHeader);
    if (hasAuthCookie) return next();
    res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${maxAgeSec}, stale-while-revalidate=${swrSec}`);
    res.setHeader("Vary", "Cookie, Accept-Encoding");
    next();
  };
}

app.use("/api/auth", authRouter);
app.use("/api/onboarding", onboardingRouter);
app.use("/api/dashboard", dashboardRouter);
// registrationsRouter mounts before publicEventsRouter because it has literal
// paths like /my-registrations that would otherwise be swallowed by the
// public router's GET /:slug.
app.use("/api/events", registrationsRouter);
// eventChatRouter mounts before publicEventsRouter so the literal /:id/chat
// paths aren't swallowed by the public router's catch-all /:slug.
app.use("/api/events", eventChatRouter);
// publicCache: 60s fresh + 5min SWR for the public events list. The /:slug
// detail route inside this router also gets cached. Cookies (auth) bypass.
app.use("/api/events", publicCache(60), publicEventsRouter);
app.use("/api/committees", publicCache(300), publicCommitteesRouter);
app.use("/api/checklist-templates", checklistTemplatesRouter);
app.use("/api/checklist-instances", checklistInstancesRouter);
app.use("/api/branch", branchRouter);
app.use("/api/rooms", roomsRouter);
app.use("/api/forum", forumRouter);
// Site content slots (text/images on every public page) change rarely —
// the longer SWR window gives near-instant edge hits while admin edits
// propagate within ~5 min.
app.use("/api/site", publicCache(300), siteRouter);
app.use("/api/announcements", publicCache(60), announcementsRouter);
app.use("/api/employer", employerRouter);
app.use("/api/jobs", publicCache(60), publicJobsRouter);
app.use("/api/members", membersRouter);
app.use("/api/mock-tests", mockTestsRouter);
// Attempt lifecycle (start / save answer / submit / review). Mounted at
// /api so the routes can use both /mock-tests/:id/attempt and /attempts/:id.
app.use("/api", mockTestAttemptsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/push", pushRouter);
app.use("/api/checklist-tasks", checklistTasksRouter);
// Branch-level content (Resources page, Gallery, About page). One router
// serves all five entities — endpoints are scoped under sub-paths like
// /paper-presentations, /gallery-albums, /newsletters, /office-bearers,
// /annual-reports. All are public + static-ish, perfect cache candidates.
app.use("/api", publicCache(300), branchContentRouter);
// Section L (Resources) — papers, e-journal, topics, bookmarks, comments,
// quizzes. Lives under /api/resources/... so it doesn't collide with the
// older /paper-presentations endpoint.
app.use("/api/resources", resourcesRouter);
app.use("/api/grievances", grievancesRouter);
app.use("/api/pragyaan", pragyaanRouter);
app.use("/api/student-suggestions", studentSuggestionsRouter);
app.use("/api/admin", adminRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ─── Frontend SPA fallback ────────────────────────────────────────────────
// The frontend uses the History API (clean URLs like /events, /dashboard,
// /admin/users — no `#`). A user opening one of those URLs directly hits
// THIS server first, so we need to:
//   1. Serve the Vite-built static assets (JS/CSS/img/sw.js/manifest).
//   2. For every other GET that wants HTML, return the SPA shell
//      (frontend/dist/index.html) so React boots and useRoute() reads
//      the path on first render.
// Only activates when FRONTEND_DIST is set — set it to the absolute path
// of frontend/dist on hosts where Express serves the frontend too. On
// Vercel/Netlify the platform handles SPA fallback natively, so leave
// FRONTEND_DIST unset there.
if (process.env.FRONTEND_DIST) {
  const distDir = process.env.FRONTEND_DIST;
  app.use(express.static(distDir, { index: false, maxAge: "1h" }));
  app.get("*", (req, res, next) => {
    // Don't shadow API/uploads/ws — they're already mounted above, so
    // a request that reaches here past those routers means "no API match".
    // Still, belt-and-braces guard so a misconfigured path can't serve
    // the SPA shell to an API caller.
    if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/") || req.path.startsWith("/ws")) {
      return next();
    }
    res.sendFile(join(distDir, "index.html"));
  });
}

// Centralised error handler — keeps stack traces out of responses.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("[api error]", err);
  res.status(500).json({ error: "internal_error" });
});

const port = Number(process.env.PORT ?? 4000);
// Hold a reference to the http.Server so we can attach the WebSocket upgrade
// handler. The WS endpoint shares this port — clients connect to ws(s)://host/ws/...
const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`);
});
attachEventChatSocket(server);

// Approval-stage escalation: chairperson gets pinged when a stage stays
// pending more than 3 days past the event's ends_at. See lib/escalations.ts.
startEscalationCron();

// Pragyaan auto-ingest — re-sweeps the public corpus every 15 minutes so
// newly published events/announcements/etc. become answerable without a
// manual `npm run pragyaan:ingest`. See lib/pragyaan/scheduler.ts.
startPragyaanIngestCron();

// Boot-time notification system sanity check — confirms every template
// key referenced in code exists + is enabled in DB, and flags missing
// SMTP / VAPID config. Logs go to stdout; non-fatal.
runNotificationHealthcheck();
