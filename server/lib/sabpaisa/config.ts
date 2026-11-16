// SabPaisa configuration, per https://developer.sabpaisa.in/docs/urls/
//
// Env vars (see .env.example):
//   SABPAISA_ENV           "staging" (default) | "production" — picks the
//                          SabPaisa URLs below. Nothing else switches hosts.
//   SABPAISA_CLIENT_CODE   merchant client code issued by SabPaisa
//   SABPAISA_USERNAME      transUserName issued by SabPaisa
//   SABPAISA_PASSWORD      transUserPassword issued by SabPaisa
//   SABPAISA_AUTH_KEY      authKey — either the 16-character AES-128 key or the
//                          base64 AES-256 key; crypto.ts picks the scheme
//   SABPAISA_AUTH_IV       authIV that came with the key
//   SABPAISA_MCC           merchant category code (defaults to 8220, the value
//                          used when SabPaisa last worked for this branch)
//   SABPAISA_CALLBACK_URL  where SabPaisa POSTs encResponse after payment.
//                          Falls back to SABPAISA_RETURN_URL, then to
//                          ${APP_URL}/api/payments/sabpaisa/return.

import { schemeFor, type SabPaisaScheme } from "./crypto.js";

export type SabPaisaEnv = "staging" | "production";

// Official endpoints from the SabPaisa docs.
const URLS: Record<SabPaisaEnv, { initUrl: string; enquiryUrl: string; refundUrl: string }> = {
  staging: {
    initUrl:    "https://stage-securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1",
    enquiryUrl: "https://stage-txnenquiry.sabpaisa.in/SPTxtnEnquiry/getTxnStatusByClientxnId",
    refundUrl:  "https://stage-gateway.sabpaisa.in/sabpaisa/refund",
  },
  production: {
    initUrl:    "https://securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1",
    enquiryUrl: "https://txnenquiry.sabpaisa.in/SPTxtnEnquiry/getTxnStatusByClientxnId",
    refundUrl:  "https://gateway.sabpaisa.in/sabpaisa/refund",
  },
};

export interface SabPaisaConfig {
  env:         SabPaisaEnv;
  clientCode:  string;
  username:    string;
  password:    string;
  authKey:     string;
  authIv:      string;
  scheme:      SabPaisaScheme;
  mcc:         string;
  callbackUrl: string;
  initUrl:     string;
  enquiryUrl:  string;
  refundUrl:   string;
}

let cached: SabPaisaConfig | null = null;

function readEnv(): SabPaisaEnv {
  const raw = (process.env.SABPAISA_ENV ?? "").trim().toLowerCase();
  if (!raw || raw === "staging" || raw === "stage" || raw === "uat") return "staging";
  if (raw === "production" || raw === "prod" || raw === "live") return "production";
  throw new Error(`SABPAISA_ENV='${raw}' is not valid — use 'staging' or 'production'`);
}

export function sabpaisaConfig(): SabPaisaConfig {
  if (cached) return cached;

  const need = (key: string): string => {
    const v = (process.env[key] ?? "").trim();
    if (!v) throw new Error(`Missing env var ${key} — required for SabPaisa`);
    return v;
  };

  const env = readEnv();
  const authKey = need("SABPAISA_AUTH_KEY");
  const authIv  = need("SABPAISA_AUTH_IV");
  const scheme = schemeFor(authKey);
  if (scheme === "legacy-aes128" && Buffer.byteLength(authIv, "utf8") !== 16) {
    throw new Error("SABPAISA_AUTH_IV must be 16 characters for the AES-128 key");
  }

  const mcc = (process.env.SABPAISA_MCC ?? "").trim() || "8220";
  if (!/^\d+$/.test(mcc)) throw new Error("SABPAISA_MCC must be numeric");

  const appUrl = (process.env.APP_URL ?? "").trim().replace(/\/$/, "");
  const callbackUrl =
    (process.env.SABPAISA_CALLBACK_URL ?? "").trim() ||
    (process.env.SABPAISA_RETURN_URL ?? "").trim() ||
    (appUrl ? `${appUrl}/api/payments/sabpaisa/return` : "");
  if (!callbackUrl) throw new Error("Missing env var SABPAISA_CALLBACK_URL (or APP_URL)");
  if (callbackUrl.length > 255) throw new Error("SABPAISA_CALLBACK_URL is longer than 255 characters");

  cached = {
    env,
    clientCode: need("SABPAISA_CLIENT_CODE"),
    username:   need("SABPAISA_USERNAME"),
    password:   need("SABPAISA_PASSWORD"),
    authKey,
    authIv,
    scheme,
    mcc,
    callbackUrl,
    ...URLS[env],
  };
  return cached;
}

export function _resetSabPaisaConfigCache() {
  cached = null;
}
