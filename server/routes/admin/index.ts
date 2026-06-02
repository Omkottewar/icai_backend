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
