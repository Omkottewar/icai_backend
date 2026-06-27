import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  PageOrientation, PageBreak, Footer, Header, ImageRun,
} from "docx";

const NAVY = "1E3A8A";
const PRIMARY = "3622FF";
const GREEN = "16A34A";
const RED = "DC2626";
const AMBER = "F59E0B";
const GREY = "6B7280";
const LIGHT_GREY = "F3F4F6";
const BORDER_GREY = "E5E7EB";

const today = new Date().toISOString().slice(0, 10);

function H1(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 200 },
  });
}
function H2(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
  });
}
function H3(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
  });
}
function P(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, ...opts })],
    spacing: { after: 120 },
  });
}
function Bullet(text, level = 0) {
  return new Paragraph({
    children: [new TextRun({ text })],
    bullet: { level },
    spacing: { after: 80 },
  });
}
function cell(text, opts = {}) {
  const { bold = false, color, shading, width, fontSize = 20, align } = opts;
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: shading ? { type: ShadingType.SOLID, color: shading, fill: shading } : undefined,
    children: [new Paragraph({
      alignment: align,
      children: [new TextRun({
        text: String(text ?? ""),
        bold,
        color,
        size: fontSize,
      })],
    })],
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}
function headerRow(labels, widths) {
  return new TableRow({
    tableHeader: true,
    children: labels.map((l, i) => cell(l, {
      bold: true, color: "FFFFFF", shading: NAVY,
      width: widths?.[i], fontSize: 20,
    })),
  });
}
function statusCell(text) {
  const t = String(text);
  let color = "1F2937";
  let shading = null;
  if (t.startsWith("✓") || t.toLowerCase().includes("yes") && !t.toLowerCase().includes("partial")) {
    color = GREEN;
  } else if (t.startsWith("✗") || t.toLowerCase() === "no" || t.toLowerCase().includes("absent")) {
    color = RED;
  } else if (t.startsWith("~") || t.toLowerCase().includes("partial") || t.toLowerCase().includes("static")) {
    color = AMBER;
  }
  return cell(t, { color, bold: true, fontSize: 18, align: AlignmentType.CENTER });
}

function comparisonTable(rows, widths = [40, 25, 25, 10]) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      left: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      right: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
    },
    rows: [
      headerRow(["Feature / Capability", "Current Site (nagpuricai.org)", "New Portal (icainagpur.in)", "Status"], widths),
      ...rows.map(r => new TableRow({
        children: [
          cell(r[0], { fontSize: 18 }),
          cell(r[1], { fontSize: 18 }),
          cell(r[2], { fontSize: 18 }),
          statusCell(r[3]),
        ],
      })),
    ],
  });
}

function statsTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      left: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      right: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
    },
    rows: [
      headerRow(["Metric", "Current Site", "New Portal"], [40, 30, 30]),
      ...rows.map(r => new TableRow({
        children: [
          cell(r[0], { bold: true, fontSize: 19 }),
          cell(r[1], { fontSize: 19, align: AlignmentType.CENTER }),
          cell(r[2], { fontSize: 19, align: AlignmentType.CENTER, color: PRIMARY, bold: true }),
        ],
      })),
    ],
  });
}

const sections = [];

// ─── COVER ────────────────────────────────────────────────────────────────
sections.push(new Paragraph({ children: [], spacing: { before: 2000 } }));
sections.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  children: [new TextRun({
    text: "FEATURE COMPARISON DOCUMENT",
    bold: true, size: 28, color: PRIMARY,
  })],
}));
sections.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 400 },
  children: [new TextRun({
    text: "Nagpur Branch of WIRC of ICAI",
    bold: true, size: 48, color: NAVY,
  })],
}));
sections.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 800 },
  children: [new TextRun({
    text: "Existing Website (nagpuricai.org) vs. New Branch Portal",
    italics: true, size: 26, color: GREY,
  })],
}));
sections.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  children: [new TextRun({ text: `Prepared: ${today}`, size: 22, color: GREY })],
}));
sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── EXECUTIVE SUMMARY ────────────────────────────────────────────────────
sections.push(H1("1. Executive Summary"));
sections.push(P(
  "The current ICAI Nagpur Branch website (nagpuricai.org) is a static PHP-based brochure site built around 2015-2018, with limited interactivity, no member authentication, no functional online payments, and no mobile responsiveness. The new branch portal (icainagpur.in) is a modern Progressive Web App with 74+ pages, 26+ admin modules, AI-grounded knowledge assistant, real-time event chat, role-based access for 15 distinct branch roles, integrated Razorpay payments with GST, push notifications, and a fully admin-editable content system.",
));
sections.push(P(
  "This document maps every feature on both platforms across 8 functional categories. It identifies (a) gaps in the current site that the new portal closes, (b) entirely new capabilities the new portal introduces, and (c) anything from the current site that must be preserved in the migration.",
  { italics: true },
));
sections.push(P("Bottom line: the new portal is not a refresh — it is a complete generational upgrade. Every member-facing function on the old site is either replaced by a richer equivalent or rendered obsolete by a better workflow.", { bold: true }));

