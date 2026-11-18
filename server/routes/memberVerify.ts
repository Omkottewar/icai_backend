// Event registration by membership number (MRN), members only.
//
// Not logged in:
//   POST /api/member-verify/lookup     { mrn }
//        MRN known → email a 6-digit code to the email we hold, return masked
//        details { known: true, otp_id, masked }. Unknown → { known: false }.
//   POST /api/member-verify/start-new  { mrn, name, email, phone }
//        MRN unknown → email a code to the email the member typed.
//   POST /api/member-verify/verify     { otp_id, code }
//        Correct code → { guest_token, profile }. The guest token goes in the
//        X-Guest-Token header of POST /api/events/:slug/register.
//   PATCH /api/member-verify/profile   { name?, phone? }   (X-Guest-Token)
//
// Logged in (member account with no MRN yet):
//   POST /api/member-verify/link/start  { mrn }
//   POST /api/member-verify/link/verify { otp_id, code }
//        Saves the MRN on the account; if a no-login record already holds
//        that MRN, its registrations and payments move to the account.

import { Router, type Response } from "express";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { db } from "../../db/client.js";
import { users, memberProfiles, icaiMemberMaster, memberOtps, oauthLinks, eventRegistrations, payments } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sendEmail } from "../lib/email.js";
import { signGuestToken, verifyGuestToken } from "../lib/memberGuest.js";

export const memberVerifyRouter = Router();

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_MRN_PER_HOUR = 5;

const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." },
});

