// Sentry MUST be imported and initialised before any other module that we
// want it to instrument (Express, http, postgres, etc.). v10 uses
// OpenTelemetry under the hood — patching happens on `Sentry.init()`, so
// this file is imported at the very top of server/index.ts.
//
// Behaviour:
//   • No-op when SENTRY_DSN is unset (dev machines, PR previews without a
//     secret) — the SDK simply doesn't send events.
//   • Additionally gated on NODE_ENV=production so local runs with a real
//     DSN in .env don't burn the error quota. Flip
//     SENTRY_ENABLE_IN_DEV=1 to override for one-off integration tests.
import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN?.trim();
const enableInDev = process.env.SENTRY_ENABLE_IN_DEV === "1";
const isProd = process.env.NODE_ENV === "production";

if (dsn && (isProd || enableInDev)) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Strip common noisy paths from performance traces.
    tracePropagationTargets: [/^https?:\/\/(localhost|.*\.icainagpur\.in)/],
  });
}