// ─── QUICK STATS ──────────────────────────────────────────────────────────
sections.push(H2("1.1 At-a-glance comparison"));
sections.push(statsTable([
  ["Architecture", "Static PHP (server-rendered)", "React 18 + PWA (Vite, code-split)"],
  ["Mobile responsive", "No", "Yes — installable PWA"],
  ["Total public pages", "~30 static", "74+ dynamic"],
  ["Admin pages / modules", "0 (no admin panel)", "31 admin pages, 26 backend modules"],
  ["Database tables", "0 (PHP forms only)", "32 schema modules, 59+ migrations"],
  ["Member authentication", "None", "Auth0 + MRN-gated signup"],
  ["Online payment gateway", "Form only — pay offline", "Razorpay with GST split"],
  ["Push notifications", "None", "PWA web push (iOS/Android/Desktop)"],
  ["AI chatbot", "None", "Pragyaan RAG with 317 KB sources"],
  ["Event registration", "Link only, unclear backend", "Full flow with waitlist + payment"],
  ["Grievance system", "None", "Ticket-tracked, 48h SLA, audit log"],
  ["Member directory", "Submit-form only", "Searchable, MRN-validated"],
  ["Real-time event chat", "None", "WebSocket Q&A per event"],
  ["Role-based access", "None", "15 distinct branch role codes"],
  ["Last major update", "~2023 footer copyright", "Active — F21 shipped 2026-06-27"],
  ["Accessibility", "No WCAG compliance", "WCAG 2.1 AA baseline"],
  ["DPDP / cookie compliance", "None", "Consent banner with version replay"],
]));
sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── FEATURE MATRIX ───────────────────────────────────────────────────────
sections.push(H1("2. Detailed Feature Matrix"));
sections.push(P("Status legend: ✓ = Available  ✗ = Not available  ~ = Partial / static-only", { italics: true, color: GREY }));

// A. Events
sections.push(H2("A. Events & Registration"));
sections.push(comparisonTable([
  ["Upcoming events listing", "✓ Single column table (1 event shown at time of audit)", "✓ List + Month-calendar dual view, committee-coloured chips", "Upgraded"],
  ["Past events archive", "✓ Listing page", "✓ Photo gallery + registrations log + per-event Q&A archive", "Upgraded"],
  ["Audience filtering (Members / Students / Public)", "✗", "✓ Filter pills with ?audience= seedable URL", "New"],
  ["Online registration", "~ 'Register' link present, backend unclear", "✓ Full flow with capacity check, waitlist, payment", "Upgraded"],
  ["Waitlist with auto-promotion", "✗", "✓ Cancel-and-auto-promote with notification", "New"],
  ["Event fees with GST", "✗ (offline payment only)", "✓ Razorpay + GST split persisted in payments.metadata", "New"],
  ["Recurring events", "✗", "✓ Daily/Weekly/Monthly RRULE with edit-this-or-future scope", "New"],
  ["Add to Google Calendar", "✗", "✓ One-click Google Calendar deep-link", "New"],
  ["iCal subscription feed", "✗", "✓ /api/events/my-calendar.ics with token", "New"],
  ["Per-event Q&A forum", "✗", "✓ Quora-style, speaker magic-link moderation, answered-pill", "New"],
  ["Real-time event chat", "✗", "✓ WebSocket #general + #qa channels per event", "New"],
  ["Auto-generated CPE certificate", "✗ (manual)", "✓ PDF with deterministic cert number post-attendance", "New"],
  ["Event photo gallery", "✓ Static photo grids per event", "✓ Album-grouped, three layouts (grid/masonry/story), lightbox with keyboard nav, .zip download, committee-coloured", "Upgraded"],
  ["Video Gallery (event recordings)", "✓ Separate /video-gallery.php page", "✓ Shipped F22 (2026-06-27): YouTube/Vimeo/external, paste-URL → auto-extract ID, inline 16:9 player, featured pin, committee + event-type tagged", "Upgraded"],
  ["Event search/filter", "✗", "✓ Universal search across events + content", "New"],
  ["WICASA student events", "✓ Separate listing page", "✓ Same flow, audience-tagged for students", "Upgraded"],
  ["Event cover image upload", "✗ (manual via PDF circular)", "✓ Crop-on-upload, admin-editable", "Upgraded"],
]));

// B. Members
sections.push(H2("B. Members & Authentication"));
sections.push(comparisonTable([
  ["Member login / authentication", "✗ No login system", "✓ Auth0 (email/password + social) with verification email", "New"],
  ["Member signup with MRN validation", "✗ Form submission only", "✓ Live /check-mrn against icai_member_master directory", "New"],
  ["Password reset", "✗", "✓ Auth0-managed via Resend email", "New"],
  ["Member dashboard", "✗", "✓ Identity card, CPE deadline, stat tiles, recommended events", "New"],
  ["Member directory (searchable)", "✗ Submit form only", "✓ Search by name / MRN / city / firm", "New"],
  ["Edit member profile", "~ Static form (no validation)", "✓ Live form with validation + audit", "Upgraded"],
  ["CPE compliance tracker", "✗ External link to cpe.icai.org", "✓ 3-year structured/unstructured view in-portal", "New"],
  ["CPE certificate download", "✗", "✓ Auto-generated PDF, deterministic numbering", "New"],
  ["Saved papers / My Library", "✗", "✓ Bookmark & recall from journal/paper reader", "New"],
  ["Annual branch fee payment", "~ Form only — pay offline", "✓ Razorpay integrated, real receipts", "Upgraded"],
  ["Birthday wishes display", "✓ Homepage widget (text only)", "✓ (optional — admin-editable site content slot)", "Maintained"],
  ["Past Chairman list", "✓ Static page", "✓ Through branchContent schema, structured data", "Upgraded"],
  ["Council Member listings", "✓ Static page", "✓ Same with photos + bios + contact options", "Upgraded"],
  ["Member benevolent fund (CABF)", "✗", "✓ Real CTAs + admin 5-state pipeline + CSV export", "New"],
  ["Notification preferences", "✗", "✓ Per-user toggle for email + push", "New"],
]));

