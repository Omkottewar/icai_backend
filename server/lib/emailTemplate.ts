// Branded HTML envelope for outbound emails.
//
// Matches the Auth0 verification email layout: centred logo, eyebrow,
// large centred title, body text, primary CTA button, fallback URL,
// divider, centred branch footer, transactional sign-off.
//
// Templates in notification_templates are stored as plain text — the
// admin edits them in /admin/notification-templates as multi-line
// strings. This module wraps that text in a polished HTML shell.
// Plain-text body is still sent in the email's `text` part so screen
// readers and text-only clients get a clean fallback.
//
// Why inline CSS only:
//   Gmail strips <style> blocks. Outlook strips margin/padding from <p>.
//   Inline attributes are the most reliable cross-client baseline.

const BRAND_NAME      = "Nagpur Branch of WIRC of ICAI";
const BRAND_EYEBROW   = "NAGPUR BRANCH OF WIRC OF ICAI";
const BRAND_ADDRESS   = "ICAI Bhawan, 20/1, Behind Vijayanand Society, Dhantoli, Nagpur — 440012";
const BRAND_EMAIL     = "nagpur@icai.in";
const SENDER_EMAIL    = process.env.EMAIL_FROM_ADDR || "no-reply@icainagpur.in";

// Logo hosted on Supabase Storage via scripts/upload-email-logo.mjs. Override
// per-environment by setting EMAIL_LOGO_URL — useful if you re-host or A/B
// test a different logo without redeploying the backend.
const LOGO_URL = process.env.EMAIL_LOGO_URL
  || "https://ohpjavugvpqjbloxzluf.supabase.co/storage/v1/object/public/public-content/email-assets/icai-nagpur-logo.png";

// Palette mirrors the frontend's ICAI navy + slate scale (--primary etc).
const C_PRIMARY     = "#1e40af";
const C_PRIMARY_DK  = "#1e3a8a";
const C_TEXT        = "#111827";
const C_TEXT_SOFT   = "#374151";
const C_MUTED       = "#6b7280";
const C_MUTED_SOFT  = "#9ca3af";
const C_PAGE_BG     = "#f6f8fb";
const C_CARD_BG     = "#ffffff";
const C_BORDER      = "#e5e7eb";
const C_DIVIDER     = "#e5e7eb";
const C_LINK        = "#1d4ed8";

