import { Router } from "express";
import { requireUser } from "../../middleware/requireUser.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { requireRole } from "../../middleware/requireRole.js";
import type { Request, Response, NextFunction } from "express";
import { eventsAdminRouter } from "./events.js";
import { eventSpeakersAdminRouter } from "./eventSpeakers.js";
import { registrationsAdminRouter } from "./registrations.js";
import { statsAdminRouter } from "./stats.js";
import { filesAdminRouter } from "./files.js";
import { usersAdminRouter } from "./users.js";
import { committeesAdminRouter } from "./committees.js";
import { siteAdminRouter } from "./site.js";
import { announcementsAdminRouter } from "./announcements.js";
import { jobsAdminRouter } from "./jobs.js";
import { notificationTemplatesAdminRouter } from "./notificationTemplates.js";
import { homeAdminRouter } from "./home.js";
import { refundsAdminRouter } from "./refunds.js";
import { billsAdminRouter } from "./bills.js";
import { iutTransfersAdminRouter } from "./iutTransfers.js";
import { mockTestsAdminRouter } from "./mockTests.js";
import { mockTestQuestionsAdminRouter } from "./mockTestQuestions.js";
import { mentorshipAdminRouter } from "./mentorship.js";
import { articleshipMatchesAdminRouter } from "./articleshipMatches.js";
import { scholarshipsAdminRouter, scholarshipApplicationsAdminRouter } from "./scholarships.js";
import { vendorsAdminRouter, expenseCategoriesAdminRouter } from "./vendorsAndCategories.js";
import { budgetsAdminRouter } from "./budgets.js";
import { treasurerAnalyticsAdminRouter } from "./treasurerAnalytics.js";
import { exportsAdminRouter } from "./exports.js";
import { reportsAdminRouter } from "./reports.js";
import { approvalsAdminRouter } from "./approvals.js";
import { paperPresentationsAdminRouter } from "./paperPresentations.js";
import { galleryAdminRouter } from "./galleryAlbums.js";
import { galleryVideosAdminRouter } from "./galleryVideos.js";
import { newslettersAdminRouter } from "./newsletters.js";
import { officeBearersAdminRouter } from "./officeBearers.js";
import { annualReportsAdminRouter } from "./annualReports.js";
import { grievancesAdminRouter, grievanceRoutesAdminRouter } from "./grievances.js";
import { resourcesAdminRouter } from "./resources.js";
import { pragyaanAdminRouter } from "./pragyaan.js";
import { roomsAdminRouter } from "./rooms.js";
import { bookingsAdminRouter } from "./bookings.js";
import { readingRoomAdminRouter } from "./readingRoom.js";
import { insightsAdminRouter } from "./insights.js";
import { auditAdminRouter } from "./audit.js";
import { cabfAdminRouter } from "./cabf.js";
import { paymentsAdminRouter } from "./payments.js";
import { icaiDirectoryAdminRouter } from "./icaiDirectory.js";
import {
  studentSuggestionsAdminRouter,
  studentSuggestionTopicsAdminRouter,
} from "./studentSuggestions.js";
import { jobCategoriesAdminRouter } from "./jobCategories.js";
import { jobSubscribersAdminRouter } from "./jobSubscribers.js";

export const adminRouter = Router();

// Never cache admin responses — attached BEFORE the auth middleware so
// 401 / 403 rejections also get the header (a cached "unauthorized" from
// before a role change would otherwise linger). Admin data changes on
// every write (approvals, user edits, event publishes) and must reflect
// the latest DB state on every read. Without this, Vercel's edge,
// browsers, and any intermediate CDN can hold onto stale bodies OR error
// responses (as happened when a broken vercel.json rewrite let 502s get
// cached for hours after the fix landed).
adminRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// Every admin endpoint requires (a) a valid session and (b) the admin role.
adminRouter.use(requireUser, requireAdmin);

// ─── Per-area role gates ─────────────────────────────────────────────────
// requireAdmin above only proves the caller holds SOME office-bearer role.
// Without these narrower gates any office bearer (committee chairman,
// accountant, …) could call admin-only endpoints directly by URL — e.g.
// grant themselves the `admin` role via POST /users/:id/roles. The sidebar
// hiding a link is not access control. Each gate mirrors the roles the
// AdminShell nav shows that section to. `requireRole` always lets `admin`
// through.
const BRANCH_LEADERS = ["branch_chairman", "branch_vice_chairman", "branch_secretary", "branch_manager"];
const TREASURER      = ["branch_treasurer"];
const ACCOUNTANT     = ["accountant"];

const adminOnly        = requireRole([]);
const treasurerOnly    = requireRole(TREASURER);
const financeDesk      = requireRole([...TREASURER, ...ACCOUNTANT]);
const financeOrLeaders = requireRole([...TREASURER, ...ACCOUNTANT, ...BRANCH_LEADERS]);
const treasurerOrLeaders = requireRole([...TREASURER, ...BRANCH_LEADERS]);
const leadersOnly      = requireRole(BRANCH_LEADERS);

