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
import { siteRouter } from "./routes/site.js";

const app = express();

// In production this API typically sits behind a reverse proxy (nginx, the
// platform's edge router, etc.). Without this, req.ip resolves to the proxy's
// own address and every request looks like it came from one IP — which would
// trip the rate limiters for everyone at once.
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

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
app.use("/api/events", publicEventsRouter);
app.use("/api/committees", publicCommitteesRouter);
app.use("/api/checklists", checklistsRouter);
app.use("/api/branch", branchRouter);
app.use("/api/forum", forumRouter);
app.use("/api/site", siteRouter);
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
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`);
});
