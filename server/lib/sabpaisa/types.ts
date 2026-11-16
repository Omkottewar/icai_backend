// SabPaisa payload types + status codes, per https://developer.sabpaisa.in

// Browser form fields for the checkout POST (encData + clientCode).
export interface SabPaisaInitRedirect {
  action:     string;   // init URL for the configured SABPAISA_ENV
  clientCode: string;
  encData:    string;   // AES256HMACSHA384HEX of the request string
}

// Decrypted encResponse (callback) / statusResponseData (enquiry).
// The docs spell one field "sabpaisaTxnld" in places — normalised to
// sabpaisaTxnId by the parser.
export interface SabPaisaResponse {
  statusCode?:        string;
  status?:            string;
  responseCode?:      string;
  clientCode?:        string;
  clientTxnId?:       string;
  sabpaisaTxnId?:     string;
  sabpaisaMessage?:   string;
  bankMessage?:       string;
  bankErrorCode?:     string;
  sabpaisaErrorCode?: string;
  bankTxnId?:         string;
  transDate?:         string;
  amount?:            string;
  paidAmount?:        string;
  paymentMode?:       string;
  bankName?:          string;
  udf1?:              string;
  [key: string]:      string | null | undefined;
}

// Transaction status codes from the docs:
//   0000 SUCCESS · 0300 FAILED · 0100 INITIATED (not completed)
//   0200 ABORTED · 0999 UNKNOWN (use Transaction Enquiry)
//   0400 CHALLAN GENERATED (offline payment pending) · 404 NOT FOUND
export type SabPaisaOutcome = "success" | "failed" | "aborted" | "pending" | "unknown" | "not_found";

export function mapSabPaisaStatus(statusCode: string | undefined | null, statusText?: string | null): SabPaisaOutcome {
  if (!(statusCode ?? "").trim() && statusText) {
    const t = statusText.trim().toUpperCase();
    if (t === "SUCCESS") return "success";
    if (t === "FAILED" || t === "FAILURE") return "failed";
    if (t === "ABORTED") return "aborted";
    if (t === "INITIATED" || t === "PENDING" || t === "CHALLAN_GENERATED") return "pending";
    if (t === "NOT_FOUND" || t === "NOT FOUND") return "not_found";
  }
  switch ((statusCode ?? "").trim()) {
    case "0000": return "success";
    case "0300": return "failed";
    case "0200": return "aborted";
    case "0100": return "pending";
    case "0400": return "pending";
    case "404":
    case "0404": return "not_found";
    default:     return "unknown";   // incl. 0999 → confirm via enquiry
  }
}

export function describeSabPaisa(r: SabPaisaResponse | null | undefined): string {
  if (!r) return "";
  return String(r.sabpaisaMessage || r.bankMessage || r.status || "").trim();
}
