import { createHmac } from "node:crypto";
import { ApiError } from "./apiError.js";

// Thin wrapper around the two Razorpay endpoints we actually need (create order
// + verify checkout signature). Avoids pulling the official SDK; the REST API
// is stable and small enough that a fetch + HMAC is clearer than a black box.

const RAZORPAY_API = "https://api.razorpay.com/v1";

function creds() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new ApiError(503, "Payments are not configured on the server");
  }
  return { key_id, key_secret };
}

export function razorpayKeyId(): string {
  return creds().key_id;
}

type CreateOrderInput = {
  amount_paise: number;
  receipt: string;            // our payment.id — Razorpay caps this at 40 chars
  notes?: Record<string, string>;
};

type RazorpayOrder = {
  id: string;
  status: string;
  amount: number;
  currency: string;
};

export async function createRazorpayOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
  const { key_id, key_secret } = creds();

  const body = {
    amount: input.amount_paise,
    currency: "INR",
    receipt: input.receipt,
    notes: input.notes ?? {},
  };

  const auth = Buffer.from(`${key_id}:${key_secret}`).toString("base64");
  const resp = await fetch(`${RAZORPAY_API}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new ApiError(502, `Razorpay order creation failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as RazorpayOrder;
}

// Razorpay Checkout returns order_id + payment_id + signature to the browser
// after a successful payment. The signature is HMAC-SHA256 of
// `<order_id>|<payment_id>` keyed by the secret. Verifying it server-side is
// what proves the client wasn't spoofing a "paid" callback.
export function verifyCheckoutSignature(input: {
  order_id: string;
  payment_id: string;
  signature: string;
}): boolean {
  const { key_secret } = creds();
  const expected = createHmac("sha256", key_secret)
    .update(`${input.order_id}|${input.payment_id}`)
    .digest("hex");
  // Constant-time compare to avoid timing leaks on the signature
  if (expected.length !== input.signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ input.signature.charCodeAt(i);
  }
  return diff === 0;
}
