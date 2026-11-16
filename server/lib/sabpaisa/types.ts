// SabPaisa type definitions + status normalisation.
//
// SabPaisa's payload format is a URL-encoded ampersand-separated string
// (not JSON — that's not a mistake, their PHP7+ reference code does
// `http_build_query`). Each field appears as `key=value` pairs. The shapes
// below describe what we send and receive after the AES-128-CBC layer is
// peeled off.

// ─── Init payload (what we encrypt and send) ──────────────────────────────
export interface SabPaisaInitFields {
  payerName:        string;
  payerEmail:       string;
  payerMobile:      string;
  payerAddress?:    string;        // optional — SabPaisa accepts blank
  clientTxnId:      string;        // OUR id — SabPaisa echoes it back
  amount:           string;        // rupees with 2-decimal string ("100.00")
  clientCode:       string;        // merchant client code (NBW / NITE5)
  transUserName:    string;        // SABPAISA_USERNAME
  transUserPassword: string;       // SABPAISA_PASSWORD
  callbackUrl:      string;        // URL on OUR site; SabPaisa redirects here
  amountType:       string;        // "INR"
  channelId:        string;        // "W" for Web
  programId?:       string;        // optional loyalty-program id; usually blank
  mcc?:             string;        // merchant category code; usually blank
  udf12?:           string;        // user-defined fields 1..20 for notes
  udf13?:           string;
  udf14?:           string;
  udf15?:           string;
}

// What the frontend receives from /api/payments/sabpaisa/initiate.
// Browser auto-POSTs these three fields as `application/x-www-form-urlencoded`
// to SabPaisa's init URL to open the hosted checkout.
export interface SabPaisaInitRedirect {
  action:     string;       // SABPAISA_INIT_URL
  clientCode: string;       // plaintext — SabPaisa's LB routes without decrypting
  encData:    string;       // base64 AES-128-CBC ciphertext of the payload
}

// ─── Callback payload (what SabPaisa sends us in /return + /webhook) ──────
export interface SabPaisaCallbackPayload {
  clientCode?:        string;
  clientTxnId?:       string;     // our id — correlation key
  sabpaisaTxnId?:     string;     // their id
  statusCode?:        string;     // "0000" = success; other = look up in SabPaisa's codes doc
  statusDesc?:        string;     // human-readable status
  paymentMode?:       string;     // "Card" | "UPI" | "Netbanking" | "Wallet" | ...
  bankName?:          string;
  bankTxnId?:         string;
  amount?:            string;     // rupees string
  paidAmount?:        string;     // what actually got captured
  payerName?:         string;
  payerEmail?:        string;
  payerMobile?:       string;
  udf12?:             string;
  udf13?:             string;
  udf14?:             string;
  udf15?:             string;
  // Anything else SabPaisa decides to add in future — we preserve the
  // full decoded payload as jsonb for audit.
  [key: string]:      string | undefined;
}

// ─── Status mapping — SabPaisa code → our normalised outcome ─────────────
// SabPaisa's status codes (per their PHP reference):
//   0000  → success (captured)
//   0001-0999 → in-progress / pending states
//   non-0 terminal → failed / aborted
// We map the full landscape into our four-state outcome enum so the caller
// doesn't need to know SabPaisa-specific codes.
export type SabPaisaOutcome = "success" | "failed" | "pending" | "aborted";

export function mapSabPaisaStatus(statusCode: string | undefined | null): SabPaisaOutcome {
  const code = (statusCode ?? "").trim().toUpperCase();
  if (code === "0000" || code === "SUCCESS") return "success";
  if (code === "" || code === "PENDING" || code === "INITIATED" || code === "IN_PROGRESS") return "pending";
  // SabPaisa surfaces a dedicated "aborted" code for user-cancelled flows.
  if (code === "AB" || code === "ABORTED" || code === "CANCELLED" || code === "USER_DROPPED") return "aborted";
  // Everything else — bank declined, insufficient funds, timeout, etc. —
  // folds into failed. Admin can still read the raw status in
  // payments.sabpaisa_status_code for triage.
  return "failed";
}

// ─── Verify payload (double-check endpoint) ───────────────────────────────
// SabPaisa exposes a server-to-server /status/verify endpoint we can poll
// to confirm an outcome without trusting the callback. Used by the
// reconciliation cron and the admin re-verify button.
export interface SabPaisaVerifyRequest {
  clientCode:  string;
  clientTxnId: string;
}

export interface SabPaisaVerifyResponse {
  clientTxnId?:    string;
  sabpaisaTxnId?:  string;
  statusCode?:     string;
  statusDesc?:     string;
  amount?:         string;
  paidAmount?:     string;
  paymentMode?:    string;
  bankName?:       string;
  bankTxnId?:      string;
  // Full raw payload preserved for audit in payments.sabpaisa_response.
  [key: string]:   string | undefined;
}