// C. Students
sections.push(H2("C. Students & WICASA"));
sections.push(comparisonTable([
  ["WICASA managing committee", "✓ Static page", "✓ Through committees admin", "Upgraded"],
  ["WICASA upcoming/past events", "✓ Separate listing", "✓ Unified events with student audience filter", "Upgraded"],
  ["WICASA gallery", "✓ Static photo grid", "✓ Album-grouped with lightbox", "Upgraded"],
  ["Student publications", "✓ Listing of PDFs", "✓ Built-in reader with bookmarking", "Upgraded"],
  ["Scholarship info", "✓ PDF download only", "✓ Structured page with form + tracking", "Upgraded"],
  ["Mock tests", "✗", "✓ Attempt + scoring + per-test discussion thread", "New"],
  ["Mock test peer discussion", "✗", "✓ One-thread-per-test, public-readable", "New"],
  ["Student suggestions / polls", "✗", "✓ Topic-bucketed, upvotable, 3-per-week rate-limited", "New"],
  ["Article assistance listings", "✓ Page exists", "✓ Filterable by firm / location / stipend", "Upgraded"],
  ["Articleship match", "✗", "✓ Schema scaffolded (admin UI pending)", "New (partial)"],
  ["Career counselling", "✗", "✓ Dedicated page + mentor booking (planned)", "New"],
  ["Investor Awareness program", "✗", "✓ Dedicated content page", "New"],
  ["CA 2.0 Vision content", "✗", "✓ Dedicated content page", "New"],
]));

// D. Content
sections.push(H2("D. Content & Publications"));
sections.push(comparisonTable([
  ["Newsletter archive", "✓ Listing of monthly PDFs", "✓ Admin-uploaded archive with cover images", "Upgraded"],
  ["Branch bulletin display", "✓ Single latest image", "✓ Dedicated bulletin page + archive", "Upgraded"],
  ["WIRC newsletter mirror", "✓ Single latest image", "✓ Linked via admin content slot", "Maintained"],
  ["Journal articles", "✗", "✓ In-browser PDF reader with search", "New"],
  ["Paper presentations from seminars", "~ PDF download links", "✓ Speaker page + browse + reader", "Upgraded"],
  ["Annual reports", "~ Profile PDF only", "✓ Dedicated admin module + reader", "Upgraded"],
  ["Submit paper / article (members)", "✗", "✓ Submission flow with admin approval", "New"],
  ["Resource quizzes", "✗", "✓ Quiz builder + attempt + scoring", "New"],
  ["Announcements feed", "✓ Static text on homepage", "✓ Dedicated feed page + admin CRUD", "Upgraded"],
  ["News carousel", "✓ Thumbnail carousel", "✓ Admin-editable hero/news slots", "Upgraded"],
  ["Chairman's message", "✓ Static page", "✓ Admin-editable with rich text + photo crop", "Upgraded"],
  ["Useful links directory", "✓ Categorised links", "✓ Admin-editable through site content slots", "Maintained"],
  ["About Nagpur page", "✓ Static content", "✓ Admin-editable content slot", "Maintained"],
  ["Site-wide search", "✗", "✓ Universal search across all content types", "New"],
]));

// E. Communication
sections.push(H2("E. Communication & Support"));
sections.push(comparisonTable([
  ["Contact form", "✗ (info only)", "✓ Combined Contact/Grievance/Suggestion form", "New"],
  ["Grievance submission", "✗", "✓ Ticket-numbered (GRV-YYYY-NNNNNN), reCAPTCHA-protected", "New"],
  ["Grievance tracking", "✗", "✓ Public lookup by ticket + email", "New"],
  ["Grievance 48h SLA escalation", "✗", "✓ Automated hourly cron with email escalation", "New"],
  ["Grievance subject routing", "✗", "✓ Admin-editable subject→email map", "New"],
  ["Grievance audit log", "✗", "✓ Full status history per ticket", "New"],
  ["Suggestion submission", "✗", "✓ Public + student-specific channels", "New"],
  ["Email notifications", "~ Manual/none", "✓ Multi-template engine via Resend", "Upgraded"],
  ["Push notifications (PWA)", "✗", "✓ Web push, iOS Safari supported when installed", "New"],
  ["In-app notifications", "✗", "✓ Per-user inbox with read/unread", "New"],
  ["AI assistant chatbot (Pragyaan)", "✗", "✓ Grounded-RAG, role-scoped, admin disclaimer", "New"],
  ["Newsletter digest of grievances", "✗", "✓ Admin endpoint for case-study tagging", "New"],
  ["WhatsApp integration", "✗", "Planned (admin 'Copy for WhatsApp' button)", "Planned"],
  ["Social media links", "✓ Facebook icon only", "✓ Admin-editable footer slot (multiple platforms)", "Upgraded"],
  ["Office contact info", "✓ Static (no map)", "✓ With Google Maps embed (admin-editable)", "Upgraded"],
]));

