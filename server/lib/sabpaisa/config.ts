// SabPaisa environment configuration.
//
// All SabPaisa secrets (client code, username, password, AES key + IV) live
// in environment variables — never in site_settings, never in the database,
// never in the frontend bundle. The runtime fails fast if any required var
// is missing, so an incomplete deploy can't silently fall back to UAT keys
// or no-op the integration.
//
// Env vars (see .env.example or README):
//   SABPAISA_CLIENT_CODE       — e.g. "NBW" (live) or "NITE5" (UAT PHP7+)
//   SABPAISA_USERNAME          — transUserName
//   SABPAISA_PASSWORD          — transUserPassword
//   SABPAISA_AUTH_KEY          — 16-byte AES key
//   SABPAISA_AUTH_IV           — 16-byte AES IV
//   SABPAISA_INIT_URL          — hosted-checkout POST endpoint
//   SABPAISA_VERIFY_URL        — double-verification JSON endpoint
//   SABPAISA_REFUND_URL        — refund API endpoint (optional until live)
//   SABPAISA_RETURN_URL        — our return URL SabPaisa redirects to
//                                (e.g. ${APP_URL}/api/payments/return)
//
// The last three default to the UAT URLs documented by SabPaisa so a
// first-time run against the UAT creds works without extra config.

export interface SabPaisaConfig {
  clientCode:   string;
  username:     string;
  password:     string;
  authKey:      string;
  authIv:       string;
  initUrl:      string;
  verifyUrl:    string;
  refundUrl:    string;
  returnUrl:    string;
}

let cached: SabPaisaConfig | null = null;

export function sabpaisaConfig(): SabPaisaConfig {
  if (cached) return cached;

  const need = (key: string): string => {
    const v = (process.env[key] ?? "").trim();
    if (!v) throw new Error(`Missing env var ${key} — required for SabPaisa integration`);
    return v;
  };

  const optional = (key: string, fallback: string): string => {
    const v = (process.env[key] ?? "").trim();
    return v || fallback;
  };

  const cfg: SabPaisaConfig = {
    clientCode: need("SABPAISA_CLIENT_CODE"),
    username:   need("SABPAISA_USERNAME"),
    password:   need("SABPAISA_PASSWORD"),
    authKey:    need("SABPAISA_AUTH_KEY"),
    authIv:     need("SABPAISA_AUTH_IV"),
    // SabPaisa's AES-128-CBC implementation requires exactly 16-byte key + IV
    // for the PHP7+ scheme. A longer/shorter value would silently produce a
    // ciphertext SabPaisa can't decrypt — hard to debug later. Guard here.
    // Defaults point at SabPaisa's current Staging / UAT endpoints
    // (confirmed against their official integration docs, Staging & Live
    // URLs page, last updated 2024-11-12). The older `uatsp.sabpaisa.in`
    // URL from Neha's Oct 7 2026 mail has been decommissioned and no
    // longer resolves in DNS. Flip the env var to the live URL
    // (securepay.sabpaisa.in instead of stage-securepay) at go-live.
    initUrl:   optional("SABPAISA_INIT_URL",   "https://stage-securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=1"),
    verifyUrl: optional("SABPAISA_VERIFY_URL", "https://txnenquiry.sabpaisa.in/SabPaisaDoubleVerification/status/verify"),
    refundUrl: optional("SABPAISA_REFUND_URL", "https://txnenquiry.sabpaisa.in/SabPaisaDoubleVerification/refund/txnRefund"),
    returnUrl: need("SABPAISA_RETURN_URL"),
  };

  if (cfg.authKey.length !== 16) {
    throw new Error(`SABPAISA_AUTH_KEY must be exactly 16 characters (AES-128-CBC); got ${cfg.authKey.length}`);
  }
  if (cfg.authIv.length !== 16) {
    throw new Error(`SABPAISA_AUTH_IV must be exactly 16 characters (AES-128-CBC); got ${cfg.authIv.length}`);
  }

  cached = cfg;
  return cfg;
}

// Test hook — lets a future unit test blow away the cache if it mutates
// process.env between cases. Not called from runtime code.
export function _resetSabPaisaConfigCache() {
  cached = null;
}