// The table is also created by migration 0107; doing it here means the
// feature works even if that migration hasn't been run yet.
let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= (async () => {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS "member_otps" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "purpose" text NOT NULL, "mrn" text NOT NULL, "email" text NOT NULL,
        "code_hash" text NOT NULL,
        "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
        "linking_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
        "pending" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "attempts" integer NOT NULL DEFAULT 0,
        "expires_at" timestamptz NOT NULL, "consumed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "idx_member_otps_mrn_created" ON "member_otps" ("mrn", "created_at");
    `));
  })().catch((e) => { tableReady = null; throw e; });
  return tableReady;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// MRNs are numeric (6 digits; some older ones are shorter or carry a
// leading zero). Compare without leading zeros.
function normaliseMrn(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 4 || digits.length > 8) throw new ApiError(400, "Please enter a valid membership number (MRN).");
  return digits;
}
const mrnMatch = (col: any, mrn: string) => sql`ltrim(${col}, '0') = ltrim(${mrn}, '0')`;

function maskEmail(e: string): string {
  const [local, domain] = e.split("@");
  if (!domain) return "***";
  return `${local.slice(0, Math.min(2, local.length))}${"*".repeat(Math.max(3, local.length - 2))}@${domain}`;
}
function maskName(n: string): string {
  return n.trim().split(/\s+/).map((w) => w.length <= 1 ? w : `${w[0]}${"*".repeat(w.length - 1)}`).join(" ");
}
function maskPhone(p: string | null | undefined): string | null {
  const d = String(p ?? "").replace(/\D/g, "");
  if (d.length < 6) return null;
  return `${d.slice(0, 2)}${"*".repeat(d.length - 5)}${d.slice(-3)}`;
}
function validEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function hashCode(otpId: string, code: string): string {
  return createHash("sha256").update(`${otpId}:${code}:${process.env.JWT_SECRET ?? ""}`).digest("hex");
}

// Find who holds an MRN today: a portal user, the ICAI directory, or nobody.
async function findMrn(mrn: string) {
  const [owner] = await db.select({
    user_id: users.id, name: users.name, email: users.email, phone: users.phone,
    status: users.status, mrn: memberProfiles.mrn,
  })
    .from(memberProfiles)
    .innerJoin(users, eq(users.id, memberProfiles.user_id))
    .where(and(mrnMatch(memberProfiles.mrn, mrn), isNull(memberProfiles.deleted_at), isNull(users.deleted_at)))
    .limit(1);
  if (owner) return { kind: "user" as const, ...owner };

  const [dir] = await db.select({ mrn: icaiMemberMaster.mrn, name: icaiMemberMaster.name, email: icaiMemberMaster.email, phone: icaiMemberMaster.phone })
    .from(icaiMemberMaster).where(mrnMatch(icaiMemberMaster.mrn, mrn)).limit(1);
  if (dir?.email) return { kind: "directory" as const, ...dir, email: dir.email };
  return null;
}

async function issueCode(args: {
  purpose: "existing" | "directory" | "new" | "link" | "nonmember";
  mrn: string; email: string; name: string;
  user_id?: string | null; linking_user_id?: string | null;
  pending?: Record<string, unknown>;
}): Promise<string> {
  await ensureTable();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(memberOtps)
    .where(and(eq(memberOtps.mrn, args.mrn), gte(memberOtps.created_at, since)));
  if (n >= MAX_CODES_PER_MRN_PER_HOUR) {
    throw new ApiError(429, "Too many codes were sent for this membership number. Please try again in an hour.");
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const [row] = await db.insert(memberOtps).values({
    purpose: args.purpose, mrn: args.mrn, email: args.email.toLowerCase(), code_hash: "pending",
    user_id: args.user_id ?? null, linking_user_id: args.linking_user_id ?? null,
    pending: args.pending ?? {}, expires_at: new Date(Date.now() + OTP_TTL_MS),
  }).returning({ id: memberOtps.id });
  await db.update(memberOtps).set({ code_hash: hashCode(row.id, code) }).where(eq(memberOtps.id, row.id));

  const sent = await sendEmail({
    to: args.email,
    subject: `${code} is your ICAI Nagpur Branch verification code`,
    body: `Dear ${args.name || "Member"},\n\nYour verification code is ${code}. It is valid for 10 minutes.\n\nIf you did not request this, you can ignore this email.\n\nICAI Nagpur Branch`,
    html: `<p>Dear ${escapeHtml(args.name || "Member")},</p><p>Your verification code is</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>It is valid for 10 minutes. If you did not request this, you can ignore this email.</p><p>ICAI Nagpur Branch</p>`,
  });
  if (sent.status === "failed") throw new ApiError(502, "Could not send the verification email. Please try again.");
  return row.id;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Check a code; returns the OTP row on success (and marks it used).
async function consumeCode(otpId: string, code: string) {
  await ensureTable();
  if (!/^[0-9a-f-]{36}$/i.test(otpId)) throw new ApiError(400, "Invalid or expired code. Please request a new one.");
  const [otp] = await db.select().from(memberOtps).where(eq(memberOtps.id, otpId)).limit(1);
  if (!otp || otp.consumed_at || otp.expires_at < new Date() || otp.attempts >= MAX_ATTEMPTS) {
    throw new ApiError(400, "This code has expired. Please request a new one.");
  }
  const a = Buffer.from(hashCode(otp.id, code.trim()));
  const b = Buffer.from(otp.code_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await db.update(memberOtps).set({ attempts: sql`${memberOtps.attempts} + 1` }).where(eq(memberOtps.id, otp.id));
    const left = MAX_ATTEMPTS - otp.attempts - 1;
    throw new ApiError(400, left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong attempts. Please request a new code.");
  }
  const [used] = await db.update(memberOtps).set({ consumed_at: new Date() })
    .where(and(eq(memberOtps.id, otp.id), isNull(memberOtps.consumed_at))).returning({ id: memberOtps.id });
  if (!used) throw new ApiError(400, "This code was already used. Please request a new one.");
  return otp;
}

function profileOf(u: { name: string; email: string; phone: string | null }, mrn: string) {
  return { name: u.name, email: u.email, phone: u.phone ?? "", mrn, is_member: Boolean(mrn) };
}

// Create (or reuse by email) the portal user that holds this MRN.
// inDirectory=false marks an MRN we couldn't find in the imported ICAI
// member list (users.signup_mrn_in_directory) — admins check these and
// cancel the registration if the MRN turns out to be wrong.
async function ensureMemberUser(mrn: string, p: { name: string; email: string; phone?: string | null }, inDirectory: boolean) {
  return db.transaction(async (tx) => {
    const email = p.email.toLowerCase();
    let [user] = await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (user?.deleted_at) throw new ApiError(409, "This email belongs to a closed account. Please contact the branch office.");
    if (user) {
      const [mp] = await tx.select({ mrn: memberProfiles.mrn }).from(memberProfiles).where(eq(memberProfiles.user_id, user.id)).limit(1);
      if (mp && mp.mrn.replace(/^0+/, "") !== mrn.replace(/^0+/, "")) {
        throw new ApiError(409, "This email is already linked to a different membership number. Please contact the branch office.");
      }
      if (!mp) {
        await tx.insert(memberProfiles).values({ user_id: user.id, mrn });
        [user] = await tx.update(users).set({ signup_mrn: mrn, signup_mrn_in_directory: inDirectory, updated_at: new Date() })
          .where(eq(users.id, user.id)).returning();
      }
      if (p.phone && !user.phone) {
        [user] = await tx.update(users).set({ phone: p.phone, updated_at: new Date() }).where(eq(users.id, user.id)).returning();
      }
      return user;
    }
    [user] = await tx.insert(users).values({
      name: p.name, email, phone: p.phone || null,
      primary_role: "member", status: "active",
      signup_mrn: mrn, signup_mrn_in_directory: inDirectory,
    }).returning();
    await tx.insert(memberProfiles).values({ user_id: user.id, mrn });
    return user;
  }).catch((e) => {
    if (String((e as any)?.code) === "23505") throw new ApiError(409, "This membership number was just registered. Please start again.");
    throw e;
  });
}

// ─── Not logged in ────────────────────────────────────────────────────────

memberVerifyRouter.post("/lookup", lookupLimiter, async (req: AuthedRequest, res: Response, next) => {
  try {
    const mrn = normaliseMrn(req.body?.mrn);
    const found = await findMrn(mrn);
    if (!found) return res.json({ known: false, mrn });

    if (found.kind === "user" && (found.status === "suspended" || found.status === "inactive")) {
      throw new ApiError(403, "This membership number is not active on the portal. Please contact the branch office.");
    }

    const otp_id = await issueCode({
      purpose: found.kind === "user" ? "existing" : "directory",
      mrn, email: found.email, name: found.name,
      user_id: found.kind === "user" ? found.user_id : null,
      pending: found.kind === "directory" ? { name: found.name, email: found.email, phone: found.phone ?? "" } : {},
    });
    res.json({
      known: true, mrn, otp_id,
      masked: { name: maskName(found.name), email: maskEmail(found.email), phone: maskPhone(found.phone) },
    });
  } catch (err) { handleApiError(err, res, next); }
});

memberVerifyRouter.post("/start-new", lookupLimiter, async (req: AuthedRequest, res: Response, next) => {
  try {
    const mrn = normaliseMrn(req.body?.mrn);
    const name = need(trim(req.body?.name), "Name").slice(0, 120);
    const email = need(trim(req.body?.email), "Email").toLowerCase();
    const phone = need(trim(req.body?.phone), "Phone");
    if (!validEmail(email)) throw new ApiError(400, "Please enter a valid email address.");
    if (!/^\+?\d[\d\s-]{7,}$/.test(phone)) throw new ApiError(400, "Please enter a valid phone number.");
    if (await findMrn(mrn)) throw new ApiError(409, "We already have this membership number. Please go back and enter it again to get a code.");

    const otp_id = await issueCode({ purpose: "new", mrn, email, name, pending: { name, email, phone } });
    res.json({ otp_id, masked: { email: maskEmail(email) } });
  } catch (err) { handleApiError(err, res, next); }
});

memberVerifyRouter.post("/verify", lookupLimiter, async (req: AuthedRequest, res: Response, next) => {
  try {
    const otp = await consumeCode(need(trim(req.body?.otp_id), "Code ID"), need(trim(req.body?.code), "Code"));
    if (otp.purpose === "link") throw new ApiError(400, "Invalid code.");

    if (otp.purpose === "nonmember") {
      const p = otp.pending as { name?: string; email?: string; phone?: string };
      const u = await ensureNonMemberUser({ name: p.name || "Guest", email: p.email || otp.email, phone: p.phone });
      return res.json({ guest_token: signGuestToken(u.id, ""), profile: profileOf(u, "") });
    }

    let user;
    if (otp.purpose === "existing" && otp.user_id) {
      [user] = await db.select().from(users).where(and(eq(users.id, otp.user_id), isNull(users.deleted_at))).limit(1);
      if (!user) throw new ApiError(404, "Member record not found. Please start again.");
    } else {
      const p = otp.pending as { name?: string; email?: string; phone?: string };
      user = await ensureMemberUser(otp.mrn, { name: p.name || "Member", email: p.email || otp.email, phone: p.phone }, otp.purpose === "directory");
    }

    const [mp] = await db.select({ mrn: memberProfiles.mrn }).from(memberProfiles).where(eq(memberProfiles.user_id, user.id)).limit(1);
    const mrn = mp?.mrn ?? otp.mrn;
    res.json({ guest_token: signGuestToken(user.id, mrn), profile: profileOf(user, mrn) });
  } catch (err) { handleApiError(err, res, next); }
});

memberVerifyRouter.patch("/profile", async (req: AuthedRequest, res: Response, next) => {
  try {
    const claims = verifyGuestToken(String(req.headers["x-guest-token"] ?? ""));
    if (!claims) throw new ApiError(401, "Your verification has expired. Please verify again.");
    const name = trim(req.body?.name);
    const phone = trim(req.body?.phone);
    if (phone && !/^\+?\d[\d\s-]{7,}$/.test(phone)) throw new ApiError(400, "Please enter a valid phone number.");
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (name) patch.name = name.slice(0, 120);
    if (phone) patch.phone = phone;
    const [u] = await db.update(users).set(patch).where(and(eq(users.id, claims.userId), isNull(users.deleted_at))).returning();
    if (!u) throw new ApiError(404, "Member record not found.");
    res.json({ profile: profileOf(u, claims.mrn) });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Non-members (no ICAI membership number) ──────────────────────────────

memberVerifyRouter.post("/non-member/start", lookupLimiter, async (req: AuthedRequest, res: Response, next) => {
  try {
    const name = need(trim(req.body?.name), "Name").slice(0, 120);
    const email = need(trim(req.body?.email), "Email").toLowerCase();
    const phone = need(trim(req.body?.phone), "Phone");
    if (!validEmail(email)) throw new ApiError(400, "Please enter a valid email address.");
    if (!/^\+?\d[\d\s-]{7,}$/.test(phone)) throw new ApiError(400, "Please enter a valid phone number.");

    const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (existing) {
      const [mp] = await db.select({ mrn: memberProfiles.mrn }).from(memberProfiles)
        .where(and(eq(memberProfiles.user_id, existing.id), isNull(memberProfiles.deleted_at))).limit(1);
      if (mp) throw new ApiError(409, "This email belongs to an ICAI member. Please go back and choose \"ICAI member\".");
    }

    const otp_id = await issueCode({ purpose: "nonmember", mrn: `nm:${email}`, email, name, pending: { name, email, phone } });
    res.json({ otp_id, masked: { email: maskEmail(email) } });
  } catch (err) { handleApiError(err, res, next); }
});

// Create (or reuse by email) a non-member account (role 'guest').
async function ensureNonMemberUser(p: { name: string; email: string; phone?: string | null }) {
  const email = p.email.toLowerCase();
  const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (existing) {
    if (existing.deleted_at) throw new ApiError(409, "This email belongs to a closed account. Please contact the branch office.");
    const [mp] = await db.select({ mrn: memberProfiles.mrn }).from(memberProfiles)
      .where(and(eq(memberProfiles.user_id, existing.id), isNull(memberProfiles.deleted_at))).limit(1);
    if (mp) throw new ApiError(409, "This email belongs to an ICAI member. Please register as a member.");
    if (p.phone && p.phone !== existing.phone) {
      const [u] = await db.update(users).set({ phone: p.phone, updated_at: new Date() }).where(eq(users.id, existing.id)).returning();
      return u;
    }
    return existing;
  }
  const [created] = await db.insert(users).values({
    name: p.name, email, phone: p.phone || null, primary_role: "guest", status: "active",
  }).returning();
  return created;
}

// ─── Logged in: link an MRN to the account ────────────────────────────────

memberVerifyRouter.post("/link/start", lookupLimiter, requireUser, async (req: AuthedRequest, res: Response, next) => {
  try {
    const me = req.user!;
    const [already] = await db.select({ mrn: memberProfiles.mrn }).from(memberProfiles).where(eq(memberProfiles.user_id, me.id)).limit(1);
    if (already) return res.json({ linked: true, mrn: already.mrn });

    const mrn = normaliseMrn(req.body?.mrn);
    const found = await findMrn(mrn);

    if (found?.kind === "user") {
      const [hasLogin] = await db.select({ id: oauthLinks.id }).from(oauthLinks).where(eq(oauthLinks.user_id, found.user_id)).limit(1);
      const [owner] = await db.select({ last_login_at: users.last_login_at }).from(users).where(eq(users.id, found.user_id)).limit(1);
      if (hasLogin || owner?.last_login_at) throw new ApiError(409, "This membership number is linked to another account. Please contact the branch office.");
    }
    const ownerEmail = found?.email?.toLowerCase();
    if (!found || ownerEmail === me.email.toLowerCase()) {
      await attachMrn(me.id, mrn, found?.kind === "user" ? found.user_id : null);
      return res.json({ linked: true, mrn });
    }

    const otp_id = await issueCode({
      purpose: "link", mrn, email: found.email, name: found.name,
      user_id: found.kind === "user" ? found.user_id : null, linking_user_id: me.id,
    });
    res.json({ linked: false, otp_id, masked: { email: maskEmail(found.email) } });
  } catch (err) { handleApiError(err, res, next); }
});

memberVerifyRouter.post("/link/verify", lookupLimiter, requireUser, async (req: AuthedRequest, res: Response, next) => {
  try {
    const otp = await consumeCode(need(trim(req.body?.otp_id), "Code ID"), need(trim(req.body?.code), "Code"));
    if (otp.purpose !== "link" || otp.linking_user_id !== req.user!.id) throw new ApiError(400, "Invalid code.");
    await attachMrn(req.user!.id, otp.mrn, otp.user_id);
    res.json({ linked: true, mrn: otp.mrn });
  } catch (err) { handleApiError(err, res, next); }
});

// Give `userId` the MRN. If a no-login record (`fromUserId`) held it, move
// its registrations and payments over and close that record.
async function attachMrn(userId: string, mrn: string, fromUserId: string | null) {
  await db.transaction(async (tx) => {
    if (fromUserId && fromUserId !== userId) {
      await tx.execute(sql`
        UPDATE event_registrations r SET user_id = ${userId}
        WHERE r.user_id = ${fromUserId}
          AND NOT EXISTS (SELECT 1 FROM event_registrations x
                          WHERE x.user_id = ${userId} AND x.event_id = r.event_id AND x.deleted_at IS NULL)`);
      await tx.update(eventRegistrations).set({ booked_by_user_id: userId }).where(eq(eventRegistrations.booked_by_user_id, fromUserId));
      await tx.update(payments).set({ payer_user_id: userId, updated_at: new Date() }).where(eq(payments.payer_user_id, fromUserId));
      await tx.delete(memberProfiles).where(eq(memberProfiles.user_id, fromUserId));
      await tx.update(users).set({ deleted_at: new Date(), updated_at: new Date() }).where(eq(users.id, fromUserId));
    }
    await tx.insert(memberProfiles).values({ user_id: userId, mrn }).onConflictDoNothing();
  });
}
