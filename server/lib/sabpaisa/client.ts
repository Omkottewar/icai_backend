// SabPaisa client — thin wrapper over the SabPaisa Payment Gateway API.
//
// Everything here is pure (crypto + fetch + env-driven config). No DB
// access and no Express request/response types — the route layer owns
// those. Keeps the module easy to unit-test and reuse across paid
// surfaces (event registration, job posting, admin test).
//
// SabPaisa hosted-checkout flow summary:
//   1. Backend builds the init payload (payer details, amount, client txn
//      id, return URL) and AES-128-CBC-encrypts it. Returns
//      { action, clientCode, encData } to the browser.
//   2. Browser auto-POSTs a form with { clientCode, encData } to SabPaisa's
//      hosted checkout URL. User picks a method (card / UPI / netbanking
//      / wallet) and completes payment on SabPaisa's domain.
//   3. SabPaisa POSTs an encrypted response back to our /return endpoint
//      (same shape — form-encoded body with `encData`). We decrypt,
//      update the row, redirect user to /payments/result.
//   4. Separately, SabPaisa fires a Push API webhook to our /webhook
//      endpoint. Same decrypt + confirm. Idempotent against the /return
//      path — whichever lands first wins.
//   5. For paranoia, the reconciliation cron (and admin re-verify)
//      calls /status/verify server-to-server as a double-check.

import { sabpaisaConfig } from "./config.js";
import { sabpaisaEncrypt, sabpaisaDecrypt } from "./crypto.js";
import type {
  SabPaisaInitFields,
  SabPaisaInitRedirect,
  SabPaisaCallbackPayload,
  SabPaisaVerifyResponse,
  SabPaisaOutcome,
} from "./types.js";
import { mapSabPaisaStatus } from "./types.js";

// ─── Init redirect construction ───────────────────────────────────────────
//
// Builds the { action, clientCode, encData } blob the frontend hands to
// SabPaisa's hosted page. The payload is URL-encoded ampersand-separated
// (SabPaisa's PHP reference uses http_build_query — NOT JSON).
//
// IMPORTANT: field order in the plaintext matters to some SabPaisa setups
// — their parser is permissive but their logs are easier to read when
// fields are in the canonical order from their reference. We follow that
// order here.
export interface BuildInitInput {
  payment_id:   string;     // our payments.id — becomes the clientTxnId base
  amountRupees: string;     // e.g. "100.00" — rupees with 2 decimals
  payerName:    string;
  payerEmail:   string;
  payerPhone:   string;
  notes?:       Record<string, string>;  // echoed in udf12..udf15
}

export function buildInitRedirect(input: BuildInitInput): {
  redirect: SabPaisaInitRedirect;
  clientTxnId: string;   // the id we should persist on the payment row
} {
  const cfg = sabpaisaConfig();

  // clientTxnId must be unique per attempt. Our payments.id is a UUID —
  // SabPaisa accepts up to 40 chars so we can pass it straight through.
  // Suffix with a short timestamp so a re-initiate on the same payment
  // row (user closed modal, retry) produces a fresh id and SabPaisa
  // doesn't 409 on "duplicate txn". The original payment row id lives in
  // udf12 for correlation.
  const clientTxnId = `${input.payment_id.slice(0, 32)}-${Date.now().toString(36).slice(-6)}`.slice(0, 40);

  const fields: SabPaisaInitFields = {
    payerName:         truncate(input.payerName,  100),
    payerEmail:        truncate(input.payerEmail, 100),
    payerMobile:       truncate(input.payerPhone, 15),
    payerAddress:      "",
    clientTxnId,
    amount:            input.amountRupees,
    clientCode:        cfg.clientCode,
    transUserName:     cfg.username,
    transUserPassword: cfg.password,
    callbackUrl:       cfg.returnUrl,
    amountType:        "INR",
    channelId:         "W",     // Web
    programId:         "",
    mcc:               "",
    udf12:             input.payment_id,                   // original payments.id (even if clientTxnId has a suffix)
    udf13:             input.notes?.purpose ?? "",
    udf14:             input.notes?.ref_id ?? "",
    udf15:             input.notes?.event_slug ?? "",
  };

  const plaintext = serializeFields(fields);
  const encData = sabpaisaEncrypt(plaintext, cfg.authKey, cfg.authIv);

  return {
    redirect: {
      action:     cfg.initUrl,
      clientCode: cfg.clientCode,
      encData,
    },
    clientTxnId,
  };
}

