// DUPLICATED FILE — keep in sync with frontend/src/lib/siteContentSlots.ts.
// Both copies must define the same slots/settings. If you change one, change the other.
//
// Definitions for the editable-content surface. The server uses this for slug
// validation; the frontend uses an identical copy for the admin form generator.
// Adding a new slot = one entry in BOTH files + one default in the frontend hook.
//
// Field kinds:
//   text       — single-line input
//   markdown   — multi-line textarea, rendered through src/lib/markdown.js
//   image      — file picker that uploads to the `files` table; stored as a
//                file UUID string
//   stats      — list of { k, v } pairs (label + value)

export type FieldKind = "text" | "markdown" | "image" | "stats";

export interface SlotField {
  key:     string;
  label:   string;
  kind:    FieldKind;
  hint?:   string;
}

export interface SlotDef {
  label:   string;     // human-readable name shown in the admin table
  page:    string;     // which page this slot renders on (for grouping)
  fields:  SlotField[];
}

export const SITE_SLOTS = {
  chairman_message: {
    label: "Chairman's Message",
    page:  "Home",
    fields: [
      { key: "photo_url",  label: "Chairman photo",     kind: "image",    hint: "Square portrait works best" },
      { key: "quote",      label: "Quote",              kind: "markdown", hint: "Supports **bold**, *italic*, [links](url)" },
      { key: "name",       label: "Name",               kind: "text" },
      { key: "role_line",  label: "Role / tenure line", kind: "text",    hint: "e.g. \"Chairperson, Nagpur Branch · 2025–26\"" },
    ],
  },
  home_hero: {
    label: "Home — Top tagline (under \"Nagpur Branch of ICAI\")",
    page:  "Home",
    fields: [
      { key: "tagline", label: "Tagline", kind: "markdown" },
    ],
  },
  home_hero_stats: {
    label: "Home — Stat cards (5,000+ Members / 8,500+ Students / etc.)",
    page:  "Home",
    fields: [
      { key: "stats", label: "Stats (4 cards)", kind: "stats", hint: "Label + value pairs — e.g. Members → 5,000+" },
    ],
  },
  home_leadership_banner: {
    label: "Home — \"Nurturing excellence\" hero (Established under the Chartered Accountants Act, 1949)",
    page:  "Home",
    fields: [
      { key: "eyebrow",  label: "Eyebrow (green text — e.g. \"ESTABLISHED UNDER THE CHARTERED ACCOUNTANTS ACT, 1949\")", kind: "text" },
      { key: "headline", label: "Headline (large blue title — e.g. \"Nurturing excellence in professional services for Central India.\")", kind: "text", hint: "Line breaks render as <br>" },
      { key: "body",     label: "Body (paragraph under the headline)", kind: "markdown" },
    ],
  },
  home_branch_premises: {
    label: "Home — Branch premises section (Reading room, Library stats)",
    page:  "Home",
    fields: [
      { key: "body",  label: "Description", kind: "markdown" },
      { key: "stats", label: "Facility stats", kind: "stats", hint: "e.g. READING ROOM → 80 seats" },
    ],
  },
  home_hero_text: {
    label: "Home — Hero text (\"Nagpur Branch of ICAI\" + 3 CTA buttons)",
    page:  "Home",
    fields: [
      { key: "badge",            label: "Top badge (e.g. \"Branch of WIRC of ICAI\")", kind: "text" },
      { key: "title_prefix",     label: "Title prefix (e.g. \"Nagpur Branch of\")",    kind: "text" },
      { key: "title_highlight",  label: "Title highlight (e.g. \"ICAI\")",             kind: "text", hint: "Coloured part of the headline" },
      { key: "cta_events_label", label: "Primary CTA — Events button label",           kind: "text" },
      { key: "cta_ai_label",     label: "Secondary CTA — PrayGyaan AI button label",   kind: "text" },
      { key: "cta_signup_label", label: "Signup CTA (shown only to logged-out users)", kind: "text" },
    ],
  },
  home_leadership_extras: {
    label: "Home — Leadership banner CTAs + \"SINCE\" badge",
    page:  "Home",
    fields: [
      { key: "cta_book_label",     label: "First button label (e.g. \"Book CPE Event\")",   kind: "text" },
      { key: "cta_download_label", label: "Second button label (e.g. \"Download Circulars\")", kind: "text" },
      { key: "since_label",        label: "Floating badge top line (e.g. \"SINCE\")",        kind: "text" },
      { key: "since_year",         label: "Floating badge bottom line (e.g. \"1962\")",       kind: "text" },
    ],
  },
  home_services_section: {
    label: "Home — Services section header (\"Explore the Branch\")",
    page:  "Home",
    fields: [
      { key: "eyebrow", label: "Eyebrow (small uppercase label)", kind: "text" },
      { key: "title",   label: "Title",                           kind: "text" },
      { key: "body",    label: "Description",                     kind: "markdown" },
    ],
  },
  home_events_section: {
    label: "Home — Events / Committees section headings + links",
    page:  "Home",
    fields: [
      { key: "events_eyebrow",          label: "Top eyebrow (e.g. \"EVENTS\")",                              kind: "text" },
      { key: "events_title",            label: "Top title",                                                  kind: "text" },
      { key: "events_view_all_label",   label: "View-all link label (e.g. \"View full calendar →\")",        kind: "text" },
      { key: "upcoming_eyebrow",        label: "Upcoming-events list eyebrow",                               kind: "text" },
      { key: "committees_eyebrow",      label: "Committees list eyebrow",                                    kind: "text" },
      { key: "committees_title",        label: "Committees list title",                                      kind: "text" },
    ],
  },
  home_premises_section: {
    label: "Home — Branch premises wrapper (heading + reading-room CTA)",
    page:  "Home",
    fields: [
      { key: "outer_eyebrow",      label: "Section eyebrow (e.g. \"OUR HOME\")",                           kind: "text" },
      { key: "outer_title",        label: "Section title (e.g. \"Branch premises & student wing\")",        kind: "text" },
      { key: "inner_eyebrow",      label: "Card eyebrow (e.g. \"BRANCH PREMISES\")",                       kind: "text" },
      { key: "inner_title",        label: "Card title (e.g. \"ICAI Bhawan, Dhantoli\")",                   kind: "text" },
      { key: "reading_room_label", label: "Reading-room CTA label",                                        kind: "text" },
    ],
  },
  home_knowledge_section: {
    label: "Home — Knowledge hub section (Circulars / Standards / e-Journal)",
    page:  "Home",
    fields: [
      { key: "eyebrow",        label: "Eyebrow",                                kind: "text" },
      { key: "title",          label: "Title",                                  kind: "text" },
      { key: "view_all_label", label: "View-all link label (e.g. \"All resources →\")", kind: "text" },
    ],
  },
  home_wicasa_card: {
    label: "Home — WICASA student-wing card labels",
    page:  "Home",
    fields: [
      { key: "eyebrow",             label: "Eyebrow (e.g. \"STUDENT WING\")",                kind: "text" },
      { key: "title",               label: "Title (e.g. \"WICASA — Nagpur Branch\")",        kind: "text" },
      { key: "body",                label: "Description paragraph",                          kind: "markdown" },
      { key: "updates_heading",     label: "Updates list heading (e.g. \"New updates\")",    kind: "text" },
      { key: "suggestions_heading", label: "Suggestions list heading",                       kind: "text" },
      { key: "signin_hint",         label: "Sign-in hint shown to logged-out students",      kind: "text" },
      { key: "resources_label",     label: "Bottom resources link label",                    kind: "text" },
    ],
  },
  about_vision: {
    label: "About — Vision",
    page:  "About",
    fields: [{ key: "body", label: "Body", kind: "markdown" }],
  },
  about_mission: {
    label: "About — Mission",
    page:  "About",
    fields: [{ key: "body", label: "Body", kind: "markdown" }],
  },
  about_history: {
    label: "About — History",
    page:  "About",
    fields: [{ key: "body", label: "Body", kind: "markdown" }],
  },
  about_committee_members: {
    label: "About — Committee Members",
    page:  "About",
    fields: [],
  },
  // ── Pragyaan FAQ slots ─────────────────────────────────────────────────────
  // Free-form Q&A bodies that get ingested into the Pragyaan KB so the
  // chatbot can answer the starter chips it suggests. One slot per audience
  // segment; each body lists multiple questions + answers in markdown. The
  // ingest pipeline pulls these as scope='public' (see PUBLIC_SITE_SLOTS),
  // so every visitor can read them — gated info should NOT go here.
  faq_branch_services: {
    label: "Pragyaan FAQ — Branch services (visitor)",
    page:  "Pragyaan",
    fields: [{ key: "body", label: "Q&A body", kind: "markdown", hint: "One H3 per question; plain markdown answers below" }],
  },
  faq_for_members: {
    label: "Pragyaan FAQ — For members",
    page:  "Pragyaan",
    fields: [{ key: "body", label: "Q&A body", kind: "markdown", hint: "One H3 per question; plain markdown answers below" }],
  },
  faq_for_students: {
    label: "Pragyaan FAQ — For students",
    page:  "Pragyaan",
    fields: [{ key: "body", label: "Q&A body", kind: "markdown", hint: "One H3 per question; plain markdown answers below" }],
  },
  faq_for_employers: {
    label: "Pragyaan FAQ — For employers",
    page:  "Pragyaan",
    fields: [{ key: "body", label: "Q&A body", kind: "markdown", hint: "One H3 per question; plain markdown answers below" }],
  },
} satisfies Record<string, SlotDef>;

