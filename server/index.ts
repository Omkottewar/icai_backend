import "dotenv/config";
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
import { checklistsRouter } from "./routes/checklists.js";
import { branchRouter } from "./routes/branch.js";
import { forumRouter } from "./routes/forum.js";
import { eventChatRouter } from "./routes/eventChat.js";
import { siteRouter } from "./routes/site.js";
import { announcementsRouter } from "./routes/announcements.js";
import { employerRouter } from "./routes/employer.js";
import { attachEventChatSocket } from "./lib/eventChatSocket.js";
import { publicJobsRouter } from "./routes/jobs.js";
import { membersRouter } from "./routes/members.js";

const app = express();

// The API sits behind a reverse proxy on every cloud host (Render, Railway,
// Fly, nginx, etc.). Without this, req.ip resolves to the proxy's own address
// and every request looks like it came from one IP — which trips the rate
// limiters for everyone at once. One hop = trust the immediate proxy only,
// safe in dev (no forwarded header) and in any single-proxy deployment.
app.set("trust proxy", 1);

// Bumped from the default 100kb so event-banner uploads (base64-encoded
// images, capped at ~6 MB on the file endpoint) fit through the JSON parser.
app.use(express.json({ limit: "10mb" }));
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
app.use("/api/checklists", checklistsRouter);
app.use("/api/branch", branchRouter);
app.use("/api/forum", forumRouter);
app.use("/api/site", siteRouter);
app.use("/api/announcements", announcementsRouter);
app.use("/api/employer", employerRouter);
app.use("/api/jobs", publicJobsRouter);
app.use("/api/members", membersRouter);
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
