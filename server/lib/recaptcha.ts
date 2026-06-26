// Server-side reCAPTCHA v3 verification.
//
// We use v3 (score-based, invisible) instead of v2 checkbox so submitters
// don't see "I am not a robot". v3 returns a score 0.0 .. 1.0 — Google
// recommends rejecting scores < 0.5 for low-stakes forms.
//
// Configuration:
//   RECAPTCHA_SECRET_KEY   — paired with the frontend site key. Get at
//                            https://www.google.com/recaptcha/admin
//   RECAPTCHA_MIN_SCORE    — minimum acceptable score (default 0.5)
//
// If RECAPTCHA_SECRET_KEY is unset, verifyRecaptcha() returns { ok: true,
// skipped: true } so dev environments keep working without keys. In prod
// (NODE_ENV=production) a missing key fails closed.

export type RecaptchaResult =
  | { ok: true; skipped?: boolean; score?: number; action?: string }
  | { ok: false; reason: string };

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

export async function verifyRecaptcha(
  token: string | undefined,
  expectedAction: string,
  remoteIp?: string,
): Promise<RecaptchaResult> {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  const minScore = Number(process.env.RECAPTCHA_MIN_SCORE ?? "0.5");

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "recaptcha_not_configured" };
    }
    return { ok: true, skipped: true };
  }

  if (!token || typeof token !== "string") {
    return { ok: false, reason: "missing_token" };
  }

  const params = new URLSearchParams({ secret, response: token });
  if (remoteIp) params.set("remoteip", remoteIp);

  try {
    const r = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const j = await r.json() as {
      success: boolean;
      score?: number;
      action?: string;
      "error-codes"?: string[];
    };
    if (!j.success) {
      return { ok: false, reason: (j["error-codes"] ?? ["verify_failed"]).join(",") };
    }
    if (j.action && j.action !== expectedAction) {
      return { ok: false, reason: `action_mismatch:${j.action}` };
    }
    if (typeof j.score === "number" && j.score < minScore) {
      return { ok: false, reason: `low_score:${j.score}` };
    }
    return { ok: true, score: j.score, action: j.action };
  } catch (err) {
    // Network blip — fail open in dev, closed in prod.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[recaptcha] verify call failed, allowing in dev", err);
      return { ok: true, skipped: true };
    }
    return { ok: false, reason: "verify_request_failed" };
  }
}