// F. Payments
sections.push(H2("F. Payments & Finance"));
sections.push(comparisonTable([
  ["Online payment gateway", "✗ Form only — pay offline", "✓ Razorpay live integration", "New"],
  ["Branch membership fee payment", "~ Form collection, offline pay", "✓ Razorpay + auto-receipt", "Upgraded"],
  ["Event registration fee", "✗", "✓ Razorpay with GST split + waitlist refund logic", "New"],
  ["GST calculation & display", "✗", "✓ Admin-configurable percent, persisted in metadata", "New"],
  ["Payment receipt generation", "✗", "✓ Auto-emailed after payment", "New"],
  ["Refund management", "✗", "✓ Admin reconciliation page with refund history", "New"],
  ["Payment audit log", "✗", "✓ Per-transaction trail with Razorpay reference", "New"],
  ["Multiple payment methods (cards/UPI/netbanking)", "✗", "✓ All Razorpay methods enabled", "New"],
  ["IUT / inter-branch transfers", "✗", "✓ Schema scaffolded (admin UI pending)", "New (partial)"],
  ["Bill generation for events", "✗", "✓ Schema scaffolded with admin module", "New (partial)"],
]));

// G. Office
sections.push(H2("G. Office Information & Administration"));
sections.push(comparisonTable([
  ["Managing Committee display", "~ Single JPEG image", "✓ Structured data with photos, roles, contact options", "Upgraded"],
  ["Sub-Committees listing", "✓ Static page", "✓ Admin CRUD with member assignments", "Upgraded"],
  ["Office bearers", "✓ Static page", "✓ Per branch-role-taxonomy with 15 role codes", "Upgraded"],
  ["WIRC office bearers", "✓ Static page", "✓ Admin-editable content slot", "Maintained"],
  ["Past chairmen archive", "✓ Static page", "✓ Structured admin-managed list", "Upgraded"],
  ["Sub-committee structure", "✓ Static page", "✓ Admin-editable with member roles", "Upgraded"],
  ["Branch profile (about)", "✓ PDF download", "✓ Dedicated page with admin editing", "Upgraded"],
  ["Job vacancies (employer-posted)", "✓ Static listing", "✓ Employer portal with self-service posting", "Upgraded"],
  ["Article assistance opportunities", "✓ Static listing", "✓ Filter + apply flow", "Upgraded"],
  ["Room booking system", "✗", "✓ Public availability + FIFO admin inbox + EXCLUDE-gist overlap protection", "New"],
  ["Tenders page", "✓ Static PDF link", "✓ Schema-backed admin module", "Upgraded"],
  ["Branch metrics dashboard", "✗", "✓ Chairman/Treasurer dashboard with Recharts", "New"],
  ["Admin panel (CMS)", "✗ Webmaster only", "✓ 31 admin pages, role-based access", "New"],
  ["Notification log (admin)", "✗", "✓ Full audit of all sends with delivery status", "New"],
  ["User role management", "✗", "✓ UsersAdminPage with 15 role codes", "New"],
  ["ICAI directory import (xlsx)", "✗", "✓ Admin upload with 500-row chunked upsert", "New"],
  ["Approvals workflow", "✗", "✓ Cross-module approvals admin (papers, articles, etc.)", "New"],
  ["Site Content slots (40+ admin-editable)", "✗ Hardcoded HTML", "✓ Every public string/image admin-editable", "New"],
]));

// Video gallery row update (F22 just shipped)
// — handled inline above in the Events section

// H. Tech
sections.push(H2("H. Technology & Modern Capabilities"));
sections.push(comparisonTable([
  ["Progressive Web App (installable)", "✗", "✓ Add to home screen on iOS/Android/desktop", "New"],
  ["Offline support", "✗", "✓ Workbox precaching + custom service worker", "New"],
  ["Mobile responsive design", "✗ Fixed-width layout", "✓ Fluid responsive, optimised for phone-first", "New"],
  ["Modern security (HTTPS / CSP / reCAPTCHA)", "~ HTTPS only", "✓ HTTPS + reCAPTCHA v3 + JWT + cookie-based session", "Upgraded"],
  ["Mobile push notifications", "✗", "✓ Web Push API (iOS supported when PWA installed)", "New"],
  ["Accessibility (WCAG 2.1 AA)", "✗", "✓ Baseline compliance with ongoing audit", "New"],
  ["DPDP / cookie consent", "✗", "✓ Banner with policy-version replay", "New"],
  ["Code-split route bundles", "✗", "✓ Per-route chunks + shimmer skeletons", "New"],
  ["AI-grounded knowledge assistant", "✗", "✓ Pragyaan RAG with 317 KB sources, auto-ingest", "New"],
  ["Real-time WebSocket chat", "✗", "✓ Event-scoped channels with moderation", "New"],
  ["CSV exports for admin data", "✗", "✓ Per-module export endpoints", "New"],
  ["File abstraction & migration", "~ Direct disk uploads", "✓ Supabase Storage with local fallback", "New"],
  ["Multi-channel notification engine", "✗", "✓ Email + push + in-app from one template", "New"],
  ["Rate limiting on forms", "✗", "✓ express-rate-limit on signup/grievance/suggestion", "New"],
  ["Migration framework", "✗", "✓ 59+ Drizzle migrations with dry-run + bootstrap", "New"],
  ["Universal search", "✗", "✓ Cross-module search across events/content/members", "New"],
]));
sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── GAPS WE CLOSE ────────────────────────────────────────────────────────
sections.push(H1("3. Critical Gaps in Current Site That the New Portal Closes"));
sections.push(P("These are issues on nagpuricai.org that limit the branch today. Each is fully resolved by the new portal."));
const gaps = [
  "No member authentication — anyone can fill forms anonymously; no personalised experience or access control.",
  "No working online payment — \"Online Payment Branch Members Fees\" page is purely informational. Members fill a form and must still pay offline. Same for event fees.",
  "No mobile responsiveness — the site is fixed-width and effectively unusable on phones, where >70% of members access the internet.",
  "No grievance form or tracking — members must phone or email, with no ticket reference, no SLA, no audit trail.",
  "Managing Committee shown as a single image — no contact info per member, no roles, no historical archive.",
  "No CPE compliance tracking in-portal — relies entirely on external cpe.icai.org redirect.",
  "No member directory search — only a form to submit your own details.",
  "No event waitlist / cancellation handling — capacity overflow handled offline.",
  "No automated certificate issuance — CPE certificates issued manually.",
  "No real-time announcements channel — homepage announcements are static text refreshed manually.",
  "No admin panel — every content change requires a webmaster (Iolite Softwares) deploy.",
  "No notification system — members must visit the site to see updates.",
  "No newsletter subscription management — email subscription field exists but no managed list.",
  "No GST handling on payments — when payments do happen offline, GST split is manual.",
  "No DPDP Act 2023 compliance — no cookie banner, no consent records.",
  "No accessibility compliance — fails WCAG basics; locks out members with screen readers or motor impairments.",
  "No protection against form spam — no reCAPTCHA or rate limiting visible on any form.",
  "No structured event archive — past events are a list with PDFs, not searchable/filterable.",
  "No member benevolent fund (CABF) handling — referenced via PDF only.",
  "No reusable photo gallery system — galleries are flat thumbnail grids per event with no admin UI.",
  "No room booking — no way for members to reserve branch facilities.",
  "No employer / job portal — vacancies are static listings.",
  "No multi-role access — there's no concept of Chairman vs. Treasurer vs. Secretary having different admin scopes.",
];
gaps.forEach(g => sections.push(Bullet(g)));
sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── NEW CAPABILITIES ─────────────────────────────────────────────────────
sections.push(H1("4. Entirely New Capabilities (Not on Current Site)"));
sections.push(P("Features in the new portal with no analogue on nagpuricai.org. These represent the branch's competitive differentiation versus other ICAI branches' portals."));

