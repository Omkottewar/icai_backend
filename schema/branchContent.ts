import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  date,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { events } from "./events";
import { files } from "./files";
import { committees } from "./committees";
import { users } from "./identity";

// Lifecycle enum shared by paper_presentations + ejournal_issues. Added in
// migration 0037 — replaces the older boolean `hidden` flag for new code
// paths while leaving `hidden` in place for legacy reads.
export const resourceStatusEnum = pgEnum("resource_status", [
  "draft",
  "pending_review",
  "published",
  "rejected",
  "archived",
]);

// ─── Branch content tables ─────────────────────────────────────────────────────
//
// These tables back the public-facing Resources / Gallery / About pages.
// Until migration 0030 they lived as hard-coded JS arrays — admin-only files
// like CHECKLIST_UI_MOCKUP.html or constants.js. Now every item has a real
// row, an editor, and a history.
//
// All tables follow the same pattern:
//   - `hidden` flag rather than a soft-delete column (admins want to hide
//     a row without destroying the file metadata)
//   - `sort_order` to allow manual reordering on the public page
//   - separate `pdf_file_id` / `cover_file_id` so the cover image and
//     the downloadable PDF can move independently

export const paperPresentations = pgTable(
  "paper_presentations",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    slug:          text("slug").notNull().unique(),                       // URL routing (mig 0037)
    title:         text("title").notNull(),
    abstract:      text("abstract"),                                      // 2-3 sentence summary
    description:   text("description"),                                   // legacy body — retained for reads
    speaker_name:  text("speaker_name").notNull(),
    author_user_id: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    author_designation: text("author_designation"),
    committee_tag: text("committee_tag"),                                 // legacy free-text tag
    committee_id:  uuid("committee_id").references(() => committees.id, { onDelete: "set null" }),
    event_id:      uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    presented_on:  date("presented_on"),
    pdf_file_id:   uuid("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
    cover_file_id: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    // Submission workflow (mig 0037). Existing rows default to 'published'
    // so the migration doesn't hide previously-uploaded content.
    status:        resourceStatusEnum("status").notNull().default("published"),
    submitted_by:  uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    reviewed_by:   uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewed_at:   timestamp("reviewed_at", { withTimezone: true }),
    review_note:   text("review_note"),
    published_at:  timestamp("published_at", { withTimezone: true }),
    view_count:    integer("view_count").notNull().default(0),
    // ICAI mandates "views expressed are personal" disclaimer on paper
    // presentations. Default text matches the client-confirmed wording.
    disclaimer_text: text("disclaimer_text").notNull().default("Views expressed are personal"),
    hidden:        boolean("hidden").notNull().default(false),
    sort_order:    integer("sort_order").notNull().default(0),
    // Best Paper award (migration 0089). One winner per year enforced by
    // a partial unique index on (award_year) WHERE is_winner = true.
    // The homepage BestPaperShowcase queries for the latest winner.
    is_winner:     boolean("is_winner").notNull().default(false),
    award_year:    integer("award_year"),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("paper_presentations_committee_idx").on(t.committee_tag),
    index("paper_presentations_presented_idx").on(t.presented_on),
    index("paper_presentations_status_idx").on(t.status),
    index("paper_presentations_author_idx").on(t.author_user_id),
  ],
);