const URL_RE = /\b(https?:\/\/[^\s<>"')\]]+[^\s<>"').,;:!?\]])/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Encode markdown-style **bold** as <strong>, then linkify URLs, then
// remember the first URL for the CTA button.
function formatParagraph(text: string, accumUrl: { first: string | null }): string {
  let html = escapeHtml(text);
  // **bold** → <strong>. Greedy but bounded to one paragraph so it can't
  // span across blocks. Admins can use this for emphasis (firm name,
  // ticket number) without HTML knowledge.
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong style="color:' + C_TEXT + ';">$1</strong>');
  html = html.replace(URL_RE, (raw) => {
    // The matched URL has already been entity-encoded; only `&` matters
    // for href correctness. URLs shouldn't contain < > " ' un-encoded.
    const href = raw.replace(/&amp;/g, "&");
    if (!accumUrl.first) accumUrl.first = href;
    return `<a href="${href}" style="color:${C_LINK};text-decoration:underline;word-break:break-all;">${raw}</a>`;
  });
  // In-paragraph line breaks become <br>.
  return html.replace(/\r?\n/g, "<br>");
}

// Heuristic for the button label. Looks at "<phrase>: <url>" or
// "<phrase> here: <url>" on the line containing firstUrl. Falls back to
// "Open" if no phrase is found.
function deriveButtonLabel(body: string, firstUrl: string): string {
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf(firstUrl);
    if (idx < 0) continue;
    const before = line.slice(0, idx).trim();
    const m = before.match(/([A-Z][a-zA-Z ]{2,30})\s*[:\-—]\s*$/);
    if (m) {
      const label = m[1].trim()
        .replace(/^Click\s+here\s+to\s+/i, "")
        .replace(/^here\s*$/i, "Open")
        .trim();
      return label.length <= 40 ? label : "Open";
    }
    return "Open";
  }
  return "Open";
}

export type RenderEmailHtmlInput = {
  subject: string;
  body: string;
  /** Optional pre-rendered HTML. When set, returned verbatim. */
  html?: string;
  /** Override the centred H1. Defaults to subject. */
  heading?: string;
  /** Override the CTA URL (otherwise the first URL in the body is used). */
  ctaUrl?: string;
  /** Override the CTA button label. */
  ctaLabel?: string;
};

export function renderEmailHtml(input: RenderEmailHtmlInput): string {
  if (input.html) return input.html;

  const subject = input.subject || "";
  const body    = input.body    || "";

  // Split on blank lines → paragraphs.
  const paragraphs = body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Last paragraph beginning with em-dash is the sign-off — strip it from
  // the body and rely on the envelope's footer instead, so users don't
  // see the branch name twice.
  let signoffIdx = -1;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (/^[—–-]\s+/.test(paragraphs[i])) { signoffIdx = i; break; }
  }
  if (signoffIdx >= 0) paragraphs.splice(signoffIdx, 1);

  const isGreeting = (p: string) => /^(Hi|Hello|Dear)\b/.test(p);

  const accumUrl = { first: null as string | null };
  const paragraphHtml = paragraphs.map((p) => {
    const inner = formatParagraph(p, accumUrl);
    const greeting = isGreeting(p);
    const size  = greeting ? "16px" : "15px";
    const color = greeting ? C_TEXT : C_TEXT_SOFT;
    const weight = greeting ? 500 : 400;
    return `<p style="margin:0 0 18px;font-size:${size};line-height:1.65;color:${color};font-weight:${weight};">${inner}</p>`;
  }).join("");

  const ctaUrl   = input.ctaUrl   ?? accumUrl.first;
  const ctaLabel = input.ctaLabel ?? (ctaUrl ? deriveButtonLabel(body, ctaUrl) : null);

  // CTA + fallback URL block — only when we have an action link.
  const ctaBlock = ctaUrl && ctaLabel ? `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:8px 0 24px;">
      <tr>
        <td align="center">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" bgcolor="${C_PRIMARY}" style="border-radius:6px;">
                <a href="${ctaUrl.replace(/&amp;/g, "&")}"
                   style="display:inline-block;min-width:240px;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.01em;">
                  ${escapeHtml(ctaLabel)}
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 6px;font-size:13px;color:${C_MUTED};line-height:1.5;">
      If the button above doesn't work, copy and paste this link into your browser:
    </p>
    <p style="margin:0 0 20px;font-size:13px;line-height:1.5;word-break:break-all;">
      <a href="${ctaUrl.replace(/&amp;/g, "&")}" style="color:${C_LINK};text-decoration:underline;">
        ${escapeHtml(ctaUrl)}
      </a>
    </p>
  ` : "";

  const heading = input.heading || subject;
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C_PAGE_BG};font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C_TEXT};-webkit-font-smoothing:antialiased;">

  <!-- Preheader: hidden first-screen preview text shown in inbox row. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
    ${escapeHtml(subject)} — ${escapeHtml(BRAND_NAME)}
  </div>

  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background:${C_PAGE_BG};padding:32px 12px;">
    <tr>
      <td align="center">

        <!-- Card -->
        <table role="presentation" width="560" border="0" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${C_CARD_BG};border:1px solid ${C_BORDER};border-radius:12px;">

          <!-- Logo + eyebrow -->
          <tr>
            <td align="center" style="padding:36px 32px 12px;">
              <img src="${LOGO_URL}" alt="ICAI" width="64" height="64"
                   style="display:block;margin:0 auto 18px;width:64px;height:64px;border:0;outline:none;text-decoration:none;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;color:${C_PRIMARY};text-transform:uppercase;">
                ${escapeHtml(BRAND_EYEBROW)}
              </div>
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td align="center" style="padding:14px 40px 28px;">
              <h1 style="margin:0;font-size:24px;line-height:1.3;color:${C_TEXT};font-weight:700;letter-spacing:-0.01em;">
                ${escapeHtml(heading)}
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:0 40px 4px;">
              ${paragraphHtml}
              ${ctaBlock}
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <div style="border-top:1px solid ${C_DIVIDER};height:0;line-height:0;font-size:0;">&nbsp;</div>
            </td>
          </tr>

          <!-- Branch footer -->
          <tr>
            <td align="center" style="padding:24px 40px 8px;font-size:13px;line-height:1.65;color:${C_MUTED};">
              <strong style="color:${C_TEXT};font-size:14px;">${escapeHtml(BRAND_NAME)}</strong><br>
              ${escapeHtml(BRAND_ADDRESS)}<br>
              <a href="mailto:${BRAND_EMAIL}" style="color:${C_LINK};text-decoration:none;">${escapeHtml(BRAND_EMAIL)}</a>
            </td>
          </tr>

          <!-- Transactional sign-off -->
          <tr>
            <td align="center" style="padding:14px 40px 32px;font-size:11px;line-height:1.6;color:${C_MUTED_SOFT};">
              This is a transactional email sent to keep you updated on your activity with the branch.<br>
              Sent from <a href="mailto:${SENDER_EMAIL}" style="color:${C_MUTED};text-decoration:none;">${escapeHtml(SENDER_EMAIL)}</a> · Please do not reply to this message.
            </td>
          </tr>

        </table>

        <!-- Copyright outside the card, like Auth0's layout -->
        <p style="margin:14px 0 0;font-size:11px;color:${C_MUTED_SOFT};">
          © ${year} ${escapeHtml(BRAND_NAME)}
        </p>

      </td>
    </tr>
  </table>
</body>
</html>`;
}