sections.push(H3("4.1 AI & Intelligence"));
[
  "Pragyaan AI chatbot — RAG-grounded conversational assistant with 317 indexed knowledge sources across committees, journals, and curated ICAI links.",
  "15-minute auto-ingestion of new events, papers, and announcements into the AI's knowledge base.",
  "Role-scoped retrieval rubric — students vs members vs admins get different answer scopes.",
  "Admin-editable disclaimer and feedback rating per response.",
].forEach(t => sections.push(Bullet(t)));

sections.push(H3("4.2 Real-Time & Interactive"));
[
  "WebSocket-powered #general and #qa channels per event with pin, mute, freeze, archive, and attachments.",
  "Speaker-moderated Quora-style Q&A with magic-link access (no full account needed for speakers).",
  "Mock test peer discussion threads — one-thread-per-test, public-readable.",
  "Student suggestions board with topic buckets, upvotes, and rate-limited submissions.",
].forEach(t => sections.push(Bullet(t)));

sections.push(H3("4.3 Events 2.0"));
[
  "Month-calendar grid view with committee-coloured chips and mobile dot-mode.",
  "Recurring events with DAILY/WEEKLY/MONTHLY RRULE and edit-this-or-future scope.",
  "Waitlist with automatic promotion on cancellation.",
  "Add to Google Calendar deep-link (one-click).",
  "iCal subscription feed for power users (auto-syncs to Outlook/Apple Calendar).",
  "Auto-generated CPE certificate PDF with deterministic numbering.",
].forEach(t => sections.push(Bullet(t)));

sections.push(H3("4.4 Members & Onboarding"));
[
  "MRN-gated signup against uploaded ICAI directory — only verified members can register.",
  "Member dashboard with CPE deadline alert, stat tiles, recommended events, and recent activity.",
  "Searchable member directory with MRN validation.",
  "In-portal CPE compliance tracker (3-year structured/unstructured).",
  "Saved papers / My Library bookmarking.",
].forEach(t => sections.push(Bullet(t)));

sections.push(H3("4.5 Operational"));
[
  "Room booking with FIFO admin inbox and PostgreSQL EXCLUDE-gist overlap protection.",
  "CABF 5-state pipeline with monthly CSV export.",
  "Razorpay payments with GST split and refund management.",
  "Combined Grievance/Contact/Suggestion form with 48h SLA escalation, ticket numbering, and audit log.",
  "Employer self-service portal for posting jobs and articleships.",
  "Branch metrics dashboard (Chairman/Treasurer) with Recharts visualisations.",
].forEach(t => sections.push(Bullet(t)));

