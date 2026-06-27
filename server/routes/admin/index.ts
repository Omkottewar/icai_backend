import { Router } from "express";
import { requireUser } from "../../middleware/requireUser.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { eventsAdminRouter } from "./events.js";
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
import { exportsAdminRouter } from "./exports.js";
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
import { cpeAdminRouter } from "./cpe.js";
import { roomsAdminRouter } from "./rooms.js";
import { bookingsAdminRouter } from "./bookings.js";
import { cabfAdminRouter } from "./cabf.js";
import { paymentsAdminRouter } from "./payments.js";
import { icaiDirectoryAdminRouter } from "./icaiDirectory.js";
import {
  studentSuggestionsAdminRouter,
  studentSuggestionTopicsAdminRouter,
} from "./studentSuggestions.js";

export const adminRouter = Router();

// Every admin endpoint requires (a) a valid session and (b) the admin role.
adminRouter.use(requireUser, requireAdmin);

adminRouter.use("/events", eventsAdminRouter);
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
adminRouter.use("/exports", exportsAdminRouter);
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
adminRouter.use("/cpe", cpeAdminRouter);
adminRouter.use("/rooms", roomsAdminRouter);
adminRouter.use("/bookings", bookingsAdminRouter);
adminRouter.use("/cabf", cabfAdminRouter);
adminRouter.use("/payments", paymentsAdminRouter);
adminRouter.use("/icai-directory", icaiDirectoryAdminRouter);
adminRouter.use("/student-suggestions", studentSuggestionsAdminRouter);
adminRouter.use("/student-suggestion-topics", studentSuggestionTopicsAdminRouter);
