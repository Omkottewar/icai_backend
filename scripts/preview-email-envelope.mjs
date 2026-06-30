// Sends representative envelope-wrapped emails so the developer can eyeball
// the rendered HTML in their inbox. Three samples per run:
//   1. CTA-led: event registration (most common shape — primary action link)
//   2. Auth-flow: password reset (security messaging + CTA)
//   3. No-CTA: CABF receipt (receipt-style, no action link)
//
// Run:   npx tsx scripts/preview-email-envelope.mjs [recipient]
// Recipient defaults to DEV_EMAIL_OVERRIDE.

import "dotenv/config";
import { sendEmail } from "../server/lib/email.ts";

const to = process.argv[2] || process.env.DEV_EMAIL_OVERRIDE;
if (!to) {
  console.error("Pass a recipient or set DEV_EMAIL_OVERRIDE in .env");
  process.exit(1);
}

const SAMPLES = [
  {
    subject: "You're registered — GST Refresher Workshop",
    body: `Hi Om,

Your spot for **GST Refresher Workshop** on Mon, 15 Jul 2026 at 10:00 AM (ICAI Bhawan, Dhantoli) is confirmed. 4 CPE hours will be credited on attendance.

View event: https://nagpur.icai.org/events/gst-refresher

Add to calendar: https://nagpur.icai.org/cal/abc

Questions? Just reply to this email.

— ICAI Nagpur Branch (WIRC)`,
  },
  {
    subject: "Reset your password",
    body: `Hi Om,

We received a request to reset your password. The link below is valid for 30 minutes.

Reset password: https://nagpur.icai.org/reset?token=xyz

If you didn't request this, you can safely ignore this email — your password stays the same.

— ICAI Nagpur Branch (WIRC)`,
  },
  {
    subject: "Thank you for your CABF contribution",
    body: `Hi Om,

We gratefully acknowledge your CA Benevolent Fund contribution of **₹5,000** on 28 Jun 2026 (Ref: CABF-2026-0142).

Your 80G receipt will be mailed by ICAI HO.

— ICAI Nagpur Branch (WIRC)`,
  },
];

let okCount = 0;
for (const s of SAMPLES) {
  console.log(`→ ${s.subject}`);
  const res = await sendEmail({ to, subject: s.subject, body: s.body });
  console.log(`  ${res.status}${res.status === "sent" ? ` (${res.messageId})` : ""}`);
  if (res.status === "sent") okCount++;
}
console.log(`\n${okCount}/${SAMPLES.length} sent.`);
process.exit(okCount === SAMPLES.length ? 0 : 1);