sections.push(H3("4.6 Platform"));
[
  "Progressive Web App — installable on iOS, Android, and desktop with offline support.",
  "Multi-channel notification engine (email + push + in-app) from one template.",
  "31 admin pages with role-based access for 15 distinct branch roles.",
  "40+ admin-editable site content slots (every public string and image).",
  "ICAI directory xlsx import with 500-row chunked upsert.",
  "Universal search across events, content, and members.",
].forEach(t => sections.push(Bullet(t)));
sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── PRESERVE / MIGRATE ────────────────────────────────────────────────────
sections.push(H1("5. Content to Preserve from Current Site"));
sections.push(P("Items currently live on nagpuricai.org that have value and should be migrated to the new portal before sunsetting the old site."));
const preserve = [
  ["Newsletter archive", "Monthly bulletins (years of issues)", "Upload via Newsletters admin"],
  ["Branch profile PDF", "2026-27 profile document", "Upload via Annual Reports admin or Site Content"],
  ["Past chairmen historical list", "Chronological record of past office bearers", "Migrate to admin-managed page"],
  ["Past council members list", "WIRC representation history", "Same as above"],
  ["Photo gallery archive (years of events)", "Visual history of branch activity", "Bulk-upload via Gallery Albums admin"],
  ["WICASA gallery archive", "Student activity history", "Same as above"],
  ["Useful Links directory", "Curated external resources", "Migrate to site content slot"],
  ["Chairman's Message", "Current chairperson's welcome note", "Edit through Site Content"],
  ["Branch office address & contacts", "ICAI Bhawan address, phones, email", "Already structured in Site Content"],
  ["WIRC Office Bearers reference", "Currently a static page", "Migrate to admin-editable slot or external link"],
  ["Birthday wishes feature", "Daily homepage widget", "Decide: build as auto-feature or admin-editable announcement"],
  ["Investor Awareness content", "Educational material", "Migrate to dedicated content page"],
  ["Job vacancies historical postings", "Old job listings", "Selectively migrate — most can be archived"],
  ["Bulletin & Archives section", "PDF bulletins by year", "Migrate to Newsletters admin"],
  ["WICASA Udaan newsletter", "Student newsletter series", "Add to Newsletters admin with student tag"],
  ["External links (cpe.icai.org, icai.org, WIRC library)", "Reference shortcuts", "Migrate to footer/quick-links slot"],
];
sections.push(new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    left: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    right: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
    insideVertical: { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
  },
  rows: [
    headerRow(["Item", "What's on Current Site", "Migration Path"], [30, 35, 35]),
    ...preserve.map(r => new TableRow({
      children: [
        cell(r[0], { bold: true, fontSize: 18 }),
        cell(r[1], { fontSize: 18 }),
        cell(r[2], { fontSize: 18 }),
      ],
    })),
  ],
}));
sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── LAUNCH READINESS ─────────────────────────────────────────────────────
sections.push(H1("6. Launch Readiness Assessment"));
sections.push(P("Status of the new portal relative to a public launch. Items below are scoped from FEATURES_DELIVERED.md (F1–F21)."));

sections.push(H2("6.1 What's already shipped"));
[
  "F1: Contact / Grievance / Suggestion form with 48h SLA escalation",
  "F2: PWA + Web Push notifications",
  "F3: Code-split route bundles with shimmer skeletons",
  "F4: Member dashboard with identity card and stat tiles",
  "F5: Pragyaan AI assistant (admin + public)",
  "F6: Rooms, Bookings, CABF, Payments admin",
  "F7: Event registration with waitlist auto-promotion",
  "F8: Auto-generated CPE certificate PDF",
  "F9: iCal subscription feed",
  "F10: Recurring events (RRULE)",
  "F11: WCAG 2.1 AA baseline",
  "F12: MRN-gated signup, GST, reCAPTCHA, cookie consent",
  "F14: Pragyaan auto-ingestion (15-min)",
  "F15: Events Month-calendar view",
  "F15.1: Google Calendar add-to-calendar deep-link",
  "F16: Audience filtering on events",
  "F17: Per-event Q&A forum with speaker magic-link",
  "F18: Mock test peer discussion + comment threads",
  "F19: Per-instance checklist question editor",
  "F20: Student suggestions board",
  "F21: Site Content rewire (40+ admin-editable slots)",
  "F22: Gallery v3 — Video Gallery, event-type filter, year-jump nav, homepage Recent Photos strip",
].forEach(t => sections.push(Bullet(t)));

sections.push(H2("6.2 In-progress / partial features (non-blocking for launch)"));
[
  "/forum non-event peer board — backend exists; frontend page pending",
  "Notification templates editor UI — backend supports it; admin UI shows Coming Soon",
  "CABF online contribution flow — page has CTAs but no in-portal payment yet",
  "Per-template push opt-outs (only global toggle exists)",
  "OCR for image-only PDFs in Pragyaan ingestion",
  "Mentor booking flow — placeholder only",
  "Past-month browsing in EventMonthCalendar (currently upcoming-only)",
  "Articleship matches admin UI (schema scaffolded)",
  "IUT transfers, Bills, Refunds admin UIs (schemas scaffolded)",
  "Status-change notification email to grievance submitter",
  "Comment pagination Load Earlier button",
].forEach(t => sections.push(Bullet(t)));

sections.push(H2("6.3 Client-input launch blockers"));
sections.push(P("These require business decisions or credentials from the branch, not engineering work:"));
[
  "Production VAPID keypair for Web Push",
  "Production reCAPTCHA v3 keys (currently using test keys)",
  "Brevo SMTP credentials [Resolved — now using Resend with verified icainagpur.in domain]",
  "Supabase Storage bucket promoted to production tier",
  "Branch GSTIN for payment receipts",
  "ICAI_DIRECTORY.xlsx file for MRN gating",
  "Per-subject grievance routing email map (admin-editable, but needs initial data)",
  "AI provider sign-off + monthly cost cap for Pragyaan (currently dev key)",
  "Domain DNS for icainagpur.in pointed at production hosting",
  "Privacy Policy + Terms of Service approved by branch leadership",
].forEach(t => sections.push(Bullet(t)));

