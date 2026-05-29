import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  users,
  memberProfiles,
  studentProfiles,
  employers,
  employerUsers,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";

export const onboardingRouter = Router();

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const need = (val: string, label: string) => {
  if (!val) throw new ApiError(400, `${label} is required`);
  return val;
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const PHONE_RE = /^[6-9]\d{9}$/;

function validateCommon(body: any) {
  const name    = need(trim(body.name),  "Name");
  const phone   = need(trim(body.phone), "Phone");
  const consent = body.consent === true;
  if (!PHONE_RE.test(phone)) throw new ApiError(400, "Enter a valid 10-digit Indian mobile number");
  if (!consent) throw new ApiError(400, "You must accept the Web-Media Policy to continue");
  return { name, phone };
}

// â”€â”€â”€ POST /api/onboarding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Single endpoint; branches by the user's primary_role.
// Idempotent: every role check-and-updates an existing row rather than
// always inserting, so double-submission can't create duplicates.
onboardingRouter.post("/", sameOrigin, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const role = user.primary_role;

    const { name, phone } = validateCommon(req.body);

    await db.transaction(async (tx) => {
      await tx.update(users).set({ name, phone, updated_at: new Date() }).where(eq(users.id, user.id));

      if (role === "member") {
        const mrn          = need(trim(req.body.mrn), "Membership Registration Number (MRN)");
        const isFca        = req.body.is_fca === true;
        const isPractising = req.body.is_practising === true;
        const gender       = ["male", "female", "other", "unspecified"].includes(req.body.gender)
          ? req.body.gender : "unspecified";
        const city         = trim(req.body.city) || null;
        const pincode      = trim(req.body.pincode) || null;

        const existing = await tx
          .select()
          .from(memberProfiles)
          .where(eq(memberProfiles.user_id, user.id))
          .limit(1);

        if (existing[0]) {
          await tx.update(memberProfiles).set({
            mrn, is_fca: isFca, is_practising: isPractising, gender, city, pincode,
          }).where(eq(memberProfiles.user_id, user.id));
        } else {
          await tx.insert(memberProfiles).values({
            user_id: user.id, mrn, is_fca: isFca, is_practising: isPractising, gender, city, pincode,
          });
        }
      }

      else if (role === "student") {
        const srn               = need(trim(req.body.srn), "Student Registration Number (SRN)");
        const level             = ["foundation", "intermediate", "final"].includes(req.body.level)
          ? req.body.level : null;
        if (!level) throw new ApiError(400, "Please choose your CA level");
        const articleshipStatus = trim(req.body.articleship_status) || "not_started";

        const existing = await tx
          .select()
          .from(studentProfiles)
          .where(eq(studentProfiles.user_id, user.id))
          .limit(1);

        if (existing[0]) {
          await tx.update(studentProfiles).set({
            srn, level, articleship_status: articleshipStatus,
          }).where(eq(studentProfiles.user_id, user.id));
        } else {
          await tx.insert(studentProfiles).values({
            user_id: user.id, srn, level, articleship_status: articleshipStatus,
          });
        }
      }

      else if (role === "employer") {
        const companyName = need(trim(req.body.company_name), "Company name");
        const gstin       = trim(req.body.gstin).toUpperCase();
        const pan         = trim(req.body.pan).toUpperCase();
        const website     = trim(req.body.website) || null;
        const address     = trim(req.body.address) || null;
        if (gstin && !GSTIN_RE.test(gstin)) throw new ApiError(400, "GSTIN format looks wrong");
        if (pan && !PAN_RE.test(pan)) throw new ApiError(400, "PAN format looks wrong");

        // Idempotency: if this user is already an owner of an employer row,
        // update that row instead of creating a new one. Otherwise create a
        // fresh employer and link the user as the owner.
        const existingLink = await tx
          .select({ employer_id: employerUsers.employer_id })
          .from(employerUsers)
          .where(eq(employerUsers.user_id, user.id))
          .limit(1);

        if (existingLink[0]) {
          await tx.update(employers).set({
            company_name: companyName,
            gstin: gstin || null,
            pan: pan || null,
            website,
            address,
            updated_at: new Date(),
          }).where(eq(employers.id, existingLink[0].employer_id));
        } else {
          const [emp] = await tx.insert(employers).values({
            company_name: companyName, gstin: gstin || null, pan: pan || null, website, address,
          }).returning();
          await tx.insert(employerUsers).values({
            employer_id: emp.id, user_id: user.id, role: "owner",
          });
        }
      }

      else {
        throw new ApiError(400, `Role '${role}' cannot self-onboard`);
      }
    });

    res.json({ ok: true, redirect: "/dashboard" });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
