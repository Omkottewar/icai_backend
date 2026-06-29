-- ─── 0065 — Make multi-stage approval optional per checklist template ────
--
-- Before this migration, every event-bound checklist instance was forced
-- through a hardcoded three-stage approval chain (Branch Chairman +
-- Treasurer + Vice-Chairman). The branch wanted this only when explicitly
-- requested by the admin who created the template — otherwise the original
-- single-reviewer flow should apply.
--
-- Schema change: `approver_role_codes text[] not null default '{}'` on
-- checklist_templates. Empty array = single-reviewer flow (no stage rows
-- auto-created). Populated array = one stage row per listed role,
-- preserving the existing per-stage approve/reject UX.
--
-- Backward-compatible: existing templates default to '{}' so they
-- immediately switch to single-reviewer flow. Admins who want the
-- three-stage chain can re-add it via the template editor.

ALTER TABLE "checklist_templates"
  ADD COLUMN IF NOT EXISTS "approver_role_codes" text[] NOT NULL DEFAULT '{}';
