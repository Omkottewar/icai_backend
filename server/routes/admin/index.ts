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
import { mentorshipAdminRouter } from "./mentorship.js";
import { articleshipMatchesAdminRouter } from "./articleshipMatches.js";
import { exportsAdminRouter } from "./exports.js";
import { approvalsAdminRouter } from "./approvals.js";

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
adminRouter.use("/mentorship", mentorshipAdminRouter);
adminRouter.use("/articleship-matches", articleshipMatchesAdminRouter);
adminRouter.use("/exports", exportsAdminRouter);
adminRouter.use("/approvals", approvalsAdminRouter);