type Mw = (req: Request, res: Response, next: NextFunction) => unknown;
/** Reads go through `readGate`, writes through `writeGate`. */
function split(readGate: Mw | null, writeGate: Mw): Mw {
  return (req, res, next) => {
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (isRead) return readGate ? readGate(req, res, next) : next();
    return writeGate(req, res, next);
  };
}

// Users: the plain list (GET /users) feeds the speaker / filler pickers on
// the Events and Checklist pages, so every office bearer may read it.
// Everything else — details, CSV export, edits, role grants — is admin-only.
adminRouter.use("/users", (req, res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path === "")) return next();
  return adminOnly(req as any, res, next);
});
adminRouter.use(["/icai-directory", "/grievance-routes", "/jobs", "/job-categories",
                 "/job-subscribers", "/notification-templates", "/audit-log", "/stats"], adminOnly as Mw);
// Site: content blocks are edited by branch leadership; settings are admin-only.
adminRouter.use("/site", (req, res, next) => {
  if (req.method === "GET") return next();
  if (req.path.startsWith("/settings")) return adminOnly(req as any, res, next);
  return leadersOnly(req as any, res, next);
});
// Finance.
adminRouter.use(["/refunds", "/iut-transfers", "/cabf"], treasurerOnly as Mw);
adminRouter.use(["/bills", "/payments"], financeDesk as Mw);
adminRouter.use(["/vendors", "/expense-categories"], split(financeOrLeaders as Mw, financeDesk as Mw));
adminRouter.use("/budgets", treasurerOrLeaders as Mw);
adminRouter.use(["/reports", "/exports"], financeOrLeaders as Mw);
adminRouter.use("/treasurer-analytics", treasurerOrLeaders as Mw);

adminRouter.use("/events", eventsAdminRouter);
// Nested speakers CRUD — mounted separately (not inside eventsAdminRouter)
// so the file stays focused. `mergeParams: true` on the sub-router preserves
// :eventId when Express strips the parent mount path.
adminRouter.use("/events/:eventId/speakers", eventSpeakersAdminRouter);
adminRouter.use("/registrations", registrationsAdminRouter);
adminRouter.use("/stats", statsAdminRouter);
adminRouter.use("/files", filesAdminRouter);
adminRouter.use("/users", usersAdminRouter);
adminRouter.use("/committees", committeesAdminRouter);
adminRouter.use("/site", siteAdminRouter);
adminRouter.use("/announcements", announcementsAdminRouter);
adminRouter.use("/jobs", jobsAdminRouter);
adminRouter.use("/notification-templates", notificationTemplatesAdminRouter);
adminRouter.use("/home", homeAdminRouter);
adminRouter.use("/refunds", refundsAdminRouter);
adminRouter.use("/bills", billsAdminRouter);
adminRouter.use("/iut-transfers", iutTransfersAdminRouter);
adminRouter.use("/mock-tests", mockTestsAdminRouter);
// Question bank + attempts under the same prefix — separate router so the
// nested resource files stay focused.
adminRouter.use("/", mockTestQuestionsAdminRouter);
adminRouter.use("/mentorship", mentorshipAdminRouter);
adminRouter.use("/articleship-matches", articleshipMatchesAdminRouter);
adminRouter.use("/scholarships", scholarshipsAdminRouter);
adminRouter.use("/scholarship-applications", scholarshipApplicationsAdminRouter);
adminRouter.use("/vendors", vendorsAdminRouter);
adminRouter.use("/expense-categories", expenseCategoriesAdminRouter);
adminRouter.use("/budgets", budgetsAdminRouter);
adminRouter.use("/treasurer-analytics", treasurerAnalyticsAdminRouter);
adminRouter.use("/exports", exportsAdminRouter);
adminRouter.use("/reports", reportsAdminRouter);
adminRouter.use("/approvals", approvalsAdminRouter);
adminRouter.use("/paper-presentations", paperPresentationsAdminRouter);
adminRouter.use("/gallery-albums", galleryAdminRouter);
adminRouter.use("/gallery-videos", galleryVideosAdminRouter);
adminRouter.use("/newsletters", newslettersAdminRouter);
adminRouter.use("/office-bearers", officeBearersAdminRouter);
adminRouter.use("/annual-reports", annualReportsAdminRouter);
adminRouter.use("/grievances", grievancesAdminRouter);
adminRouter.use("/grievance-routes", grievanceRoutesAdminRouter);
adminRouter.use("/resources", resourcesAdminRouter);
adminRouter.use("/pragyaan", pragyaanAdminRouter);
adminRouter.use("/rooms", roomsAdminRouter);
adminRouter.use("/bookings", bookingsAdminRouter);
adminRouter.use("/reading-room", readingRoomAdminRouter);
adminRouter.use("/insights", insightsAdminRouter);
adminRouter.use("/cabf", cabfAdminRouter);
adminRouter.use("/payments", paymentsAdminRouter);
adminRouter.use("/icai-directory", icaiDirectoryAdminRouter);
adminRouter.use("/student-suggestions", studentSuggestionsAdminRouter);
adminRouter.use("/student-suggestion-topics", studentSuggestionTopicsAdminRouter);
adminRouter.use("/job-categories", jobCategoriesAdminRouter);
adminRouter.use("/job-subscribers", jobSubscribersAdminRouter);
adminRouter.use("/audit-log", auditAdminRouter);
