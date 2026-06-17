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
import { runNotificationHealthcheck } from "./lib/notifyHealthcheck.js";
import { publicJobsRouter } from "./routes/jobs.js";
import { membersRouter } from "./routes/members.js";
import { notificationsRouter } from "./routes/notifications.js";
import { pushRouter } from "./routes/push.js";
import { checklistTasksRouter } from "./routes/checklistTasks.js";
import { branchContentRouter } from "./routes/branchContent.js";
import { grievancesRouter } from "./routes/grievances.js";

const app = express();

// The API sits behind a reverse proxy on every cloud host (Render, Railway,
// Fly, nginx, etc.). Without this, req.ip resolves to the proxy's own address
// and every request looks like it came from one IP — which trips the rate
// limiters for everyone at once. One hop = trust the immediate proxy only,
// safe in dev (no forwarded header) and in any single-proxy deployment.
app.set("trust proxy", 1);

// Bumped from the default 100kb so event-banner uploads (base64-encoded
// images up to 6 MB AND videos up to 30 MB on the file endpoint) fit
// through the JSON parser. Base64 inflates by ~33%, so 50 MB gives the
// 30 MB video cap (≈ 40 MB base64) comfortable headroom.
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

// Serve uploaded banners/certificates. Local-disk-backed for the MVP;
// swap for Supabase Storage signed URLs later without changing the public
// /uploads/<bucket>/<file> URL shape.
app.use("/uploads", express.static(join(process.cwd(), "uploads"), {
  maxAge: "1d",
  fallthrough: false,
}));

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
app.use("/api/events", publicEventsRouter);
app.use("/api/committees", publicCommitteesRouter);
app.use("/api/checklist-templates", checklistTemplatesRouter);
app.use("/api/checklist-instances", checklistInstancesRouter);
app.use("/api/branch", branchRouter);
app.use("/api/forum", forumRouter);
app.use("/api/site", siteRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/employer", employerRouter);
app.use("/api/jobs", publicJobsRouter);
app.use("/api/members", membersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/push", pushRouter);
app.use("/api/checklist-tasks", checklistTasksRouter);
// Branch-level content (Resources page, Gallery, About page). One router
// serves all five entities — endpoints are scoped under sub-paths like
// /paper-presentations, /gallery-albums, /newsletters, /office-bearers,
// /annual-reports.
app.use("/api", branchContentRouter);
app.use("/api/grievances", grievancesRouter);
app.use("/api/admin", adminRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

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

// Boot-time notification system sanity check — confirms every template
// key referenced in code exists + is enabled in DB, and flags missing
// SMTP / VAPID config. Logs go to stdout; non-fatal.
runNotificationHealthcheck();
