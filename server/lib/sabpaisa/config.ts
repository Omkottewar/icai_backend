// SabPaisa configuration, per https://developer.sabpaisa.in/docs/urls/
//
// Env vars (see .env.example):
//   SABPAISA_ENV           "staging" (default) | "production" — picks the
//                          SabPaisa URLs below. Nothing else switches hosts.
//   SABPAISA_CLIENT_CODE   merchant client code issued by SabPaisa
//   SABPAISA_USERNAME      transUserName issued by SabPaisa
//   SABPAISA_PASSWORD      transUserPassword issued by SabPaisa
//   SABPAISA_AUTH_KEY      base64 authKey (decodes to 32 bytes, AES-256-GCM)
//   SABPAISA_AUTH_IV       base64 authIV (HMAC-SHA384 key)
//   SABPAISA_MCC           merchant category code (mandatory in the docs)
//   SABPAISA_CALLBACK_URL  where SabPaisa POSTs encResponse after payment.
//                          Falls back to SABPAISA_RETURN_URL, then to
//                          ${APP_URL}/api/payments/sabpaisa/return.

import { decodeKey } from "./crypto.js";

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
  const keyBytes = decodeKey(authKey, "SABPAISA_AUTH_KEY").length;
  if (keyBytes !== 32) {
    throw new Error(`SABPAISA_AUTH_KEY must be SabPaisa's base64 AES-256 key (32 bytes once decoded, got ${keyBytes})`);
  }
  if (decodeKey(authIv, "SABPAISA_AUTH_IV").length === 0) {
    throw new Error("SABPAISA_AUTH_IV is empty");
  }

  const mcc = need("SABPAISA_MCC");
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
    mcc,
    callbackUrl,
    ...URLS[env],
  };
  return cached;
}

export function _resetSabPaisaConfigCache() {
  cached = null;
}
