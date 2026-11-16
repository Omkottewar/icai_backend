// SabPaisa client, built from https://developer.sabpaisa.in
//
//   1. Payment request — buildInitRedirect() makes encData from the
//      '&'-joined request string; the browser POSTs encData + clientCode
//      to the init URL.
//   2. Callback — SabPaisa POSTs `encResponse` to callbackUrl;
//      parseEncResponse() decrypts it.
//   3. Transaction Enquiry — enquireTransaction() (JSON API) for 0999 /
//      missing callbacks. Calls must not be made concurrently.
//   4. Refund — refundTransaction() (JSON API).
//
// Pure module: no DB, no Express.

import { randomBytes } from "node:crypto";
import { sabpaisaConfig } from "./config.js";
import { sabpaisaEncrypt, sabpaisaDecrypt } from "./crypto.js";
import { mapSabPaisaStatus, type SabPaisaInitRedirect, type SabPaisaOutcome, type SabPaisaResponse } from "./types.js";

// ─── 1. Payment request ───────────────────────────────────────────────────
export interface BuildInitInput {
  payment_id:   string;                   // our payments.id → udf1
  amountRupees: string;                   // "100.00"
  payerName:    string;
  payerEmail:   string;
  payerPhone:   string;
  notes?:       Record<string, string>;   // purpose → udf2, ref_id → udf3, event_slug → udf4
}

export function buildInitRedirect(input: BuildInitInput): { redirect: SabPaisaInitRedirect; clientTxnId: string } {
  const cfg = sabpaisaConfig();
  const clientTxnId = newClientTxnId();

  // Field names, lengths and mandatory fields per the docs' request table.
  const fields: Array<[string, string]> = [
    ["payerName",         clean(input.payerName, 100) || "Member"],
    ["payerEmail",        clean(input.payerEmail, 100)],
    ["payerMobile",       mobile(input.payerPhone)],
    ["clientTxnId",       clientTxnId],
    ["amount",            input.amountRupees],
    ["clientCode",        cfg.clientCode],
    ["transUserName",     cfg.username],
    ["transUserPassword", cfg.password],
    ["callbackUrl",       cfg.callbackUrl],
    ["channelId",         "W"],
    ["mcc",               cfg.mcc],
    ["transDate",         istTimestamp(new Date())],
    ["amountType",        "INR"],
    ["udf1",              clean(input.payment_id, 100)],
    ["udf2",              clean(input.notes?.purpose ?? "", 100)],
    ["udf3",              clean(input.notes?.ref_id ?? "", 100)],
    ["udf4",              clean(input.notes?.event_slug ?? input.notes?.posting_type ?? "", 100)],
  ];

  const plaintext = fields.map(([k, v]) => `${k}=${v}`).join("&");
  return {
    redirect: {
      action:     cfg.initUrl,
      clientCode: cfg.clientCode,
      encData:    sabpaisaEncrypt(plaintext, cfg.authKey, cfg.authIv),
    },
    clientTxnId,
  };
}

// ─── 2. Callback ──────────────────────────────────────────────────────────
// Returns null when the payload fails the HMAC / decrypt (spoofed or keys
// mismatch) — callers must treat that as untrusted.
export function parseEncResponse(encResponse: string): SabPaisaResponse | null {
  try {
    const cfg = sabpaisaConfig();
    // Query-string delivery can turn '+' into ' '; harmless for hex.
    return parseFields(sabpaisaDecrypt(encResponse.replace(/\s/g, ""), cfg.authKey, cfg.authIv));
  } catch {
    return null;
  }
}

