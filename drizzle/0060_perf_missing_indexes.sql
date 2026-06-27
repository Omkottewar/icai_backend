-- ─── 0060 — Performance: add missing indexes on hot foreign-key columns ────
--
-- Audit of the schema against actual query patterns in the backend route
-- handlers surfaced ~20 FK columns that are filtered or joined on in hot
-- paths but lacked a backing index. Postgres does NOT auto-create indexes
-- for foreign keys — only for PRIMARY KEY / UNIQUE constraints — so every
-- gap below was forcing sequential scans on tables that grow with usage
-- (registrations, chat posts, CPE credits, grievances, etc.).
--
-- All `IF NOT EXISTS` so re-running is safe. All B-tree (default). Where a
-- query always filters by status/lifecycle, the index is partial so it
-- stays small and only matches the rows the app cares about.
--
-- Tier 1 = confirmed-hot via route-handler inspection. Tier 2 = common but
-- lower frequency. Tier 3 (rare admin reports, FK enforcement only) is
-- intentionally NOT included — adding those would cost write throughput
-- for no measurable read gain.

-- ════════════════════════════════════════════════════════════════════════
-- Tier 1 — high-traffic query paths
-- ════════════════════════════════════════════════════════════════════════

-- "My registrations" / dashboard / CPE history queries hit this column on
-- every signed-in member's session. Composite UNIQUE (event_id, user_id)
-- only serves event-side lookups.
CREATE INDEX IF NOT EXISTS "event_registrations_user_idx"
  ON "event_registrations" ("user_id", "registered_at" DESC)
  WHERE "deleted_at" IS NULL;

-- Event-chat history + unread counts + WebSocket fanout all filter by
-- channel_id. With this missing the chat panel was scanning forum_posts
-- on every open.
CREATE INDEX IF NOT EXISTS "forum_posts_channel_created_idx"
  ON "forum_posts" ("channel_id", "created_at" DESC)
  WHERE "deleted_at" IS NULL AND "channel_id" IS NOT NULL;

-- Organizer dashboards count attendees / CPE issued per event. user-side
-- composites alone don't help these aggregates.
CREATE INDEX IF NOT EXISTS "cpe_credits_event_idx"
  ON "cpe_credits" ("event_id")
  WHERE "deleted_at" IS NULL;