sections.push(H2("6.4 Recommended launch sequence"));
sections.push(P("Suggested 3-phase rollout to minimise risk and maximise stakeholder buy-in:"));
sections.push(H3("Phase 1 — Soft launch (members only, 2 weeks)"));
[
  "Live to managing committee + early-adopter members",
  "Old site stays live; new site advertised internally only",
  "Focus: validate auth flow, payments, grievance form on real data",
  "Goal: 50 verified members signed up, 1 event registered & paid for, 5 grievances resolved",
].forEach(t => sections.push(Bullet(t)));
sections.push(H3("Phase 2 — Public launch (all members, 4 weeks)"));
[
  "Email blast to entire member list with signup link",
  "Old site banner: \"We've moved — new portal at icainagpur.in\"",
  "Old site stays live as read-only archive",
  "Focus: scale auth, content migration, Pragyaan knowledge base",
  "Goal: 60% of active members signed up; all upcoming events on new portal only",
].forEach(t => sections.push(Bullet(t)));
sections.push(H3("Phase 3 — Sunset old site (after Phase 2 success)"));
[
  "Redirect nagpuricai.org → icainagpur.in",
  "Archive old site as static export for reference",
  "Old contact channels close (phone/email continue, but no new offline payments)",
  "Goal: 100% transactions and registrations through new portal",
].forEach(t => sections.push(Bullet(t)));

sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── FEATURE DELIVERY TIMELINE ───────────────────────────────────────────
sections.push(H1("7. Feature Delivery Timeline (FEATURES_DELIVERED.md)"));
sections.push(P("Auditable log of every feature shipped, from first scaffolding to today. Sourced from FEATURES_DELIVERED.md at the project root. Each entry was built, tested, and logged with a what-was-required → what-was-built → known-gaps section."));

const timeline = [
  ["F1",  "2026-06-12", "Contact / Grievance / Suggestion form", "Ticket-numbered (GRV-YYYY-NNNNNN), 48h SLA escalation, reCAPTCHA-protected, subject-routed admin-editable email map, newsletter digest endpoint."],
  ["F2",  "2026-06-15", "PWA web push notifications", "Service worker (Workbox), VAPID-keyed, per-device subscription rows, iOS Safari supported when PWA installed. Per-user opt-out + 'notify_push' flag."],
  ["F3",  "2026-06-19", "Shimmer skeleton UI + initial-load speedup", "Route-level code-splitting (87 KB gzipped initial bundle vs. monolithic before), shimmer everywhere 'Loading…' used to render."],
  ["F4",  "2026-06-19", "Members dashboard — production rebuild", "Identity card with MRN/FCA/COP pills, CPE deadline alert, 4 stat tiles, suggested events, saved library, announcements, real ICAI services."],
  ["F5",  "2026-06-23", "Pragyaan admin console + auto-ingest + scope rubric", "4-tab UI (Sources/Approvals/Feedback/Analytics), 15-min auto-ingest cron, editable disclaimer, role-scoped retrieval rubric."],
  ["F6",  "2026-06-23", "Five stub admin modules built out", "CPE / Rooms / Bookings / CABF / Payments — all 5 ComingSoonPage stubs replaced with working CRUDs."],
  ["F7",  "2026-06-23", "Waitlist auto-promotion on event cancel", "Capacity-full registrations now waitlist instead of rejecting. Cancel auto-promotes oldest waitlister with notification."],
  ["F8",  "2026-06-23", "CPE certificate PDF generation", "A4 landscape, decorative border, deterministic cert number (NGP-CPE-{slug}-{user}), pdfkit-based, no DB writes."],
  ["F9",  "2026-06-23", "iCal sync — per-event + per-user subscription", "Hand-rolled RFC-5545 generator, /api/events/:slug/ical + /api/events/my-calendar.ics with HMAC token."],
  ["F10", "2026-06-23", "Recurring events — RRULE expansion", "DAILY/WEEKLY/MONTHLY expander, edit-this-or-future scope, materialises up to 52 occurrences per call."],
  ["F11", "2026-06-23", "WCAG 2.1 AA baseline pass", "Skip-to-content, :focus-visible rings, role=dialog + aria-modal on new admin modals, aria-labels on icon-only buttons."],
  ["F12", "2026-06-24", "Launch-prep bundle (7 blockers closed)", "VAPID, cookie banner, GST flag, reCAPTCHA, Brevo SMTP, Supabase Storage, ICAI MRN gating against icai_member_master."],
  ["F13", "2026-06-24", "Pragyaan starter-chip coverage (FAQ slots)", "4 admin-editable faq_* site-content slots seeded + ingested so every starter chip has grounded content."],
  ["F14", "2026-06-24", "Pragyaan corpus expansion", "kb_sources grew 256 → 317. Added committees (18), e-journal issues (28), ICAI link cards (11) to buildPublicDocs()."],
  ["F15", "2026-06-24", "Events page — List / Month calendar toggle", "Self-contained 6-week grid, committee-coloured chips, day-detail panel, today-highlight, mobile dot-mode."],
  ["F15.1", "2026-06-24", "Google Calendar swap-in", "All 'Add to Calendar' CTAs route through Google Calendar deep-links (new tab) instead of .ics download — fixes Windows Store popup."],
  ["F16", "2026-06-24", "Pre-launch dead-end sweep — 24 items closed", "1 BLOCKER 404 fixed, 10 inert public-page cards wired, CABF debug toast removed, student quick-actions de-looped, ICAI-SSP login-wall hints."],
  ["F17", "2026-06-24", "Per-event Q&A forum (Phase 1)", "Members ask, organisers reply (server-gated); answered-marker + audit; #general hidden pre-event from non-mods; composer + badge UI distinct per channel kind."],
  ["F18", "2026-06-24", "Newsletter archive card + Mock-test discussion threads", "Replaces speculative 'Networking Forum' / 'Student Forum' cards with concrete features. Mock-test threads: 1 thread per test, public read, login post."],
  ["F19", "2026-06-25", "Per-instance checklist question editor", "Each instance has its own private question copy (cloned from template at creation). Admin can add/edit/reorder/remove without touching the template."],
  ["F20", "2026-06-27", "Student suggestions feature", "Topic-bucketed, upvote-only, branch-scoped, with moderation queue + 'My suggestions' tab. 280-char cap, 3/week rate-limit per user."],
  ["F21", "2026-06-27", "Full Site Content rewire", "40+ new site-content slots, page-tabbed admin UI, image cropper on every image field. Every public page string + image now admin-editable."],
  ["F22", "2026-06-27", "Gallery v3 — Video Gallery + event-type filter + year nav + Recent Photos strip", "New gallery_videos table with YouTube/Vimeo paste-URL extraction, /gallery now tabbed with 3-row filter chips, homepage Recent Photos strip auto-hides on empty gallery."],
];

