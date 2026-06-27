// One-shot smoke test for the Resend integration via lib/email.ts.
// Run with:  node --experimental-vm-modules --import tsx scripts/test-resend.mjs
// Or simply: npx tsx scripts/test-resend.mjs
import "dotenv/config";
import { sendEmail } from "../server/lib/email.ts";

const to = process.argv[2] || process.env.DEV_EMAIL_OVERRIDE || process.env.SMTP_USER;
if (!to) {
  console.error("Pass a recipient: npx tsx scripts/test-resend.mjs you@example.com");
  process.exit(1);
}

console.log(`Sending test email to: ${to}`);
const result = await sendEmail({
  to,
  subject: "Resend smoke test from ICAI Nagpur backend",
  body: "If you can read this, Resend is wired into the backend correctly.\n\nSent via server/lib/email.ts → Resend SDK.",
  html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <h2 style="color:#0b3d91;margin:0 0 8px;">Resend wiring works ✅</h2>
    <p style="color:#374151;line-height:1.55;">If you're reading this, the ICAI Nagpur backend successfully sent an email through <strong>Resend</strong> using your verified domain <code>icainagpur.in</code>.</p>
    <p style="color:#6b7280;font-size:13px;margin-top:24px;">Sent via <code>server/lib/email.ts</code> · ${new Date().toISOString()}</p>
  </div>`,
});

console.log("Result:", JSON.stringify(result, null, 2));
process.exit(result.status === "sent" ? 0 : 1);