-- Admin queue (CABF.ts:38) lists pending CABF requests; "my requests"
-- view filters by member_user_id. Whole table had zero indexes.
CREATE INDEX IF NOT EXISTS "cabf_member_idx"
  ON "cabf_assistance_requests" ("member_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "cabf_status_idx"
  ON "cabf_assistance_requests" ("status", "created_at" DESC);

-- Student-side "my articleship match" lookups. The existing seminar_event
-- and status indexes don't help student-scoped queries.
CREATE INDEX IF NOT EXISTS "articleship_matches_student_idx"
  ON "articleship_matches" ("student_user_id", "created_at" DESC);

-- "My reviews queue" — admin/home.ts:140, admin/users.ts:397. Fill-side
-- already has an index; reviewer side did not.
CREATE INDEX IF NOT EXISTS "checklist_instances_review_user_idx"
  ON "checklist_instances" ("assigned_review_user_id")
  WHERE "deleted_at" IS NULL AND "assigned_review_user_id" IS NOT NULL;

-- Every social-login resolve hits oauth_links by user_id (find all linked
-- providers for the signed-in user). The (provider, external_id) unique
-- can't serve this direction.
CREATE INDEX IF NOT EXISTS "oauth_links_user_idx"
  ON "oauth_links" ("user_id");

-- Admin grievance assignee inbox. Partial index keeps it tiny — only the
-- ~dozens of unresolved tickets are ever indexed, and "Resolved" / "Closed"
-- rows don't bloat it.
CREATE INDEX IF NOT EXISTS "grievances_assignee_open_idx"
  ON "grievances" ("assigned_to", "created_at" DESC)
  WHERE "status" IN ('open', 'in_review')
    AND "assigned_to" IS NOT NULL;

-- "My tickets" lookup for signed-in submitters (track-grievance page).
CREATE INDEX IF NOT EXISTS "grievances_user_idx"
  ON "grievances" ("user_id", "created_at" DESC)
  WHERE "user_id" IS NOT NULL;

-- "My IUT requests" page — filters by requested_by.
CREATE INDEX IF NOT EXISTS "iut_transfers_requested_by_idx"
  ON "iut_transfers" ("requested_by", "transfer_date" DESC);

-- ════════════════════════════════════════════════════════════════════════
-- Tier 2 — common patterns worth indexing
-- ════════════════════════════════════════════════════════════════════════

-- Threaded reply tree on forum posts.
CREATE INDEX IF NOT EXISTS "forum_posts_parent_idx"
  ON "forum_posts" ("parent_post_id")
  WHERE "parent_post_id" IS NOT NULL AND "deleted_at" IS NULL;

-- Event-detail page shows linked paper presentations.
CREATE INDEX IF NOT EXISTS "paper_presentations_event_idx"
  ON "paper_presentations" ("event_id")
  WHERE "event_id" IS NOT NULL;

-- Author "my submissions" view (drafts + under-review).
CREATE INDEX IF NOT EXISTS "paper_presentations_submitted_by_idx"
  ON "paper_presentations" ("submitted_by", "created_at" DESC)
  WHERE "submitted_by" IS NOT NULL;

-- Event-detail gallery section.
CREATE INDEX IF NOT EXISTS "gallery_albums_event_idx"
  ON "gallery_albums" ("event_id")
  WHERE "event_id" IS NOT NULL;

-- Committee-scoped finance dashboards (treasurer / committee chairman).
CREATE INDEX IF NOT EXISTS "bills_committee_idx"
  ON "bills" ("committee_id", "bill_date" DESC)
  WHERE "deleted_at" IS NULL AND "committee_id" IS NOT NULL;

-- Employer "my postings" + firm-side aggregation. Existing
-- (type, status) helps the public list but not these owner-scoped views.
CREATE INDEX IF NOT EXISTS "job_postings_employer_idx"
  ON "job_postings" ("employer_id", "created_at" DESC)
  WHERE "employer_id" IS NOT NULL AND "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "job_postings_firm_idx"
  ON "job_postings" ("firm_id", "created_at" DESC)
  WHERE "firm_id" IS NOT NULL AND "deleted_at" IS NULL;

-- Threaded resource comments (reply tree under a top-level comment).
CREATE INDEX IF NOT EXISTS "resource_comments_parent_idx"
  ON "resource_comments" ("parent_comment_id", "created_at")
  WHERE "parent_comment_id" IS NOT NULL;

-- "Students under this principal" — relevant for the principal CA's view
-- of their articled assistants.
CREATE INDEX IF NOT EXISTS "student_profiles_principal_idx"
  ON "student_profiles" ("principal_member_id")
  WHERE "principal_member_id" IS NOT NULL AND "deleted_at" IS NULL;

-- Topic→ejournal reverse lookup (mirrors the existing paper_topics_topic_idx).
CREATE INDEX IF NOT EXISTS "ejournal_topics_topic_idx"
  ON "ejournal_topics" ("topic_id");

-- ════════════════════════════════════════════════════════════════════════
-- Notes for future maintainers
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. We deliberately did NOT add indexes on:
--      events(branch_id) — only one branch in production for the
--          foreseeable future, so the index would have ~one bucket.
--      events(recurrence_parent_id) — RRULE series fetch is rare and
--          already scoped by event_id IN (...).
--      *(banner_id) / *(file_id) / *(photo_file_id) — FK enforcement only;
--          no read query filters on these.
--      payment_refunds(requested_by / approved_by) — refund volume is
--          tiny and admin queries always page by status first.
--      announcements(created_by / file_id) — author rarely queried;
--          file_id used at insert time only.
--      notification_templates(updated_by) — 0–1 changes per month.
--      checklist_instance_approvals(decided_by) — usually queried
--          through instance_id → reviews join, not standalone.
--    If usage shifts, add them at that point.
--
-- 2. Partial indexes (`WHERE deleted_at IS NULL` or `WHERE status IN ...`)
--    deliberately reduce index size to ONLY the live rows. They're chosen
--    because every backend query for these tables already includes the
--    same predicate, so the planner can use the partial index without a
--    re-check on the full table.
--
-- 3. To verify these are being used after migrate, run:
--      EXPLAIN ANALYZE SELECT … FROM event_registrations WHERE user_id = '…';
--    and confirm "Index Scan using event_registrations_user_idx" appears.
