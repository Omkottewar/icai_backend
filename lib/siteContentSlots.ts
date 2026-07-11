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
  // For `kind: "image"` only — minimum source pixel dimensions the slot
  // accepts. The cropper refuses to upload images smaller than this on
  // either axis, since cropping a small image would just pixelate it on
  // the live site. Set whichever axis the layout cares about (or both).
  minWidth?:  number;
  minHeight?: number;
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
      { key: "photo_url",  label: "Chairman photo",     kind: "image",    hint: "Square portrait works best (≥ 400×400)", minWidth: 400, minHeight: 400 },
      { key: "quote",      label: "Quote",              kind: "markdown", hint: "Supports **bold**, *italic*, [links](url)" },
      { key: "name",       label: "Name",               kind: "text" },
      { key: "role_line",  label: "Role / tenure line", kind: "text",    hint: "e.g. \"Chairperson, Nagpur Branch · 2025–26\"" },
    ],
  },
  home_hero: {
    label: "Home — Top tagline (under \"ICAI Nagpur Branch (WIRC)\")",
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
      { key: "image_url", label: "Branch premises photo", kind: "image", hint: "Wide 16:7 ratio works best (e.g. 1280×560)", minWidth: 1280, minHeight: 560 },
      { key: "body",      label: "Description", kind: "markdown" },
      { key: "stats",     label: "Facility stats", kind: "stats", hint: "e.g. READING ROOM → 80 seats" },
    ],
  },
  home_hero_text: {
    label: "Home — Hero text + background image (\"ICAI Nagpur Branch (WIRC)\" + 3 CTA buttons)",
    page:  "Home",
    fields: [
      { key: "bg_image_url",     label: "Hero background photo",                       kind: "image", hint: "Wide landscape (≈1920×1080). Shown behind the headline with a soft white wash.", minWidth: 1600, minHeight: 900 },
      { key: "watermark_url",    label: "Hero centre watermark (logo)",                kind: "image", hint: "Transparent PNG works best — fades over the photo at low opacity. ≥ 400×400.", minWidth: 400, minHeight: 400 },
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
      { key: "since_year",         label: "Floating badge bottom line (e.g. \"1978\")",       kind: "text" },
    ],
  },
  home_leadership_carousel: {
    label: "Home — Leadership banner image carousel (4 slides)",
    page:  "Home",
    fields: [
      { key: "slide_1_url",     label: "Slide 1 — image",      kind: "image", hint: "Landscape 3:2 (e.g. 720×480)", minWidth: 720, minHeight: 480 },
      { key: "slide_1_caption", label: "Slide 1 — caption",    kind: "text" },
      { key: "slide_1_alt",     label: "Slide 1 — alt text",   kind: "text",  hint: "Describe the photo for screen readers" },
      { key: "slide_2_url",     label: "Slide 2 — image",      kind: "image", hint: "Landscape 3:2 (e.g. 720×480)", minWidth: 720, minHeight: 480 },
      { key: "slide_2_caption", label: "Slide 2 — caption",    kind: "text" },
      { key: "slide_2_alt",     label: "Slide 2 — alt text",   kind: "text" },
      { key: "slide_3_url",     label: "Slide 3 — image",      kind: "image", hint: "Landscape 3:2 (e.g. 720×480)", minWidth: 720, minHeight: 480 },
      { key: "slide_3_caption", label: "Slide 3 — caption",    kind: "text" },
      { key: "slide_3_alt",     label: "Slide 3 — alt text",   kind: "text" },
      { key: "slide_4_url",     label: "Slide 4 — image",      kind: "image", hint: "Landscape 3:2 (e.g. 720×480)", minWidth: 720, minHeight: 480 },
      { key: "slide_4_caption", label: "Slide 4 — caption",    kind: "text" },
      { key: "slide_4_alt",     label: "Slide 4 — alt text",   kind: "text" },
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
  home_best_paper: {
    label: "Home — Best Paper Presentation showcase (caption text only — the paper is picked in Paper Presentations admin)",
    page:  "Home",
    fields: [
      { key: "eyebrow", label: "Eyebrow (small caps above the winner card, e.g. \"AWARD SPOTLIGHT\")", kind: "text" },
      { key: "title",   label: "Section title (e.g. \"Best Paper Presentation\")",                     kind: "text" },
      { key: "intro",   label: "One-line intro under the title (e.g. \"Recognising outstanding student research each year.\")", kind: "text" },
      { key: "cta_label", label: "Read-paper CTA button label (e.g. \"Read the winning paper →\")", kind: "text" },
    ],
  },
  home_wicasa_card: {
    label: "Home — WICASA student-wing card (labels + updates list)",
    page:  "Home",
    fields: [
      { key: "eyebrow",             label: "Eyebrow (e.g. \"STUDENT WING\")",                kind: "text" },
      { key: "title",               label: "Title (e.g. \"WICASA — Nagpur Branch\")",        kind: "text" },
      { key: "body",                label: "Description paragraph",                          kind: "markdown" },
      { key: "updates_heading",     label: "Updates list heading (e.g. \"New updates\")",    kind: "text" },
      { key: "updates",             label: "WICASA updates — one per line",                  kind: "markdown",
        hint: "Each non-empty line becomes a \"NEW\" item in the card. Don't add bullets — the card adds the pill itself." },
      { key: "suggestions_heading", label: "Suggestions list heading",                       kind: "text" },
      { key: "signin_hint",         label: "Sign-in hint shown to logged-out students",      kind: "text" },
      { key: "resources_label",     label: "Bottom resources link label",                    kind: "text" },
    ],
  },
  about_page_header: {
    label: "About — Page header (top banner)",
    page:  "About",
    fields: [
      { key: "title",    label: "Page title (e.g. \"About the Branch\")",                    kind: "text" },
      { key: "subtitle", label: "Page subtitle (e.g. \"Established 1978 · Branch of WIRC\")", kind: "text" },
    ],
  },
  about_section_headings: {
    label: "About — Section headings (Vision / Mission / History cards, Committee, Past Chairmen, Annual Reports)",
    page:  "About",
    fields: [
      { key: "vision_card_title",      label: "Vision card title (e.g. \"A model branch of ICAI\")",        kind: "text" },
      { key: "mission_card_title",     label: "Mission card title (e.g. \"Service to the profession\")",    kind: "text" },
      { key: "history_card_title",     label: "History card title (e.g. \"Six decades of service\")",       kind: "text" },
      { key: "committee_heading",      label: "Managing Committee section heading",                          kind: "text" },
      { key: "committee_empty_msg",    label: "Empty-state message when no roster set",                      kind: "text" },
      { key: "past_chairmen_heading",  label: "Past Chairmen section heading",                               kind: "text" },
      { key: "past_chairmen_subtitle", label: "Past Chairmen section subtitle paragraph",                    kind: "markdown" },
      { key: "annual_reports_heading", label: "Annual Reports section heading",                              kind: "text" },
      { key: "annual_reports_subtitle", label: "Annual Reports section subtitle paragraph",                  kind: "markdown" },
    ],
  },
  about_vision: {
    label: "About — Vision (body text)",
    page:  "About",
    fields: [{ key: "body", label: "Body", kind: "markdown" }],
  },
  about_mission: {
    label: "About — Mission (body text)",
    page:  "About",
    fields: [{ key: "body", label: "Body", kind: "markdown" }],
  },
  about_history: {
    label: "About — History (body text)",
    page:  "About",
    fields: [{ key: "body", label: "Body", kind: "markdown" }],
  },
  about_committee_members: {
    label: "About — Committee Members",
    page:  "About",
    fields: [],
  },
  // ── Students page ──────────────────────────────────────────────────
  students_page_header: {
    label: "Students — Page header (top banner)",
    page:  "Students",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  students_icai_banner: {
    label: "Students — ICAI portal banner (green strip with \"Visit ICAI Students Portal\")",
    page:  "Students",
    fields: [
      { key: "body",         label: "Banner body text", kind: "markdown",  hint: "Markdown — supports **bold** etc." },
      { key: "button_label", label: "Button label",     kind: "text" },
      { key: "button_url",   label: "Button URL",       kind: "text",      hint: "e.g. https://www.icai.org/students" },
    ],
  },
  students_quick_access: {
    label: "Students — Quick-access buttons (3 chips above service cards)",
    page:  "Students",
    fields: [
      { key: "mock_tests_label",   label: "Mock tests button label",     kind: "text" },
      { key: "articleship_label",  label: "Articleship button label",    kind: "text" },
      { key: "events_label",       label: "Student events button label", kind: "text" },
    ],
  },
  students_services: {
    label: "Students — Service cards (6 tiles below quick-access)",
    page:  "Students",
    fields: [
      { key: "card_1_title", label: "Card 1 — title",       kind: "text" },
      { key: "card_1_desc",  label: "Card 1 — description", kind: "text" },
      { key: "card_2_title", label: "Card 2 — title",       kind: "text" },
      { key: "card_2_desc",  label: "Card 2 — description", kind: "text" },
      { key: "card_3_title", label: "Card 3 — title",       kind: "text" },
      { key: "card_3_desc",  label: "Card 3 — description", kind: "text" },
      { key: "card_4_title", label: "Card 4 — title",       kind: "text" },
      { key: "card_4_desc",  label: "Card 4 — description", kind: "text" },
      { key: "card_5_title", label: "Card 5 — title",       kind: "text" },
      { key: "card_5_desc",  label: "Card 5 — description", kind: "text" },
      { key: "card_6_title", label: "Card 6 — title",       kind: "text" },
      { key: "card_6_desc",  label: "Card 6 — description", kind: "text" },
    ],
  },
  // ── Members page ──────────────────────────────────────────────────
  members_page_header: {
    label: "Members — Page header (top banner)",
    page:  "Members",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  members_icai_banner: {
    label: "Members — ICAI portal banner (blue strip with \"Visit ICAI Members Portal\")",
    page:  "Members",
    fields: [
      { key: "body",         label: "Banner body text", kind: "markdown" },
      { key: "button_label", label: "Button label",     kind: "text" },
      { key: "button_url",   label: "Button URL",       kind: "text",      hint: "e.g. https://www.icai.org/members" },
    ],
  },
  members_quick_access: {
    label: "Members — Quick-access buttons (2 chips above service cards)",
    page:  "Members",
    fields: [
      { key: "directory_label", label: "Members directory button label", kind: "text" },
      { key: "jobs_label",      label: "Job vacancies button label",     kind: "text" },
    ],
  },
  members_services: {
    label: "Members — Service cards (4 tiles for COP / UDIN / CPE / Newsletter)",
    page:  "Members",
    fields: [
      { key: "card_1_title", label: "Card 1 — title",       kind: "text" },
      { key: "card_1_desc",  label: "Card 1 — description", kind: "text" },
      { key: "card_2_title", label: "Card 2 — title",       kind: "text" },
      { key: "card_2_desc",  label: "Card 2 — description", kind: "text" },
      { key: "card_3_title", label: "Card 3 — title",       kind: "text" },
      { key: "card_3_desc",  label: "Card 3 — description", kind: "text" },
      { key: "card_4_title", label: "Card 4 — title",       kind: "text" },
      { key: "card_4_desc",  label: "Card 4 — description", kind: "text" },
    ],
  },
  // ── Contact page ──────────────────────────────────────────────────
  contact_page_header: {
    label: "Contact — Page header (top banner)",
    page:  "Contact",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  contact_sections: {
    label: "Contact — Card titles + form labels",
    page:  "Contact",
    fields: [
      { key: "info_card_title",      label: "Left card title (e.g. \"ICAI Bhawan, Nagpur\")",     kind: "text" },
      { key: "track_link_label",     label: "Track-ticket link label",                            kind: "text" },
      { key: "form_card_title",      label: "Right card title (e.g. \"Send a message\")",        kind: "text" },
      { key: "submit_button_label",  label: "Submit button label",                                kind: "text" },
      { key: "submit_busy_label",    label: "Submit button while sending",                        kind: "text" },
      { key: "success_message",      label: "Success banner message",                             kind: "markdown",
        hint: "Use {ticketNo} and {email} placeholders — they're substituted at render time." },
      { key: "track_button_label",   label: "Success — track-this-ticket button label",           kind: "text" },
      { key: "another_button_label", label: "Success — submit-another button label",              kind: "text" },
    ],
  },
  // ── Resources page ──────────────────────────────────────────
  resources_page_header: {
    label: "Resources — Page header",
    page:  "Resources",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  resources_categories: {
    label: "Resources — Top category tiles (4 quick-link cards)",
    page:  "Resources",
    fields: [
      { key: "card_1_title", label: "Card 1 — title",       kind: "text" },
      { key: "card_1_desc",  label: "Card 1 — description", kind: "text" },
      { key: "card_1_url",   label: "Card 1 — URL",         kind: "text" },
      { key: "card_2_title", label: "Card 2 — title",       kind: "text" },
      { key: "card_2_desc",  label: "Card 2 — description", kind: "text" },
      { key: "card_2_url",   label: "Card 2 — URL",         kind: "text" },
      { key: "card_3_title", label: "Card 3 — title",       kind: "text" },
      { key: "card_3_desc",  label: "Card 3 — description", kind: "text" },
      { key: "card_3_url",   label: "Card 3 — URL",         kind: "text" },
      { key: "card_4_title", label: "Card 4 — title",       kind: "text" },
      { key: "card_4_desc",  label: "Card 4 — description", kind: "text" },
      { key: "card_4_url",   label: "Card 4 — URL",         kind: "text" },
    ],
  },
  resources_sections: {
    label: "Resources — Section headings (Newsletter / e-Journal / Papers + disclaimer)",
    page:  "Resources",
    fields: [
      { key: "newsletter_eyebrow",   label: "Newsletter eyebrow",    kind: "text" },
      { key: "newsletter_heading",   label: "Newsletter heading",    kind: "text" },
      { key: "newsletter_subtitle",  label: "Newsletter subtitle",   kind: "markdown" },
      { key: "newsletter_empty_msg", label: "Newsletter empty-state message",  kind: "text" },
      { key: "ejournal_eyebrow",     label: "e-Journal eyebrow",     kind: "text" },
      { key: "ejournal_heading",     label: "e-Journal heading",     kind: "text" },
      { key: "ejournal_subtitle",    label: "e-Journal subtitle",    kind: "markdown" },
      { key: "papers_eyebrow",       label: "Papers eyebrow",        kind: "text" },
      { key: "papers_heading",       label: "Papers heading",        kind: "text" },
      { key: "papers_subtitle",      label: "Papers subtitle",       kind: "markdown" },
      { key: "papers_search_placeholder", label: "Papers search-box placeholder", kind: "text" },
      { key: "papers_disclaimer",    label: "Papers disclaimer",     kind: "markdown" },
    ],
  },
  // ── Pragyaan landing page ───────────────────────────────────
  praygyaan_page_header: {
    label: "Pragyaan — Page header",
    page:  "Pragyaan",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  praygyaan_features: {
    label: "Pragyaan — Feature cards + welcome / placeholder text",
    page:  "Pragyaan",
    fields: [
      { key: "card_1_title", label: "Card 1 — title",       kind: "text" },
      { key: "card_1_desc",  label: "Card 1 — description", kind: "text" },
      { key: "card_2_title", label: "Card 2 — title",       kind: "text" },
      { key: "card_2_desc",  label: "Card 2 — description", kind: "text" },
      { key: "card_3_title", label: "Card 3 — title",       kind: "text" },
      { key: "card_3_desc",  label: "Card 3 — description", kind: "text" },
      { key: "welcome",            label: "Assistant welcome message", kind: "markdown" },
      { key: "input_placeholder",  label: "Input placeholder when idle",   kind: "text" },
      { key: "input_placeholder_streaming", label: "Input placeholder while replying", kind: "text" },
      { key: "send_label",         label: "Send button — idle label",      kind: "text" },
      { key: "send_label_streaming", label: "Send button — while replying", kind: "text" },
      { key: "chat_title",         label: "Chat panel title",              kind: "text" },
      { key: "reply_in_label",     label: '"Reply in" prefix next to language dropdown', kind: "text" },
      { key: "starters_prefix",    label: "Starters chip-bar prefix",      kind: "text" },
    ],
  },
  // ── Events page ─────────────────────────────────────────────
  events_page_header: {
    label: "Events — Page header",
    page:  "Events",
    fields: [
      { key: "title",                       label: "Page title",                       kind: "text" },
      { key: "subtitle",                    label: "Page subtitle",                    kind: "text" },
      { key: "committee_subtitle_template", label: "Committee detail subtitle template", kind: "text",
        hint: 'Use {short} for the committee code — e.g. "Upcoming events from the {short} committee"' },
    ],
  },
  events_audience_tabs: {
    label: "Events — Audience tab labels",
    page:  "Events",
    fields: [
      { key: "all_label",      label: 'Tab 1 label (e.g. "All Events")',  kind: "text" },
      { key: "members_label",  label: 'Tab 2 label (e.g. "For Members")', kind: "text" },
      { key: "students_label", label: 'Tab 3 label (e.g. "For Students")', kind: "text" },
    ],
  },
  events_sections: {
    label: "Events — Section eyebrows / titles / empty states",
    page:  "Events",
    fields: [
      { key: "events_eyebrow",          label: "Top eyebrow",                                 kind: "text" },
      { key: "events_title",            label: "Top title",                                   kind: "text" },
      { key: "upcoming_eyebrow",        label: "Upcoming-events list eyebrow",                kind: "text" },
      { key: "view_list_label",         label: "View-toggle: List label",                     kind: "text" },
      { key: "view_month_label",        label: "View-toggle: Month label",                    kind: "text" },
      { key: "committees_eyebrow",      label: "Browse-by-committee eyebrow",                 kind: "text" },
      { key: "committees_title",        label: "Browse-by-committee title",                   kind: "text" },
      { key: "committees_subtitle",     label: "Browse-by-committee paragraph",               kind: "markdown" },
      { key: "empty_audience_msg",      label: "Empty audience-filter message",               kind: "text" },
      { key: "empty_committee_msg",     label: "Empty committee detail message",              kind: "text" },
      { key: "all_committees_btn",      label: 'Back button label (e.g. "All committees")',   kind: "text" },
    ],
  },
  events_committee_fallback: {
    label: "Events — Committee detail fallback image",
    page:  "Events",
    fields: [
      { key: "image_url", label: "Fallback committee photo (shown when a committee has no admin-supplied image)", kind: "image" },
    ],
  },
  // ── Announcements page ──────────────────────────────────────
  announcements_page_header: {
    label: "Announcements — Page header + empty state",
    page:  "Announcements",
    fields: [
      { key: "title",                label: "Page title",                       kind: "text" },
      { key: "subtitle",             label: "Page subtitle",                    kind: "text" },
      { key: "empty_state_heading",  label: "Empty-state heading",              kind: "text" },
      { key: "empty_state_body",     label: "Empty-state paragraph",            kind: "markdown" },
    ],
  },
  // ── Members directory ──────────────────────────────────────
  members_directory_page_header: {
    label: "Members Directory — Page header + notices",
    page:  "Members Directory",
    fields: [
      { key: "title",              label: "Page title",                 kind: "text" },
      { key: "subtitle",           label: "Page subtitle",              kind: "text" },
      { key: "confidential_notice", label: "Confidential notice (shown to signed-in members)", kind: "markdown" },
      { key: "signin_notice_title", label: "Sign-in nudge — bold heading",         kind: "text" },
      { key: "signin_notice_body",  label: "Sign-in nudge — paragraph",            kind: "markdown" },
    ],
  },
  // ── Photo gallery ──────────────────────────────────────────
  photo_gallery_page_header: {
    label: "Photo Gallery — Page header",
    page:  "Photo Gallery",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  // ── Job vacancies ──────────────────────────────────────────
  job_vacancies_page_header: {
    label: "Job Vacancies — Page headers + notice",
    page:  "Job Vacancies",
    fields: [
      { key: "job_title",           label: "Title when ?type=job",            kind: "text" },
      { key: "job_subtitle",        label: "Subtitle when ?type=job",         kind: "text" },
      { key: "articleship_title",   label: "Title when ?type=articleship",    kind: "text" },
      { key: "articleship_subtitle", label: "Subtitle when ?type=articleship", kind: "text" },
      { key: "notice",              label: "Disclaimer notice at top",        kind: "markdown" },
    ],
  },
  // ── Track grievance ────────────────────────────────────────
  track_grievance_page_header: {
    label: "Track Grievance — Page header",
    page:  "Track Grievance",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  // ── My Library (authed) ────────────────────────────────────
  my_library_page_header: {
    label: "My Library — Page header",
    page:  "My Library",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  // ── Room booking ───────────────────────────────────────────
  room_booking_page_header: {
    label: "Room Booking — Page header",
    page:  "Room Booking",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  // ── Search page ────────────────────────────────────────────
  search_page_header: {
    label: "Search — Page header + form",
    page:  "Search",
    fields: [
      { key: "title",              label: "Page title",            kind: "text" },
      { key: "subtitle_idle",      label: "Subtitle when no query", kind: "text" },
      { key: "subtitle_template",  label: "Subtitle template when searching", kind: "text",
        hint: 'Use {query} placeholder — e.g. \'Results for "{query}"\'' },
      { key: "placeholder",        label: "Search input placeholder", kind: "text" },
      { key: "submit_label",       label: "Submit button label",      kind: "text" },
      { key: "empty_state",        label: "Empty-state message",      kind: "markdown",
        hint: 'Use {query} placeholder — e.g. \'No events matched "{query}".\'' },
    ],
  },
  // ── Mock tests ─────────────────────────────────────────────
  mock_tests_page_header: {
    label: "Mock Tests — Page header + section labels",
    page:  "Mock Tests",
    fields: [
      { key: "title",                  label: "Page title",                              kind: "text" },
      { key: "subtitle",               label: "Page subtitle",                           kind: "text" },
      { key: "my_section_heading",     label: "My mock tests section heading",           kind: "text" },
      { key: "upcoming_heading",       label: "Upcoming & open section heading",         kind: "text" },
      { key: "results_heading",        label: "Recent results section heading",          kind: "text" },
      { key: "empty_msg",              label: "Empty-state message for upcoming list",   kind: "text" },
      { key: "level_label",            label: '"Level:" label prefix',                   kind: "text" },
    ],
  },
  // ── CABF, CA2, Investor, Career — landing pages ─────────────
  benevolent_fund_content: {
    label: "CABF — Page header + body",
    page:  "Benevolent Fund",
    fields: [
      { key: "title",                label: "Page title",                                kind: "text" },
      { key: "subtitle",             label: "Page subtitle",                             kind: "text" },
      { key: "about_heading",        label: "Left card heading",                         kind: "text" },
      { key: "about_body",           label: "Left card body",                            kind: "markdown" },
      { key: "contribute_heading",   label: "Right card heading",                        kind: "text" },
      { key: "contribute_body",      label: "Right card body",                           kind: "markdown" },
      { key: "slabs_csv",            label: "Suggested contribution slabs (comma-separated)", kind: "text" },
      { key: "alert_body",           label: "Yellow alert box body",                     kind: "markdown" },
      { key: "icai_btn_label",       label: "ICAI CABF button label",                    kind: "text" },
      { key: "icai_btn_url",         label: "ICAI CABF button URL",                      kind: "text" },
      { key: "contact_btn_label",    label: "Contact Branch button label",               kind: "text" },
    ],
  },
  ca2_vision_content: {
    label: "CA 2.0 Vision — Page header + body",
    page:  "CA 2.0",
    fields: [
      { key: "title",        label: "Page title",          kind: "text" },
      { key: "subtitle",     label: "Page subtitle",       kind: "text" },
      { key: "intro",        label: "Intro paragraph",     kind: "markdown" },
      { key: "card_1_title", label: "Card 1 — title",      kind: "text" },
      { key: "card_1_desc",  label: "Card 1 — description", kind: "text" },
      { key: "card_2_title", label: "Card 2 — title",      kind: "text" },
      { key: "card_2_desc",  label: "Card 2 — description", kind: "text" },
      { key: "card_3_title", label: "Card 3 — title",      kind: "text" },
      { key: "card_3_desc",  label: "Card 3 — description", kind: "text" },
    ],
  },
  investor_awareness_content: {
    label: "Investor Awareness — Page header + body",
    page:  "Investor Awareness",
    fields: [
      { key: "title",            label: "Page title",                       kind: "text" },
      { key: "subtitle",         label: "Page subtitle",                    kind: "text" },
      { key: "intro",            label: "Intro paragraph",                  kind: "markdown" },
      { key: "sessions_heading", label: "Upcoming sessions section heading", kind: "text" },
      { key: "sessions_body",    label: "Upcoming sessions body (markdown list — one entry per line)", kind: "markdown",
        hint: 'Lines like "12 May · ICAI Bhawan · Financial Planning for Young Professionals" — keep it simple.' },
    ],
  },
  career_counselling_content: {
    label: "Career Counselling — Page header + body",
    page:  "Career Counselling",
    fields: [
      { key: "title",                  label: "Page title",                          kind: "text" },
      { key: "subtitle",               label: "Page subtitle",                       kind: "text" },
      { key: "benefits_heading",       label: "Left card heading",                   kind: "text" },
      { key: "benefits_body",          label: "Left card body (markdown bullets)",   kind: "markdown" },
      { key: "bookings_heading",       label: "Right card heading",                  kind: "text" },
      { key: "bookings_body",          label: "Right card body",                     kind: "markdown" },
      { key: "contact_button_label",   label: "Contact button label",                kind: "text" },
    ],
  },
  // ── Auth surfaces ──────────────────────────────────────────
  auth_login: {
    label: "Auth — Login page",
    page:  "Auth",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  auth_signup: {
    label: "Auth — Signup page",
    page:  "Auth",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  auth_forgot: {
    label: "Auth — Forgot password page",
    page:  "Auth",
    fields: [
      { key: "title",    label: "Page title",    kind: "text" },
      { key: "subtitle", label: "Page subtitle", kind: "text" },
    ],
  },
  // ── Footer ──────────────────────────────────────────────────
  footer_content: {
    label: "Footer — Brand text + column headings",
    page:  "Footer",
    fields: [
      { key: "brand_name",        label: "Branch name (e.g. \"ICAI Nagpur Branch\")",                    kind: "text" },
      { key: "brand_description", label: "Branch description (paragraph below brand name)",             kind: "markdown" },
      { key: "quick_links_heading",   label: "Quick Links column heading",      kind: "text" },
      { key: "initiatives_heading",   label: "Initiatives column heading",      kind: "text" },
      { key: "icai_portals_heading",  label: "ICAI Portals column heading",     kind: "text" },
    ],
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
  group:  "Contact" | "Footer" | "Social" | "Payments";
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
  // Payments — UPI VPA that every paid event QR points to. Payee name is
  // shown to the user inside their UPI app so it should be readable
  // ("ICAI Nagpur Branch", not the raw VPA).
  { key: "payment_upi_id",         label: "UPI ID (VPA)",       group: "Payments", hint: "e.g. icainagpur@sbi — every paid event's QR encodes this address." },
  { key: "payment_upi_payee_name", label: "Payee display name", group: "Payments", hint: "Name shown to the payer inside their UPI app." },
];

export const SETTING_KEYS = SITE_SETTINGS.map((s) => s.key);
export function isValidSettingKey(k: string): boolean {
  return SETTING_KEYS.includes(k);
}
