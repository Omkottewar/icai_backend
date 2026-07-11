-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0089 — Best Paper Presentation winner flag
--
-- Adds two columns to paper_presentations so admin can mark exactly one
-- paper per year as the "Best Paper" winner. The homepage renders the
-- most recent flagged row as a showcase card.
--
--   • is_winner   — boolean, default false. Toggles the winner badge.
--   • award_year  — nullable int. Populated only for winner rows; used
--                    to distinguish "2026 winner" from "2027 winner"
--                    when we eventually build a winners gallery.
--
-- Uniqueness: a partial UNIQUE index enforces "at most one winner per
-- year". The admin CRUD also transactionally unsets any existing winner
-- for the same year before flipping the new one — belt and braces so a
-- concurrent write never trips this constraint.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "paper_presentations"
  ADD COLUMN IF NOT EXISTS "is_winner"  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "award_year" integer;

-- Partial unique — only enforces uniqueness on rows actually flagged as
-- the winner. Non-winner rows can freely have NULL / arbitrary award_year.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_paper_presentations_winner_year"
  ON "paper_presentations" ("award_year")
  WHERE "is_winner" = true;

-- Sanity check: winners must carry a year. Enforced in code, not by the
-- DB, so we don't fail the migration if someone flipped the boolean
-- manually before this line lands.