// ─── Closed topic taxonomy ────────────────────────────────────────────────
export const resourceTopics = pgTable("resource_topics", {
  id:          uuid("id").primaryKey().defaultRandom(),
  code:        text("code").notNull().unique(),                          // 'gst', 'direct_tax'
  name:        text("name").notNull(),
  description: text("description"),
  sort_order:  integer("sort_order").notNull().default(0),
  active:      boolean("active").notNull().default(true),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paperTopics = pgTable("paper_topics", {
  paper_id:   uuid("paper_id").notNull().references(() => paperPresentations.id, { onDelete: "cascade" }),
  topic_id:   uuid("topic_id").notNull().references(() => resourceTopics.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("paper_topics_pk").on(t.paper_id, t.topic_id),
  index("paper_topics_topic_idx").on(t.topic_id),
]);

// ─── E-journal archive (L.5) ──────────────────────────────────────────────
export const ejournalIssues = pgTable("ejournal_issues", {
  id:                uuid("id").primaryKey().defaultRandom(),
  slug:              text("slug").notNull().unique(),
  title:             text("title").notNull(),
  issue_label:       text("issue_label").notNull(),                      // 'Vol III, Issue 2 — Apr-Jun 2026'
  issue_year:        integer("issue_year").notNull(),
  issue_quarter:     integer("issue_quarter"),                           // 1-4, nullable for annual
  cover_file_id:     uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
  pdf_file_id:       uuid("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
  editorial_summary: text("editorial_summary"),
  status:            resourceStatusEnum("status").notNull().default("published"),
  published_at:      timestamp("published_at", { withTimezone: true }),
  created_by:        uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  view_count:        integer("view_count").notNull().default(0),
  hidden:            boolean("hidden").notNull().default(false),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ejournal_issues_year_idx").on(t.issue_year, t.issue_quarter),
  index("ejournal_issues_status_idx").on(t.status),
]);

export const ejournalTopics = pgTable("ejournal_topics", {
  issue_id: uuid("issue_id").notNull().references(() => ejournalIssues.id, { onDelete: "cascade" }),
  topic_id: uuid("topic_id").notNull().references(() => resourceTopics.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("ejournal_topics_pk").on(t.issue_id, t.topic_id)]);

// ─── Curated link-out cards for icai.org content (L.1/L.3/L.6) ───────────
export const icaiLinkCards = pgTable("icai_link_cards", {
  id:          uuid("id").primaryKey().defaultRandom(),
  category:    text("category").notNull(),                               // 'circulars' | 'standards' | 'knowledge_repo' | 'other'
  title:       text("title").notNull(),
  description: text("description"),
  url:         text("url").notNull(),
  icon_emoji:  text("icon_emoji"),
  sort_order:  integer("sort_order").notNull().default(0),
  active:      boolean("active").notNull().default(true),
  created_by:  uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Engagement: bookmarks + topic subs + comments (Phase 2-3) ───────────
// resource_type is a tagged-union discriminator; we can't FK to one of two
// tables in Postgres, so cleanup of orphan rows happens at app-level.
export const resourceBookmarks = pgTable("resource_bookmarks", {
  id:            uuid("id").primaryKey().defaultRandom(),
  user_id:       uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  resource_type: text("resource_type").notNull(),                        // 'paper' | 'ejournal'
  resource_id:   uuid("resource_id").notNull(),
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("resource_bookmarks_user_resource_uq").on(t.user_id, t.resource_type, t.resource_id),
  index("resource_bookmarks_user_idx").on(t.user_id, t.created_at),
]);

export const resourceTopicSubscriptions = pgTable("resource_topic_subscriptions", {
  id:         uuid("id").primaryKey().defaultRandom(),
  user_id:    uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  topic_id:   uuid("topic_id").notNull().references(() => resourceTopics.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("resource_topic_subs_user_topic_uq").on(t.user_id, t.topic_id),
  index("resource_topic_subs_topic_idx").on(t.topic_id),
]);

export const resourceComments = pgTable("resource_comments", {
  id:                uuid("id").primaryKey().defaultRandom(),
  resource_type:     text("resource_type").notNull(),
  resource_id:       uuid("resource_id").notNull(),
  user_id:           uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body:              text("body").notNull(),
  // Self-reference for one-level replies. Cascade on the parent so a
  // deleted thread vanishes entirely; UI flattens past depth 1.
  parent_comment_id: uuid("parent_comment_id"),
  status:            text("status").notNull().default("visible"),         // 'visible' | 'hidden' | 'deleted'
  hidden_by:         uuid("hidden_by").references(() => users.id, { onDelete: "set null" }),
  hidden_at:         timestamp("hidden_at", { withTimezone: true }),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("resource_comments_resource_idx").on(t.resource_type, t.resource_id, t.created_at),
  index("resource_comments_user_idx").on(t.user_id),
]);

// ─── Comprehension quizzes on paper presentations (Phase 3) ──────────────
// Originally these awarded "unstructured CPE minutes" on pass — that column
// was dropped in migration 0087 alongside the rest of the CPE feature.
// The quizzes still function as a comprehension check; there's just no
// hour attribution anymore.
export const resourceQuizzes = pgTable("resource_quizzes", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  paper_id:            uuid("paper_id").notNull().unique().references(() => paperPresentations.id, { onDelete: "cascade" }),
  pass_threshold:      integer("pass_threshold").notNull().default(4),
  question_count:      integer("question_count").notNull().default(5),
  cooldown_hours:      integer("cooldown_hours").notNull().default(24),
  is_published:        boolean("is_published").notNull().default(false),
  created_by:          uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const resourceQuizQuestions = pgTable("resource_quiz_questions", {
  id:          uuid("id").primaryKey().defaultRandom(),
  quiz_id:     uuid("quiz_id").notNull().references(() => resourceQuizzes.id, { onDelete: "cascade" }),
  sort_order:  integer("sort_order").notNull().default(0),
  text:        text("text").notNull(),
  explanation: text("explanation"),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("resource_quiz_questions_quiz_idx").on(t.quiz_id, t.sort_order)]);

export const resourceQuizOptions = pgTable("resource_quiz_options", {
  id:          uuid("id").primaryKey().defaultRandom(),
  question_id: uuid("question_id").notNull().references(() => resourceQuizQuestions.id, { onDelete: "cascade" }),
  sort_order:  integer("sort_order").notNull().default(0),
  text:        text("text").notNull(),
  is_correct:  boolean("is_correct").notNull().default(false),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("resource_quiz_options_q_idx").on(t.question_id, t.sort_order)]);

export const resourceQuizAttempts = pgTable("resource_quiz_attempts", {
  id:           uuid("id").primaryKey().defaultRandom(),
  quiz_id:      uuid("quiz_id").notNull().references(() => resourceQuizzes.id, { onDelete: "cascade" }),
  user_id:      uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  score:        integer("score").notNull(),
  passed:       boolean("passed").notNull(),
  // Captured for audit: { [question_id]: option_id }
  answers:      jsonb("answers").notNull().default({}),
  started_at:   timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("resource_quiz_attempts_user_idx").on(t.user_id, t.completed_at),
  index("resource_quiz_attempts_quiz_user_idx").on(t.quiz_id, t.user_id, t.completed_at),
]);

export const galleryAlbums = pgTable(
  "gallery_albums",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    title:         text("title").notNull(),
    event_id:      uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    committee_tag: text("committee_tag"),
    occurred_on:   date("occurred_on"),
    description:   text("description"),
    cover_file_id: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    // 'public' | 'members' | 'private' — see migration 0031. The legacy
    // `hidden` flag stays as an editorial "not ready yet" toggle; visibility
    // controls who sees it once published.
    visibility:    text("visibility").notNull().default("public"),
    hidden:        boolean("hidden").notNull().default(false),
    sort_order:    integer("sort_order").notNull().default(0),
    // ── Layout / featured (migration 0061) ─────────────────────────────
    // is_featured + featured_position drive the hero strip at the top of
    // /gallery (1 = hero, 2-4 = sidekick tiles). layout drives how photos
    // render inside the album: 'grid' (uniform thumbs, default), 'masonry'
    // (waterfall that respects aspect ratios), or 'story' (full-width
    // single column with captions between photos).
    is_featured:       boolean("is_featured").notNull().default(false),
    featured_position: integer("featured_position"),
    layout:            text("layout").notNull().default("grid"),
    // Orthogonal to committee_tag. Lets members filter by event flavour
    // (Technical / Cultural / Sports / Press / Social / Visit / Other)
    // independently of which committee organised it. NULL = unfiltered.
    // See migration 0062.
    event_type:        text("event_type"),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gallery_albums_committee_idx").on(t.committee_tag),
    index("gallery_albums_occurred_idx").on(t.occurred_on),
  ],
);

// Video Gallery — separate from photo albums. Each row is one embeddable
// video (YouTube/Vimeo/external). Same visibility + featured semantics as
// gallery_albums so the public page can render a unified feed.
// See migration 0062.
export const galleryVideos = pgTable(
  "gallery_videos",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    title:          text("title").notNull(),
    description:    text("description"),
    provider:       text("provider").notNull().default("youtube"),
    video_id:       text("video_id").notNull(),
    video_url:      text("video_url"),
    poster_file_id: uuid("poster_file_id").references(() => files.id, { onDelete: "set null" }),
    event_id:       uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    committee_tag:  text("committee_tag"),
    event_type:     text("event_type"),
    occurred_on:    date("occurred_on"),
    duration_secs:  integer("duration_secs"),
    visibility:     text("visibility").notNull().default("public"),
    hidden:         boolean("hidden").notNull().default(false),
    is_featured:    boolean("is_featured").notNull().default(false),
    sort_order:     integer("sort_order").notNull().default(0),
    created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gallery_videos_occurred_idx").on(t.occurred_on),
    index("gallery_videos_committee_idx").on(t.committee_tag),
    index("gallery_videos_event_type_idx").on(t.event_type),
  ],
);

export const galleryPhotos = pgTable(
  "gallery_photos",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    album_id:    uuid("album_id").notNull().references(() => galleryAlbums.id, { onDelete: "cascade" }),
    file_id:     uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    caption:     text("caption"),
    sort_order:  integer("sort_order").notNull().default(0),
    // Bump this photo to a 2× tile inside the masonry layout. No-op for
    // grid or story layouts. See migration 0061.
    is_featured: boolean("is_featured").notNull().default(false),
    created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("gallery_photos_album_idx").on(t.album_id, t.sort_order),
  ],
);

export const branchNewsletters = pgTable(
  "branch_newsletters",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    title:         text("title").notNull(),
    issue_month:   integer("issue_month").notNull(),
    issue_year:    integer("issue_year").notNull(),
    pdf_file_id:   uuid("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
    cover_file_id: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    editor_note:   text("editor_note"),
    published_at:  timestamp("published_at", { withTimezone: true }),
    hidden:        boolean("hidden").notNull().default(false),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("branch_newsletters_issue_uq").on(t.issue_year, t.issue_month),
  ],
);

export const officeBearers = pgTable(
  "office_bearers",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    term_label:    text("term_label").notNull(),                      // "2025-26"
    role_label:    text("role_label").notNull(),                      // "Chairman"
    role_code:     text("role_code"),                                 // 'chairman', etc.
    person_name:   text("person_name").notNull(),
    photo_file_id: uuid("photo_file_id").references(() => files.id, { onDelete: "set null" }),
    bio:           text("bio"),
    email:         text("email"),
    phone:         text("phone"),
    is_current:    boolean("is_current").notNull().default(false),
    tenure_start:  date("tenure_start"),
    tenure_end:    date("tenure_end"),
    sort_order:    integer("sort_order").notNull().default(0),
    hidden:        boolean("hidden").notNull().default(false),
    // Optional link to a real user account. When set together with a
    // role_code that maps to an ACL role (chairman, vice_chairman,
    // secretary, treasurer, managing_committee), the office-bearer
    // admin endpoint keeps a matching user_role_assignment row in sync
    // — so removing/hiding an office bearer also revokes their portal
    // access. See backend/server/routes/admin/officeBearers.ts.
    linked_user_id: uuid("linked_user_id").references(() => users.id, { onDelete: "set null" }),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("office_bearers_term_idx").on(t.term_label),
    index("office_bearers_role_idx").on(t.role_code),
  ],
);

export const annualReports = pgTable(
  "annual_reports",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    fy_label:      text("fy_label").notNull(),                        // "2024-25"
    title:         text("title"),
    pdf_file_id:   uuid("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
    cover_file_id: uuid("cover_file_id").references(() => files.id, { onDelete: "set null" }),
    summary:       text("summary"),
    published_at:  timestamp("published_at", { withTimezone: true }),
    hidden:        boolean("hidden").notNull().default(false),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("annual_reports_fy_uq").on(t.fy_label),
  ],
);