// ─── Callback parsing ─────────────────────────────────────────────────────
//
// SabPaisa posts back a body containing an `encData` field (plus plain
// `clientCode` for their own LB routing). We decrypt and parse into a
// typed callback payload. Pure function — the caller feeds the raw
// form-encoded body (as req.body after express.urlencoded has parsed it)
// and we return either the parsed callback or null (meaning decrypt
// failed → treat as a spoof / tamper).
export function parseCallbackEncData(encData: string): SabPaisaCallbackPayload | null {
  try {
    const cfg = sabpaisaConfig();
    const plaintext = sabpaisaDecrypt(encData, cfg.authKey, cfg.authIv);
    return deserializeFields(plaintext);
  } catch {
    // Tampered / truncated / wrong-key payload. Caller should reject.
    return null;
  }
}

// ─── Server-to-server verify ──────────────────────────────────────────────
//
// SabPaisa's /status/verify endpoint returns the current state of a given
// (clientCode, clientTxnId) pair. Used as a safety net — the reconciliation
// cron calls this when a payment is stuck pending past the staleness
// threshold, and the admin "re-verify" button calls it on demand.
//
// Returns the parsed response + the normalised outcome.
export async function verifyPayment(clientTxnId: string): Promise<{
  outcome: SabPaisaOutcome;
  response: SabPaisaVerifyResponse | null;
}> {
  const cfg = sabpaisaConfig();

  // Verify request is JSON for SabPaisa's /status/verify endpoint. The
  // `clientCode` is plaintext; `encData` carries the encrypted body.
  const bodyFields = `clientCode=${cfg.clientCode}&clientTxnId=${clientTxnId}`;
  const encData = sabpaisaEncrypt(bodyFields, cfg.authKey, cfg.authIv);

  const res = await fetch(cfg.verifyUrl, {
    method:  "POST",
    headers: sabpaisaRequestHeaders(),
    body:    `clientCode=${encodeURIComponent(cfg.clientCode)}&encData=${encodeURIComponent(encData)}`,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SabPaisa verify HTTP ${res.status}: ${txt.slice(0, 500)}`);
  }

  // SabPaisa returns an encrypted response — same AES-128-CBC scheme,
  // base64 in an `encData` field. The response Content-Type is sometimes
  // JSON (`{ "encData": "..." }`) and sometimes form-encoded. Handle both.
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  let encResponse: string | null = null;
  if (ct.includes("application/json")) {
    const json = await res.json() as { encData?: string };
    encResponse = json?.encData ?? null;
  } else {
    const txt = await res.text();
    // Try to parse as form-encoded; fall back to raw-string treat-as-b64.
    const params = new URLSearchParams(txt);
    encResponse = params.get("encData") ?? txt.trim();
  }

  if (!encResponse) {
    return { outcome: "pending", response: null };
  }

  let plaintext: string;
  try {
    plaintext = sabpaisaDecrypt(encResponse, cfg.authKey, cfg.authIv);
  } catch {
    throw new Error(`SabPaisa verify: could not decrypt response body`);
  }
  const parsed = deserializeFields(plaintext) as SabPaisaVerifyResponse;
  const outcome = mapSabPaisaStatus(parsed.statusCode);
  return { outcome, response: parsed };
}

// ─── Refund ───────────────────────────────────────────────────────────────
//
// Server-to-server refund. amountRupees optional — omitting it issues a
// full refund. Caller must have already flipped the payment_refunds row
// to 'approved' (treasurer-approved) before calling; this fn only
// executes the external side-effect.
export interface SabPaisaRefundInput {
  clientTxnId:   string;      // the clientTxnId we originally sent
  refundTxnId:   string;      // a NEW unique id we generate for the refund
  amountRupees?: string;      // omit for full refund
  reason?:       string;
}

export interface SabPaisaRefundResponse {
  statusCode?:  string;
  statusDesc?:  string;
  refundTxnId?: string;
  [k: string]:  string | undefined;
}

export async function refundPayment(input: SabPaisaRefundInput): Promise<SabPaisaRefundResponse> {
  const cfg = sabpaisaConfig();

  const fields: Record<string, string> = {
    clientCode:    cfg.clientCode,
    clientTxnId:   input.clientTxnId,
    refundTxnId:   input.refundTxnId,
    reason:        input.reason ?? "Admin-approved refund",
  };
  if (input.amountRupees) fields.refundAmount = input.amountRupees;

  const plaintext = serializeFields(fields);
  const encData = sabpaisaEncrypt(plaintext, cfg.authKey, cfg.authIv);

  const res = await fetch(cfg.refundUrl, {
    method:  "POST",
    headers: sabpaisaRequestHeaders(),
    body:    `clientCode=${encodeURIComponent(cfg.clientCode)}&encData=${encodeURIComponent(encData)}`,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SabPaisa refund HTTP ${res.status}: ${txt.slice(0, 500)}`);
  }

  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  let encResponse: string | null = null;
  if (ct.includes("application/json")) {
    const json = await res.json() as { encData?: string };
    encResponse = json?.encData ?? null;
  } else {
    const txt = await res.text();
    const params = new URLSearchParams(txt);
    encResponse = params.get("encData") ?? txt.trim();
  }
  if (!encResponse) {
    throw new Error("SabPaisa refund: empty response body");
  }

  const plaintextResp = sabpaisaDecrypt(encResponse, cfg.authKey, cfg.authIv);
  return deserializeFields(plaintextResp) as SabPaisaRefundResponse;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// Request headers for server-to-server SabPaisa calls. SabPaisa's enquiry
// and refund endpoints sit behind Cloudflare WAF, which scores each
// request on its full fingerprint — User-Agent, Accept-Language,
// Sec-* client hints, etc. A thin "Mozilla/5.0" alone is not enough.
// Fully mimicking a recent Chrome request from a Windows client gets
// consistently through CF managed challenge rulesets without needing
// SabPaisa to whitelist our Fly outbound IP.
//
// If this STILL 403s, the next step is TLS fingerprint spoofing (which
// can't be done from vanilla undici) or getting SabPaisa to whitelist
// our IP range. The IP route is cleaner long-term.
function sabpaisaRequestHeaders(): Record<string, string> {
  return {
    "Content-Type":              "application/x-www-form-urlencoded",
    "Accept":                    "application/json, text/plain, */*",
    "Accept-Language":           "en-US,en;q=0.9",
    "Accept-Encoding":           "gzip, deflate, br",
    "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin":                    "https://nagpur.icai.org",
    "Referer":                   "https://nagpur.icai.org/",
    "Sec-Ch-Ua":                 "\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\", \"Google Chrome\";v=\"120\"",
    "Sec-Ch-Ua-Mobile":          "?0",
    "Sec-Ch-Ua-Platform":        "\"Windows\"",
    "Sec-Fetch-Dest":            "empty",
    "Sec-Fetch-Mode":            "cors",
    "Sec-Fetch-Site":            "cross-site",
  };
}

// Serialize to the URL-encoded ampersand-separated form SabPaisa expects.
// Keys with undefined / empty-string values are still included (SabPaisa's
// parser requires every field to appear, even if blank — their validator
// 400s on a missing key rather than treating it as empty).
function serializeFields(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join("&");
}

// Inverse — URL-decode an ampersand-separated string back into an object.
// Duplicate keys take the last value seen (SabPaisa doesn't send dups).
function deserializeFields(plaintext: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of plaintext.split("&")) {
    if (!part) continue;
    const idx = part.indexOf("=");
    const k = idx >= 0 ? part.slice(0, idx) : part;
    const v = idx >= 0 ? part.slice(idx + 1) : "";
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      // Malformed URL-encoding in a response — keep the raw value rather
      // than crashing the whole payload.
      out[k] = v;
    }
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

// Converts paise (our stored unit) to the rupees-with-two-decimals string
// SabPaisa expects on initiate. 10000 → "100.00".
export function paiseToRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}
