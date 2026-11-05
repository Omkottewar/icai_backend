// Razorpay client — thin wrapper over the Razorpay REST API.
//
// Everything here is pure (crypto + fetch + env-driven config). No DB
// access and no Express request/response types — the route layer owns
// those. Keeps the module easy to unit-test and reuse across paid
// surfaces (event registration, job posting, admin test).
//
// Razorpay checkout flow summary:
//   1. Backend POST /v1/orders → Razorpay returns { id, amount, ... }.
//      We return order_id + key_id to the browser.
//   2. Browser loads checkout.razorpay.com/v1/checkout.js and opens the
//      modal with the order_id. User pays in-page; no redirect.
//   3. Razorpay fires the modal's handler with { razorpay_payment_id,
//      razorpay_order_id, razorpay_signature }. Browser POSTs these to
//      our /api/payments/verify.
//   4. Backend verifies HMAC-SHA256(order_id|payment_id, key_secret) ===
//      signature. If it matches, the payment is authentically from
//      Razorpay. Flip to success and fulfil.
//   5. Separately, Razorpay fires server-to-server webhooks to our
//      /api/payments/webhook. Signature is X-Razorpay-Signature, verified
//      with the webhook_secret (different from key_secret). Idempotent
//      against the verify path.

import { createHmac, timingSafeEqual } from "node:crypto";
import { razorpayConfig } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────

export interface RazorpayOrderInput {
  amountPaise:  number;          // amount in paise (integer)
  receipt:      string;          // our side's reference id (the payment row id works)
  notes?:       Record<string, string>;  // echoed on webhook + dashboard — handy for payment_id, purpose, ref_id
  currency?:    string;          // defaults to "INR"
}

export interface RazorpayOrder {
  id:         string;            // "order_XXXX"
  entity:     "order";
  amount:     number;            // paise
  amount_paid: number;
  amount_due: number;
  currency:   string;
  receipt:    string | null;
  status:     "created" | "attempted" | "paid";
  notes:      Record<string, string>;
  created_at: number;
}

export interface RazorpayPayment {
  id:        string;             // "pay_XXXX"
  entity:    "payment";
  amount:    number;             // paise
  currency:  string;
  status:    "created" | "authorized" | "captured" | "refunded" | "failed";
  order_id:  string | null;
  method?:   string;             // "card" | "upi" | "netbanking" | "wallet" | ...
  bank?:     string | null;
  wallet?:   string | null;
  vpa?:      string | null;
  email?:    string | null;
  contact?:  string | null;
  error_code?:        string | null;
  error_description?: string | null;
  error_reason?:      string | null;
  captured?: boolean;
  created_at: number;
  notes?:    Record<string, string>;
}

export interface RazorpayRefund {
  id:         string;            // "rfnd_XXXX"
  entity:     "refund";
  amount:     number;            // paise
  currency:   string;
  payment_id: string;
  status:     "pending" | "processed" | "failed";
  created_at: number;
}

export type RazorpayOutcome = "success" | "failed" | "pending" | "aborted";

// Razorpay payment status → our normalised outcome. `captured` is the only
// state that confirms the money landed. `authorized` means the bank put a
// hold but hasn't been captured yet — we always use auto-capture (amount
// locked in the order), so an authorized-but-not-captured state usually
// means the capture is still in flight. Treat as pending; the next webhook
// or verify call will resolve.
export function mapRazorpayStatus(status: string | undefined | null): RazorpayOutcome {
  const s = (status ?? "").toLowerCase().trim();
  if (s === "captured" || s === "refunded") return "success";
  if (s === "failed")                        return "failed";
  // Razorpay doesn't surface a dedicated "user cancelled" state via the
  // API — it just never creates a payment row. Aborted is reserved for
  // cases where the frontend explicitly tells us the user closed the
  // modal without paying.
  return "pending";
}

// ─── Order creation ───────────────────────────────────────────────────────

