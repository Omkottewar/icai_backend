// SabPaisa client — builds the init payload, verifies, refunds, and parses
// the callback / webhook payload.
//
// Everything here is pure (crypto + fetch + env-driven config). No DB
// access and no Express request/response types — the route layer owns
// those. Keeps the module easy to unit-test and reuse from the (future)
// job posting payment surface.

import { sabpaisaConfig } from "./config.js";
import { encrypt, decrypt } from "./crypto.js";
import {
  type SabPaisaInitInput,
  type SabPaisaInitPayload,
  type SabPaisaInitRedirect,
  type SabPaisaCallbackPayload,
  type SabPaisaVerifyResponse,
  type SabPaisaOutcome,
  mapSabPaisaStatus,
} from "./types.js";

// ─── Init ─────────────────────────────────────────────────────────────────
// Builds the AES-encrypted payload the browser auto-POSTs to SabPaisa's
// hosted checkout page. We don't call SabPaisa server-to-server here —
// init is strictly a form POST from the user's browser so SabPaisa's
// fraud-prevention sees the real client fingerprint.

export function buildInitRedirect(input: SabPaisaInitInput): SabPaisaInitRedirect {
  const cfg = sabpaisaConfig();

  const payload: SabPaisaInitPayload = {
    clientCode:        cfg.clientCode,
    transUserName:     cfg.username,
    transUserPassword: cfg.password,
    clientTxnId:       input.clientTxnId,
    amount:            input.amountRupees,
    payerName:         truncate(input.payerName,  50) || "Member",
    payerEmail:        truncate(input.payerEmail, 60) || "nagpur@icai.org",
    payerMobile:       truncate(input.payerMobile, 15) || "0000000000",
    payerAddress:      truncate(input.payerAddress ?? "ICAI Nagpur Branch", 100),
    udf1:              input.udf1 ?? "",
    udf2:              input.udf2 ?? "",
    udf3:              input.udf3 ?? "",
    udf4:              "",
    udf5:              "",
    udf6:              "",
    udf7:              "",
    udf8:              "",
    udf9:              "",
    udf10:             "",
    udf11:             "",
    udf12:             "",
    udf13:             "",
    udf14:             "",
    udf15:             "",
    udf16:             "",
    udf17:             "",
    udf18:             "",
    udf19:             "",
    udf20:             "",
    channelId:         input.channelId ?? "W",
    callbackUrl:       cfg.returnUrl,
    mcc:               "8220",     // ICAI SIC/MCC — education / professional membership
    currencyCode:      "INR",
  };

  // SabPaisa's PHP7+ init scheme embeds a fresh random IV in each encData,
  // delimited by `:` — see crypto.ts for the wire format. The AUTH_IV from
  // credentials is NOT used here; it's only a fallback on the decrypt path
  // for legacy response payloads.
  const encData = encrypt(JSON.stringify(payload), cfg.authKey);

  return {
    action:      cfg.initUrl,
    clientCode:  cfg.clientCode,
    clientTxnId: input.clientTxnId,
    encData,
  };
}

// ─── Return callback parser ───────────────────────────────────────────────
// SabPaisa POSTs an `encResponse` field (name may be `encResponse`,
// `encData`, or `enc` depending on their version — we accept any). The
// decrypted payload is either query-string-style ("a=1&b=2") or JSON.
// Both parse routes are handled; whichever shape SabPaisa sends.

export function parseCallbackEncData(encResponse: string): SabPaisaCallbackPayload {
  const cfg = sabpaisaConfig();
  const plain = decrypt(encResponse, cfg.authKey, cfg.authIv).trim();
  return parsePayloadString(plain);
}

function parsePayloadString(plain: string): SabPaisaCallbackPayload {
  // Try JSON first (SabPaisa's newer PHP7+ scheme returns JSON).
  if (plain.startsWith("{")) {
    try {
      const obj = JSON.parse(plain);
      if (obj && typeof obj === "object") return obj as SabPaisaCallbackPayload;
    } catch { /* fall through to query-string parse */ }
  }
  // Query-string style ("clientCode=NBW&amount=100.00&...") — SabPaisa's
  // older scheme uses this shape. URLSearchParams normalises decoding.
  const out: SabPaisaCallbackPayload = {};
  for (const [k, v] of new URLSearchParams(plain)) {
    out[k] = v;
  }
  return out;
}

// ─── Double verification ──────────────────────────────────────────────────
// Server-to-server status check. We call this before trusting a success
// callback — SabPaisa documents say the callback can be spoofed by anyone
// who knows the return URL + a plausible payload, so an authoritative
// status read is a strict pre-approval.
//
// Returns the normalised outcome plus the raw response for storage.

export async function verifyPayment(clientTxnId: string): Promise<{
  outcome: SabPaisaOutcome;
  response: SabPaisaVerifyResponse;
}> {
  const cfg = sabpaisaConfig();

  // SabPaisa's verify API accepts: { clientCode, transUserName,
  // transUserPassword, clientTxnId }. Same credential block as init.
  const body = {
    clientCode:        cfg.clientCode,
    transUserName:     cfg.username,
    transUserPassword: cfg.password,
    clientTxnId,
  };

  const res = await fetch(cfg.verifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`SabPaisa verify HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const parsed = await res.json().catch(() => ({})) as any;

  // SabPaisa wraps the response in a `data` or `response` envelope on
  // different endpoints. Normalise so callers always see the flat payload.
  const payload: SabPaisaVerifyResponse = parsed?.data ?? parsed?.response ?? parsed;
  const outcome = mapSabPaisaStatus(payload?.status);

  return { outcome, response: payload };
}

// ─── Refund ───────────────────────────────────────────────────────────────
// Server-to-server refund call. Returns SabPaisa's own refund id so the
// treasurer dashboard can show it. Caller must have already flipped the
// payment_refunds row to 'approved' (treasurer-approved) before calling —
// this fn only executes the external side-effect.

export interface SabPaisaRefundInput {
  clientTxnId:   string;     // original payment's clientTxnId
  sabpaisaTxnId: string;     // original payment's SabPaisa id
  amountRupees:  string;     // partial refunds supported
  refundReason:  string;
}

export async function refundPayment(input: SabPaisaRefundInput): Promise<{
  outcome: SabPaisaOutcome;
  refundId: string | null;
  response: Record<string, unknown>;
}> {
  const cfg = sabpaisaConfig();

  const body = {
    clientCode:        cfg.clientCode,
    transUserName:     cfg.username,
    transUserPassword: cfg.password,
    clientTxnId:       input.clientTxnId,
    sabpaisaTxnId:     input.sabpaisaTxnId,
    refundAmount:      input.amountRupees,
    refundReason:      input.refundReason,
  };

  const res = await fetch(cfg.refundUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`SabPaisa refund HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const parsed = await res.json().catch(() => ({})) as any;
  const payload = parsed?.data ?? parsed?.response ?? parsed;
  const outcome = mapSabPaisaStatus(payload?.status);
  const refundId = payload?.refundId ?? payload?.refundTxnId ?? null;

  return { outcome, refundId, response: payload };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function truncate(v: string | null | undefined, max: number): string {
  const s = (v ?? "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Converts paise (our stored unit) to the rupees-with-two-decimals string
// SabPaisa expects on the wire. 10000 paise → "100.00".
export function paiseToRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}
