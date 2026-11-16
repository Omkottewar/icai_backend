// SabPaisa environment configuration.
//
// SabPaisa credentials live in env vars only — never in site_settings,
// never in the DB, never in the frontend bundle. The runtime fails fast
// if a required var is missing so an incomplete deploy can't silently
// fall back to UAT credentials or no-op the integration.
//
// Env vars (see .env.example):
//   SABPAISA_CLIENT_CODE — the branch's merchant client code. 'NBW' = live
//                          (Nagpur Branch of WIRC, provisioned by SabPaisa
//                          account manager Sushanta Bhattacharyya, Oct
//                          2026). 'NITE5' = generic PHP7+ UAT sandbox
//                          credentials shared for pre-live testing.
//   SABPAISA_USERNAME    — SabPaisa-issued API username for the client.
//   SABPAISA_PASSWORD    — SabPaisa-issued API password for the client.
//   SABPAISA_AUTH_KEY    — AES-128 key (16 bytes) for request/response
//                          encryption. Shared out-of-band with the branch.
//   SABPAISA_AUTH_IV     — AES-128 IV (16 bytes). Shared with the key.
//                          SabPaisa's PHP7+ reference uses a static IV,
//                          same for every payload — we replicate that.
//   SABPAISA_INIT_URL    — SabPaisa's hosted checkout entry URL. The
//                          browser auto-POSTs to this.
//   SABPAISA_VERIFY_URL  — SabPaisa's server-to-server /status/verify
//                          endpoint. Used by the reconciliation cron
//                          and the admin re-verify button.
//   SABPAISA_REFUND_URL  — SabPaisa's refund API endpoint.
//   SABPAISA_RETURN_URL  — The URL on OUR site that SabPaisa redirects
//                          the browser to after payment. Must be exactly
//                          what's whitelisted on the SabPaisa dashboard.

export interface SabPaisaConfig {
  clientCode:  string;
  username:    string;
  password:    string;
  authKey:     string;   // 16 bytes
  authIv:      string;   // 16 bytes
  initUrl:     string;   // hosted checkout URL (browser auto-POST target)
  verifyUrl:   string;   // server-to-server /status/verify
  refundUrl:   string;   // server-to-server /refund
  returnUrl:   string;   // our return endpoint (echoed back in init payload)
}

let cached: SabPaisaConfig | null = null;

export function sabpaisaConfig(): SabPaisaConfig {
  if (cached) return cached;

  const need = (key: string): string => {
    const v = (process.env[key] ?? "").trim();
    if (!v) throw new Error(`Missing env var ${key} — required for SabPaisa integration`);
    return v;
  };

  const authKey = need("SABPAISA_AUTH_KEY");
  const authIv  = need("SABPAISA_AUTH_IV");
  // AES-128 requires exactly 16-byte key + IV. Fail fast with a clear
  // message if they were pasted in truncated — SabPaisa's error for a
  // malformed payload is a cryptic "invalid encdata" that loses hours
  // to diagnose in UAT.
  if (Buffer.byteLength(authKey, "utf8") !== 16) {
    throw new Error(`SABPAISA_AUTH_KEY must be exactly 16 bytes (got ${Buffer.byteLength(authKey, "utf8")}) — SabPaisa uses AES-128-CBC`);
  }
  if (Buffer.byteLength(authIv, "utf8") !== 16) {
    throw new Error(`SABPAISA_AUTH_IV must be exactly 16 bytes (got ${Buffer.byteLength(authIv, "utf8")}) — SabPaisa uses AES-128-CBC`);
  }

  const cfg: SabPaisaConfig = {
    clientCode:  need("SABPAISA_CLIENT_CODE"),
    username:    need("SABPAISA_USERNAME"),
    password:    need("SABPAISA_PASSWORD"),
    authKey,
    authIv,
    initUrl:     need("SABPAISA_INIT_URL"),
    verifyUrl:   need("SABPAISA_VERIFY_URL"),
    refundUrl:   need("SABPAISA_REFUND_URL"),
    returnUrl:   need("SABPAISA_RETURN_URL"),
  };

  cached = cfg;
  return cfg;
}

// Test hook — lets a future unit test blow away the cache if it mutates
// process.env between cases. Not called from runtime code.
export function _resetSabPaisaConfigCache() {
  cached = null;
}