export async function createOrder(input: RazorpayOrderInput): Promise<RazorpayOrder> {
  const cfg = razorpayConfig();
  const body = {
    amount:          input.amountPaise,
    currency:        input.currency ?? "INR",
    receipt:         input.receipt.slice(0, 40),   // Razorpay caps receipt at 40 chars
    notes:           input.notes ?? {},
    payment_capture: 1,
  };

  const res = await fetch(`${cfg.apiBase}/v1/orders`, {
    method:  "POST",
    headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Razorpay order creation HTTP ${res.status}: ${txt.slice(0, 500)}`);
  }

  const json = (await res.json()) as RazorpayOrder;
  if (!json?.id) throw new Error(`Razorpay order creation: no id in response`);
  return json;
}

// ─── Signature verification (checkout handler) ────────────────────────────
// Called from /api/payments/verify after the Razorpay Checkout modal
// resolves successfully in the browser. Payload shape:
//   { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Returns true iff HMAC-SHA256(order_id + "|" + payment_id, key_secret) ===
// razorpay_signature. Any mismatch means the handler payload was tampered
// with and must be rejected.
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signatureHex: string,
): boolean {
  const cfg = razorpayConfig();
  const expected = createHmac("sha256", cfg.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return constantTimeEqualHex(expected, signatureHex);
}

// ─── Webhook signature verification ───────────────────────────────────────
// Razorpay's server-to-server push posts the raw JSON body and signs it
// with the webhook secret (separate from the API key secret). The signature
// is in the X-Razorpay-Signature header. Pass the EXACT raw request body
// (as the Buffer / string that arrived — no re-serialisation; whitespace
// changes break the HMAC).
export function verifyWebhookSignature(rawBody: string, signatureHex: string): boolean {
  const cfg = razorpayConfig();
  const expected = createHmac("sha256", cfg.webhookSecret)
    .update(rawBody)
    .digest("hex");
  return constantTimeEqualHex(expected, signatureHex);
}

// ─── Fetch order status (for reconciliation) ──────────────────────────────
// GET /v1/orders/:id/payments returns every payment attempt against the
// order. For a paid order there'll be a `captured` payment in the list;
// for a failed/abandoned one we'll see 0..N `failed` rows. For an order
// nobody tried paying, 0 rows.
export async function fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
  const cfg = razorpayConfig();
  const res = await fetch(`${cfg.apiBase}/v1/orders/${encodeURIComponent(orderId)}/payments`, {
    method: "GET",
    headers: authHeaders(cfg),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Razorpay fetch order payments HTTP ${res.status}: ${txt.slice(0, 500)}`);
  }
  const json = await res.json() as { items?: RazorpayPayment[] };
  return Array.isArray(json?.items) ? json.items : [];
}

// Returns the resolved payment (if any) + the normalised outcome. Used by
// the reconciliation cron and the admin re-verify endpoint.
export async function verifyOrderOutcome(orderId: string): Promise<{
  outcome: RazorpayOutcome;
  payment: RazorpayPayment | null;
}> {
  const payments = await fetchOrderPayments(orderId);
  // Prefer any `captured` row — that's money actually landed. Otherwise
  // report the newest payment's status; if there are none, pending.
  const captured = payments.find((p) => p.status === "captured");
  if (captured) return { outcome: "success", payment: captured };

  if (payments.length === 0) return { outcome: "pending", payment: null };

  // Newest first for deterministic "last attempt" semantics.
  const sorted = [...payments].sort((a, b) => b.created_at - a.created_at);
  const latest = sorted[0];
  return { outcome: mapRazorpayStatus(latest.status), payment: latest };
}

// ─── Refund ───────────────────────────────────────────────────────────────
// Server-to-server refund. `amountPaise` optional — omitting it issues a
// full refund. Caller must have already flipped the payment_refunds row
// to 'approved' (treasurer-approved) before calling; this fn only
// executes the external side-effect.
export interface RazorpayRefundInput {
  paymentId:    string;     // "pay_XXXX" — Razorpay's payment id, not our row id
  amountPaise?: number;     // partial refund amount; omit for full refund
  notes?:       Record<string, string>;
}

export async function refundPayment(input: RazorpayRefundInput): Promise<RazorpayRefund> {
  const cfg = razorpayConfig();
  const body: Record<string, unknown> = {};
  if (typeof input.amountPaise === "number") body.amount = input.amountPaise;
  if (input.notes) body.notes = input.notes;

  const res = await fetch(`${cfg.apiBase}/v1/payments/${encodeURIComponent(input.paymentId)}/refund`, {
    method:  "POST",
    headers: { ...authHeaders(cfg), "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Razorpay refund HTTP ${res.status}: ${txt.slice(0, 500)}`);
  }
  return await res.json() as RazorpayRefund;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function authHeaders(cfg: { keyId: string; keySecret: string }): Record<string, string> {
  const token = Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

// timingSafeEqual needs Buffers of equal length; a length mismatch is a
// definite non-match, so return false up front.
function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

// Converts paise (our stored unit) to the rupees-with-two-decimals string
// used in display/logs. 10000 → "100.00".
export function paiseToRupees(paise: number): string {
  return (paise / 100).toFixed(2);
}
