// Checks the server's environment variables without printing secrets.
//
//   fly ssh console -a icai -C "node scripts/check-env.mjs"
//
// Plain settings (URLs, names) are shown in full; secrets show only
// "set (N chars)". Exit code 1 if anything is wrong.

const env = process.env;
const prod = env.NODE_ENV === "production";
const rows = [];
let problems = 0;

const show = (v) => (v === undefined || v === "" ? "(not set)" : v);
const mask = (v) => (v === undefined || v === "" ? "(not set)" : `set (${v.length} chars)`);
function add(name, value, status, note = "") {
  if (status === "FAIL") problems++;
  rows.push({ name, value, status, note });
}
const isUrl = (v) => { try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; } };
const localhost = (v) => /localhost|127\.0\.0\.1/.test(v ?? "");

// name, secret?, required?, extra check → [status, note] | null
const checks = [
  ["NODE_ENV", false, true, (v) => v === "production" ? null : ["WARN", "should be production on Fly"]],
  ["PORT", false, false, null],
  ["DATABASE_URL", true, true, (v) => /^postgres(ql)?:\/\//.test(v) ? null : ["FAIL", "should start with postgres://"]],
  ["JWT_SECRET", true, true, (v) => v.length >= 32 ? null : ["FAIL", "must be at least 32 characters"]],

  ["APP_URL", false, true, (v) => !isUrl(v) ? ["FAIL", "not a URL"] : prod && localhost(v) ? ["FAIL", "localhost in production"] : v.endsWith("/") ? ["WARN", "remove the trailing /"] : null],
  ["API_URL", false, false, (v) => !isUrl(v) ? ["FAIL", "not a URL"] : prod && localhost(v) ? ["FAIL", "localhost in production"]
    : env.APP_URL && new URL(v).host !== new URL(env.APP_URL).host ? ["WARN", `different site from APP_URL (${env.APP_URL}) — usually the same`] : null],

  ["AUTH0_DOMAIN", false, true, (v) => /^https?:\/\//.test(v) ? ["WARN", "usually just the host, e.g. tenant.us.auth0.com"] : null],
  ["AUTH0_CLIENT_ID", false, true, null],
  ["AUTH0_CLIENT_SECRET", true, true, null],
  ["AUTH0_AUDIENCE", false, false, null],
  ["AUTH0_CONNECTION", false, true, null],
  ["AUTH0_CALLBACK_URL", false, true, (v) => {
    if (!isUrl(v)) return ["FAIL", "not a URL"];
    if (prod && localhost(v)) return ["FAIL", "localhost in production — Google sign-in returns to localhost"];
    if (!v.endsWith("/api/auth/callback")) return ["FAIL", "must end with /api/auth/callback"];
    if (env.APP_URL && isUrl(env.APP_URL) && new URL(v).host !== new URL(env.APP_URL).host)
      return ["FAIL", `must be on the same site as APP_URL (${env.APP_URL}) or the login cookie won't match`];
    return null;
  }],

  ["RESEND_API_KEY", true, false, (v) => v.startsWith("re_") ? null : ["WARN", "Resend keys usually start with re_"]],
  ["EMAIL_FROM", false, true, null],

  ["SUPABASE_URL", false, true, (v) => !isUrl(v) ? ["FAIL", "not a URL"]
    : env.SUPABASE_PROJECT_REF && !v.includes(env.SUPABASE_PROJECT_REF) ? ["FAIL", `doesn't match SUPABASE_PROJECT_REF (${env.SUPABASE_PROJECT_REF})`] : null],
  ["SUPABASE_PROJECT_REF", false, false, null],
  ["SUPABASE_SERVICE_ROLE_KEY", true, true, null],
  ["SUPABASE_ANON_KEY", true, false, null],
  ["SUPABASE_BUCKET", false, false, null],
  ["STORAGE_BUCKET", false, false, null],

  ["SABPAISA_ENV", false, false, (v) => ["production", "prod", "live", "staging", "stage", "uat"].includes(v.toLowerCase()) ? null : ["FAIL", "use production or staging"]],
  ["SABPAISA_CLIENT_CODE", false, true, null],
  ["SABPAISA_USERNAME", false, true, (v) => v !== v.trim() ? ["FAIL", "has spaces at the start or end"] : null],
  ["SABPAISA_PASSWORD", true, true, null],
  ["SABPAISA_AUTH_KEY", true, true, (v) => v.length === 16 || (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, "base64").length === 32) ? null : ["FAIL", "must be the 16-character key or a base64 AES-256 key"]],
  ["SABPAISA_AUTH_IV", true, true, null],
  ["SABPAISA_MCC", false, false, (v) => /^\d+$/.test(v) ? null : ["FAIL", "must be numeric"]],
  ["SABPAISA_CALLBACK_URL", false, false, (v) => !isUrl(v) ? ["FAIL", "not a URL"] : prod && localhost(v) ? ["FAIL", "localhost in production"]
    : !v.endsWith("/api/payments/sabpaisa/return") ? ["WARN", "usually ends with /api/payments/sabpaisa/return"] : null],

  ["OPENAI_API_KEY", true, false, null],
  ["OPENAI_CHAT_MODEL", false, false, null],
  ["EMBEDDING_MODEL", false, false, null],
  ["VAPID_PUBLIC_KEY", false, false, null],
  ["VAPID_PRIVATE_KEY", true, false, null],
  ["VAPID_SUBJECT", false, false, (v) => /^(mailto:|https:)/.test(v) ? null : ["WARN", "should start with mailto: or https:"]],
  ["SENTRY_DSN", true, false, null],
];

for (const [name, secret, required, check] of checks) {
  const v = env[name];
  const shown = secret ? mask(v) : show(v);
  if (v === undefined || v === "") {
    add(name, shown, required ? "FAIL" : "—", required ? "required but not set" : "optional, not set");
    continue;
  }
  const r = check ? check(v) : null;
  add(name, shown, r ? r[0] : "OK", r ? r[1] : "");
}

// Settings that are no longer used by the code.
for (const old of ["PAYMENT_PROVIDER", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
  "SABPAISA_INIT_URL", "SABPAISA_VERIFY_URL", "SABPAISA_REFUND_URL", "RECAPTCHA_SECRET_KEY", "RECAPTCHA_MIN_SCORE"]) {
  if (env[old] !== undefined) add(old, "set", "WARN", "no longer used — can be removed");
}

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.value}${r.note ? `   ← ${r.note}` : ""}`);
}
console.log(problems ? `\n${problems} problem(s) found.` : "\nNo problems found.");
process.exitCode = problems ? 1 : 0;