export type SlotSlug = keyof typeof SITE_SLOTS;
export const SLOT_SLUGS = Object.keys(SITE_SLOTS) as SlotSlug[];
export function isValidSlug(s: string): s is SlotSlug {
  return Object.prototype.hasOwnProperty.call(SITE_SLOTS, s);
}

// Dynamic per-committee slugs for event page chairman content.
// Pattern: event_committee_<lowercase_code>  e.g. event_committee_asc
export function isValidCommitteeSlug(s: string): boolean {
  return /^event_committee_[a-z0-9_]+$/.test(s);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface SettingDef {
  key:    string;
  label:  string;
  group:  "Contact" | "Footer" | "Social";
  hint?:  string;
}

export const SITE_SETTINGS: SettingDef[] = [
  { key: "branch_address",    label: "Branch address",   group: "Contact" },
  { key: "branch_phone",      label: "Phone",            group: "Contact" },
  { key: "branch_email",      label: "Email",            group: "Contact" },
  { key: "branch_hours",      label: "Office hours",     group: "Contact", hint: "e.g. \"Mon–Sat 10:30–18:00\"" },
  { key: "branch_map_url",    label: "Google Maps URL",  group: "Contact" },
  { key: "footer_disclaimer", label: "Footer disclaimer", group: "Footer" },
  { key: "social_facebook",   label: "Facebook URL",     group: "Social" },
  { key: "social_twitter",    label: "Twitter / X URL",  group: "Social" },
  { key: "social_linkedin",   label: "LinkedIn URL",     group: "Social" },
  { key: "social_youtube",    label: "YouTube URL",      group: "Social" },
  { key: "social_instagram",  label: "Instagram URL",    group: "Social" },
];

export const SETTING_KEYS = SITE_SETTINGS.map((s) => s.key);
export function isValidSettingKey(k: string): boolean {
  return SETTING_KEYS.includes(k);
}