// ─── 3. Transaction Enquiry ───────────────────────────────────────────────
export async function enquireTransaction(clientTxnId: string): Promise<{ outcome: SabPaisaOutcome; response: SabPaisaResponse | null }> {
  const cfg = sabpaisaConfig();
  const statusTransEncData = sabpaisaEncrypt(
    `clientCode=${cfg.clientCode}&clientTxnId=${clientTxnId}`,
    cfg.authKey, cfg.authIv,
  );

  const res = await fetch(cfg.enquiryUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body:    JSON.stringify({ clientCode: cfg.clientCode, statusTransEncData }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SabPaisa enquiry HTTP ${res.status}: ${text.slice(0, 300)}`);

  let json: { statusResponseData?: string } = {};
  try { json = JSON.parse(text); } catch { throw new Error(`SabPaisa enquiry: non-JSON response: ${text.slice(0, 300)}`); }
  if (!json.statusResponseData) return { outcome: "unknown", response: null };

  const response = parseFields(sabpaisaDecrypt(json.statusResponseData, cfg.authKey, cfg.authIv));
  return { outcome: mapSabPaisaStatus(response.statusCode), response };
}

// ─── 4. Refund ────────────────────────────────────────────────────────────
export interface SabPaisaRefundInput {
  spTxnId:      string;   // SabPaisa's transaction id (payments.sabpaisa_txn_id)
  clientTxnId:  string;   // our clientTxnId
  amountRupees: string;   // amount to refund, "100.00"
  message:      string;   // refund reason
}

export interface SabPaisaRefundResult {
  apiStatusCode?:        string;
  apiStatusDescription?: string;
  refund:                SabPaisaResponse | null;   // decrypted refundResponse (statusCode 0600 = REFUND_INITIATED, …)
}

export async function refundTransaction(input: SabPaisaRefundInput): Promise<SabPaisaRefundResult> {
  const cfg = sabpaisaConfig();
  const plain = [
    `clientCode=${cfg.clientCode}`,
    `amount=${input.amountRupees}`,
    `spTxnId=${input.spTxnId}`,
    `clientTxnId=${input.clientTxnId}`,
    `message=${clean(input.message, 200)}`,
  ].join("&");

  const res = await fetch(cfg.refundUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body:    JSON.stringify({ clientCode: cfg.clientCode, refundQuery: sabpaisaEncrypt(plain, cfg.authKey, cfg.authIv) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SabPaisa refund HTTP ${res.status}: ${text.slice(0, 300)}`);

  let json: { apiStatusCode?: string; apiStatusDescription?: string; refundResponse?: string } = {};
  try { json = JSON.parse(text); } catch { throw new Error(`SabPaisa refund: non-JSON response: ${text.slice(0, 300)}`); }
  return {
    apiStatusCode:        json.apiStatusCode,
    apiStatusDescription: json.apiStatusDescription,
    refund: json.refundResponse ? parseFields(sabpaisaDecrypt(json.refundResponse, cfg.authKey, cfg.authIv)) : null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// True when SabPaisa's `amount` equals what we charged (in paise).
export function amountMatches(r: SabPaisaResponse, expectedPaise: number): boolean {
  const n = Number(r.amount ?? r.paidAmount);
  return Number.isFinite(n) && Math.round(n * 100) === expectedPaise;
}

export function paiseToRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

// AlphaNumeric, unique per attempt (docs: clientTxnId, max 100).
function newClientTxnId(): string {
  return `NGP${Date.now().toString(36)}${randomBytes(5).toString("hex")}`.toUpperCase();
}

// "YYYY-MM-DD HH:mm:ss" in IST, as in the docs' example.
function istTimestamp(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 19).replace("T", " ");
}

// The request is a raw '&'-joined string, so '&' and '=' can't appear in values.
function clean(s: string, max: number): string {
  return String(s ?? "").replace(/[&=\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function mobile(s: string): string {
  const digits = String(s ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function parseFields(plaintext: string): SabPaisaResponse {
  const out: SabPaisaResponse = {};
  for (const part of plaintext.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = i >= 0 ? part.slice(0, i) : part;
    let v = i >= 0 ? part.slice(i + 1) : "";
    try { v = decodeURIComponent(v.replace(/\+/g, " ")); } catch { /* keep raw */ }
    out[k] = v === "null" ? null : v;
  }
  if (!out.sabpaisaTxnId && out.sabpaisaTxnld) out.sabpaisaTxnId = out.sabpaisaTxnld;
  return out;
}
