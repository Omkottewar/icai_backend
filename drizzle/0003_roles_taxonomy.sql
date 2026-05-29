-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0003 (companion) — Role taxonomy: seeds, triggers, indexes, view
--
-- Pair this with 0003_fantastic_marvex.sql (drizzle-generated). That file
-- adds the columns/enums/FK; this one seeds the 15 role codes and installs
-- the trigger + view that make the taxonomy enforceable.
--
-- Safe to re-run: seeds use ON CONFLICT; indexes/triggers use IF NOT EXISTS
-- / DROP IF EXISTS.
-- ════════════════════════════════════════════════════════════════════════════
-- ─── 1. Indexes ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_ura_scope_branch"    ON "user_role_assignments"("scope_branch_id");
CREATE INDEX IF NOT EXISTS "idx_ura_scope_committee" ON "user_role_assignments"("scope_committee_id");
CREATE INDEX IF NOT EXISTS "idx_ura_active_lookup"   ON "user_role_assignments"("role_id", "user_id") WHERE "effective_to" IS NULL;

-- ─── 2. Seed the 15 canonical role codes ───────────────────────────────────
INSERT INTO "roles" ("code", "name", "scope", "singleton_per_scope", "description") VALUES
  ('branch_chairman',             'Branch Chairman',            'branch',    true,  'Elected chair of the branch managing committee'),
  ('branch_vice_chairman',        'Branch Vice Chairman',       'branch',    true,  'Vice chair of the branch managing committee'),
  ('branch_secretary',            'Branch Secretary',           'branch',    true,  'Secretary of the branch managing committee'),
  ('branch_treasurer',            'Branch Treasurer',           'branch',    true,  'Treasurer of the branch managing committee'),
  ('mcm',                         'Managing Committee Member',  'branch',    false, 'Core member of the branch MC. Office bearers also hold this role.'),
  ('committee_chairman',          'Committee Chairman',         'committee', true,  'Chair of a specific committee — must also hold mcm'),
  ('committee_convener',          'Committee Convener',         'committee', true,  'Convener of a specific committee'),
  ('committee_co_convener',       'Committee Co-Convener',      'committee', true,  'Co-convener of a specific committee'),
  ('committee_member',            'Committee Member',           'committee', false, 'Council member serving on a specific committee'),
  ('branch_manager',              'Branch Manager',             'branch',    true,  'Operational head of branch support staff'),
  ('sub_branch_manager',          'Sub-Branch Manager',         'branch',    false, 'Assistant manager for branch operations'),
  ('student_desk',                'Student Desk',               'branch',    false, 'Student services counter staff'),
  ('accountant',                  'Accountant',                 'branch',    false, 'Branch accounting / bookkeeping staff'),
  ('central_council_coordinator', 'Central Council Coordinator','branch',    true,  'Liaison with ICAI Central Council'),
  ('admin',                       'Admin',                      'global',    false, 'System administrator with full access to the admin console')
ON CONFLICT ("code") DO UPDATE SET
  "name"                = EXCLUDED."name",
  "scope"               = EXCLUDED."scope",
  "singleton_per_scope" = EXCLUDED."singleton_per_scope",
  "description"         = EXCLUDED."description";

-- ─── 3. Trigger — enforce scope-correctness + singleton-per-scope ──────────
CREATE OR REPLACE FUNCTION "enforce_role_assignment_scope"() RETURNS trigger AS $$
DECLARE
  r "roles"%ROWTYPE;
  conflict_id uuid;
BEGIN
  SELECT * INTO r FROM "roles" WHERE "id" = NEW."role_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role % does not exist', NEW."role_id";
  END IF;

  IF r."scope" = 'branch' AND NEW."scope_branch_id" IS NULL THEN
    RAISE EXCEPTION 'role % is branch-scoped; scope_branch_id is required', r."code";
  END IF;
  IF r."scope" = 'committee' AND NEW."scope_committee_id" IS NULL THEN
    RAISE EXCEPTION 'role % is committee-scoped; scope_committee_id is required', r."code";
  END IF;
  IF r."scope" = 'global' AND (NEW."scope_branch_id" IS NOT NULL OR NEW."scope_committee_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'role % is global; scope columns must be NULL', r."code";
  END IF;

  IF r."singleton_per_scope" AND (NEW."effective_to" IS NULL OR NEW."effective_to" >= CURRENT_DATE) THEN
    SELECT u."id" INTO conflict_id
    FROM "user_role_assignments" u
    WHERE u."role_id" = NEW."role_id"
      AND u."id" IS DISTINCT FROM NEW."id"
      AND (u."effective_to" IS NULL OR u."effective_to" >= CURRENT_DATE)
      AND COALESCE(u."scope_branch_id"::text,    '~') = COALESCE(NEW."scope_branch_id"::text,    '~')
      AND COALESCE(u."scope_committee_id"::text, '~') = COALESCE(NEW."scope_committee_id"::text, '~')
    LIMIT 1;
    IF conflict_id IS NOT NULL THEN
      RAISE EXCEPTION 'role % already has an active holder for this scope (assignment %)', r."code", conflict_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_enforce_role_assignment_scope" ON "user_role_assignments";
CREATE TRIGGER "trg_enforce_role_assignment_scope"
  BEFORE INSERT OR UPDATE ON "user_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION "enforce_role_assignment_scope"();

-- ─── 4. Trigger — committee_chairman must also hold mcm ────────────────────
CREATE OR REPLACE FUNCTION "enforce_committee_chairman_is_mcm"() RETURNS trigger AS $$
DECLARE
  v_role_code text;
BEGIN
  SELECT "code" INTO v_role_code FROM "roles" WHERE "id" = NEW."role_id";
  IF v_role_code <> 'committee_chairman' THEN
    RETURN NEW;
  END IF;
  IF NEW."effective_to" IS NOT NULL AND NEW."effective_to" < CURRENT_DATE THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "user_role_assignments" ura
    JOIN "roles" r ON r."id" = ura."role_id"
    WHERE ura."user_id" = NEW."user_id"
      AND r."code" = 'mcm'
      AND (ura."effective_to" IS NULL OR ura."effective_to" >= CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'user % cannot hold committee_chairman without an active mcm role', NEW."user_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_enforce_committee_chairman_is_mcm" ON "user_role_assignments";
CREATE TRIGGER "trg_enforce_committee_chairman_is_mcm"
  BEFORE INSERT OR UPDATE ON "user_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION "enforce_committee_chairman_is_mcm"();

-- ─── 5. Convenience view — active role assignments with role metadata ──────
CREATE OR REPLACE VIEW "v_active_role_assignments" AS
SELECT
  ura."id"                  AS assignment_id,
  ura."user_id",
  u."email",
  u."name"                  AS user_name,
  r."code"                  AS role_code,
  r."name"                  AS role_name,
  r."scope"                 AS role_scope,
  r."singleton_per_scope",
  ura."scope_branch_id",
  b."code"                  AS branch_code,
  ura."scope_committee_id",
  c."code"                  AS committee_code,
  ura."effective_from",
  ura."effective_to"
FROM "user_role_assignments" ura
JOIN "users"  u ON u."id" = ura."user_id"
JOIN "roles"  r ON r."id" = ura."role_id"
LEFT JOIN "branches"   b ON b."id" = ura."scope_branch_id"
LEFT JOIN "committees" c ON c."id" = ura."scope_committee_id"
WHERE ura."effective_to" IS NULL OR ura."effective_to" >= CURRENT_DATE;
