// Payment provider dispatcher.
//
// The branch runs TWO payment gateways side-by-side — Razorpay and SabPaisa
// — so it can flip between them in minutes via an env var when one has an
// outage, a pending activation, or needs rotation. Exactly one provider is
// "active" at a time; new /initiate calls go through it. Historical rows
// keep their original provider label (see payments.provider) so inbound
// webhooks for stale orders always route to the right handler regardless
// of which provider is currently active.
//
// Selection: env var PAYMENT_PROVIDER = "razorpay" (default) | "sabpaisa".
// Unset → razorpay (behaviour before this file existed, so a deploy that
// forgets to set it stays on the historical default).
//
// Switching is a single command:
//   fly secrets set PAYMENT_PROVIDER=sabpaisa -a icai
// Fly rolling-restarts; the next /initiate call lands on SabPaisa.
//
// Both provider modules must stay functional at all times. Removing one
// is a schema + code change, not a runtime config change.

export type PaymentProvider = "razorpay" | "sabpaisa";

const VALID: PaymentProvider[] = ["razorpay", "sabpaisa"];

// Resolved at every call, not cached — lets tests mutate process.env
// between cases without blowing away a module-level cache. The cost is
// one trim+toLowerCase per /initiate call, which is dwarfed by the
// surrounding DB and HTTP work.
export function activePaymentProvider(): PaymentProvider {
  const raw = (process.env.PAYMENT_PROVIDER ?? "").trim().toLowerCase();
  if (!raw) return "razorpay";
  if ((VALID as string[]).includes(raw)) return raw as PaymentProvider;
  // Unknown value — fail loud. A typo in the env var shouldn't silently
  // fall through to the default and leave ops wondering why the flip
  // didn't take. The caller (payments.ts, registrations.ts, employer.ts)
  // surfaces this as a 503 "payments misconfigured".
  throw new Error(
    `PAYMENT_PROVIDER='${raw}' is not supported — set to one of: ${VALID.join(", ")}`,
  );
}

// Convenience — throws a human-readable error if the active provider's
// env config is missing. Called from /initiate before creating a payment
// row so we don't leave an orphan 'pending' row when the credentials
// aren't deployed yet.
export function assertActiveProviderConfigured(): void {
  const provider = activePaymentProvider();
  if (provider === "razorpay") {
    // Lazy-import to avoid loading SabPaisa modules just to validate
    // Razorpay. Each config() throws fast on a missing env var.
    const { razorpayConfig } = require("./razorpay/config.js");
    razorpayConfig();
  } else {
    const { sabpaisaConfig } = require("./sabpaisa/config.js");
    sabpaisaConfig();
  }
}
