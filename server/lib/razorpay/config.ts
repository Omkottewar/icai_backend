// Razorpay environment configuration.
//
// Razorpay credentials live in env vars only — never in site_settings, never
// in the DB, never in the frontend bundle (the key_id is handed to the
// browser at order-creation time so Checkout.js can authenticate against
// Razorpay; the key_secret stays server-side). The runtime fails fast if a
// required var is missing so an incomplete deploy can't silently fall back
// to test credentials or no-op the integration.
//
// Env vars (see .env.example):
//   RAZORPAY_KEY_ID          — rzp_test_... (test mode) or rzp_live_... (prod)
//   RAZORPAY_KEY_SECRET      — the matching API secret (server-side only)
//   RAZORPAY_WEBHOOK_SECRET  — separate secret configured in the Razorpay
//                              dashboard (Settings → Webhooks) and used to
//                              verify X-Razorpay-Signature on incoming
//                              server-to-server pushes. Distinct from
//                              KEY_SECRET; rotate independently.

export interface RazorpayConfig {
  keyId:          string;
  keySecret:      string;
  webhookSecret:  string;
  apiBase:        string;   // https://api.razorpay.com
}

let cached: RazorpayConfig | null = null;

export function razorpayConfig(): RazorpayConfig {
  if (cached) return cached;

  const need = (key: string): string => {
    const v = (process.env[key] ?? "").trim();
    if (!v) throw new Error(`Missing env var ${key} — required for Razorpay integration`);
    return v;
  };

  const cfg: RazorpayConfig = {
    keyId:         need("RAZORPAY_KEY_ID"),
    keySecret:     need("RAZORPAY_KEY_SECRET"),
    webhookSecret: need("RAZORPAY_WEBHOOK_SECRET"),
    apiBase:       (process.env.RAZORPAY_API_BASE ?? "https://api.razorpay.com").replace(/\/$/, ""),
  };

  cached = cfg;
  return cfg;
}

// Test hook — lets a future unit test blow away the cache if it mutates
// process.env between cases. Not called from runtime code.
export function _resetRazorpayConfigCache() {
  cached = null;
}
