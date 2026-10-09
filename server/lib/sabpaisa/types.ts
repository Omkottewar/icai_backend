// SabPaisa payload shapes.
//
// Field names follow SabPaisa's documented camelCase convention for the
// init payload and their query-string "key=value&..." convention for the
// return callback. Exact field names below may need tweaking when the
// integration-documents PDF arrives from Sushanta — the fields marked
// // TBD are placeholders based on common SabPaisa docs; the rest are
// stable across SabPaisa versions.

export interface SabPaisaInitInput {
  clientTxnId:  string;         // our own tracker, round-tripped on callback
  amountRupees: string;         // "100.00" — SabPaisa expects rupees not paise
  payerName:    string;
  payerEmail:   string;
  payerMobile:  string;
  payerAddress?: string;
  // User-defined fields — SabPaisa allows up to 20 (udf1..udf20) and
  // echoes them back on the callback. We stash the event slug in udf1 so
  // we can route the user straight back to it on return.
  udf1?: string;
  udf2?: string;
  udf3?: string;
  // Branch and channel are static per-merchant; carried through for
  // SabPaisa's own reporting.
  channelId?: string;           // defaults to "W" (web)
}

export interface SabPaisaInitPayload {
  clientCode:          string;
  transUserName:       string;
  transUserPassword:   string;
  clientTxnId:         string;
  amount:              string;
  payerName:           string;
  payerEmail:          string;
  payerMobile:         string;
  payerAddress:        string;
  udf1:                string;
  udf2:                string;
  udf3:                string;
  udf4:                string;
  udf5:                string;
  udf6:                string;
  udf7:                string;
  udf8:                string;
  udf9:                string;
  udf10:               string;
  udf11:               string;
  udf12:               string;
  udf13:               string;
  udf14:               string;
  udf15:               string;
  udf16:               string;
  udf17:               string;
  udf18:               string;
  udf19:               string;
  udf20:               string;
  channelId:           string;
  callbackUrl:         string;
  mcc:                 string;
  currencyCode:        string;
}

// Shape returned to the browser so it can auto-POST a form to SabPaisa's
// hosted checkout. Three fields total; the actual payment data is inside
// `encData`.
export interface SabPaisaInitRedirect {
  action:     string;           // SabPaisa init URL
  clientCode: string;
  encData:    string;           // AES-encrypted base64 of SabPaisaInitPayload
}

// Response fields SabPaisa posts back to our return URL. These are also
// what the Push webhook delivers (modulo wrapper differences). Fields are
// optional because SabPaisa populates different subsets depending on the
// payment mode (card vs UPI vs netbanking) and outcome (success vs failed).
export interface SabPaisaCallbackPayload {
  clientCode?:         string;
  clientTxnId?:        string;
  sabpaisaTxnId?:      string;
  amount?:             string;
  paidAmount?:         string;
  status?:             string;     // "SUCCESS" | "FAILED" | "ABORTED" | "PENDING" | "CHALLENGED"
  statusCode?:         string;
  bankErrorCode?:      string;
  bankErrorMessage?:   string;
  bankName?:           string;
  bankTxnId?:          string;
  paymentMode?:        string;     // "CARD" | "UPI" | "NB" | "WALLET" | ...
  payerName?:          string;
  payerEmail?:         string;
  payerMobile?:        string;
  transDate?:          string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  // Keep the raw payload in-hand even for fields we didn't model yet.
  [key: string]: string | undefined;
}

// Verify API response. Fields overlap heavily with the callback.
export type SabPaisaVerifyResponse = SabPaisaCallbackPayload;

// Our normalised status after mapping SabPaisa's status strings.
// `pending` means SabPaisa took the payment but hasn't given a final
// outcome yet — the double-verify loop retries until it resolves.
export type SabPaisaOutcome = "success" | "failed" | "pending" | "aborted";

export function mapSabPaisaStatus(raw: string | undefined | null): SabPaisaOutcome {
  const s = (raw ?? "").toUpperCase().trim();
  if (s === "SUCCESS" || s === "SUCCESSFUL" || s === "0000") return "success";
  if (s === "FAILED" || s === "FAILURE")                     return "failed";
  if (s === "ABORTED" || s === "CANCELLED" || s === "CANCELED") return "aborted";
  // CHALLENGED / PENDING / INITIATED / anything else — treat as pending.
  return "pending";
}