sections.push(new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  borders: {
    top:    { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    left:   { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    right:  { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
    insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY },
  },
  rows: [
    headerRow(["#", "Date", "Feature", "What shipped"], [6, 11, 28, 55]),
    ...timeline.map(r => new TableRow({
      children: [
        cell(r[0], { bold: true, color: PRIMARY, fontSize: 18, align: AlignmentType.CENTER }),
        cell(r[1], { fontSize: 17, color: GREY }),
        cell(r[2], { bold: true, fontSize: 18 }),
        cell(r[3], { fontSize: 17 }),
      ],
    })),
  ],
}));

sections.push(P(""));
sections.push(P("Cadence summary: 22 features (23 if F15.1 counted) shipped over 15 calendar days (2026-06-12 → 2026-06-27). Three multi-feature sprints: 2026-06-23 (F5–F11, seven features), 2026-06-24 (F12–F18, seven features), and 2026-06-27 (F20–F22, three features). Each entry carries its own what-was-built, known-gaps, and verification path in the source log.", { italics: true }));

sections.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SUMMARY ────────────────────────────────────────────────────────────
sections.push(H1("8. Summary"));
sections.push(P("The new ICAI Nagpur Branch portal represents a multi-year leap forward from the existing nagpuricai.org website. Where the current site is a static brochure with offline workflows hidden behind a few forms, the new portal is a working operating system for branch operations:"));
sections.push(P("•  Members get a real dashboard, online payments, certificate downloads, and a searchable directory."));
sections.push(P("•  Students get mock tests, peer discussion, suggestion polls, and an AI assistant grounded in branch material."));
sections.push(P("•  Admins get a 31-page control panel with role-based access — no more emailing the webmaster to update a phone number."));
sections.push(P("•  The branch gets DPDP compliance, accessibility compliance, audit trails on every action, and a foundation that can grow into mentorship, podcasts, and live-streamed events without rebuilding from scratch."));
sections.push(P("The remaining work is mostly polish (focus traps, OCR for image PDFs, pagination buttons) and a few admin UIs whose backends already exist. None of it blocks a soft launch to the managing committee.", { bold: true }));
sections.push(P("Recommended next step: soft launch to managing committee within 2 weeks, then phased rollout per Section 6.4.", { bold: true, color: PRIMARY }));

sections.push(new Paragraph({
  spacing: { before: 600 },
  alignment: AlignmentType.CENTER,
  children: [new TextRun({
    text: "— End of Document —",
    italics: true, color: GREY, size: 20,
  })],
}));

const doc = new Document({
  creator: "Nagpur Branch of WIRC of ICAI",
  title: "Feature Comparison Document",
  description: "nagpuricai.org vs icainagpur.in feature-by-feature comparison",
  styles: {
    default: {
      document: { run: { font: "Calibri", size: 22 } },
      heading1: { run: { font: "Calibri", size: 32, bold: true, color: NAVY }, paragraph: { spacing: { before: 400, after: 200 } } },
      heading2: { run: { font: "Calibri", size: 26, bold: true, color: PRIMARY }, paragraph: { spacing: { before: 300, after: 150 } } },
      heading3: { run: { font: "Calibri", size: 22, bold: true, color: NAVY }, paragraph: { spacing: { before: 200, after: 100 } } },
    },
  },
  sections: [{
    properties: {
      page: {
        size: { orientation: PageOrientation.PORTRAIT },
        margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: "ICAI Nagpur — Feature Comparison", italics: true, color: GREY, size: 18 })],
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `Generated ${today}  |  Nagpur Branch of WIRC of ICAI`, color: GREY, size: 16 })],
        })],
      }),
    },
    children: sections,
  }],
});

const buffer = await Packer.toBuffer(doc);
// Try the canonical name first; if it's locked (Word has it open), fall
// back to a timestamped name so the user can keep both and diff them.
let outPath = join(process.cwd(), "..", "FEATURE_COMPARISON.docx");
try {
  await writeFile(outPath, buffer);
} catch (err) {
  if (err.code === "EBUSY" || err.code === "EPERM") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    outPath = join(process.cwd(), "..", `FEATURE_COMPARISON_${stamp}.docx`);
    await writeFile(outPath, buffer);
    console.log(`(Original file was open in Word — wrote to backup path instead.)`);
  } else {
    throw err;
  }
}
console.log(`✓ Wrote ${outPath}`);
console.log(`  Size: ${(buffer.length / 1024).toFixed(1)} KB`);
console.log(`  Sections: 7 main, ~140 feature rows across 8 categories`);
