-- One-shot fix for omkottewar19.02@gmail.com:
--   1. Demote primary_role from 'mcm' → 'member' so onboarding can complete
--      (primary_role is just a UI hint; the real source of truth is
--      user_role_assignments).
--   2. Grant an active MCM role assignment so the user actually shows up as
--      MCM on the public Managing Committee roster.
--
-- Idempotent: re-running won't create duplicate assignments.

DO $$
DECLARE
  v_user_id   uuid;
  v_role_id   uuid;
  v_branch_id uuid;
  v_today     date := CURRENT_DATE;
BEGIN
  SELECT id, branch_id INTO v_user_id, v_branch_id
    FROM users
    WHERE lower(email) = lower('omkottewar19.02@gmail.com')
    LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email omkottewar19.02@gmail.com';
  END IF;

  -- Pick Nagpur branch as fallback if the user row doesn't have one yet.
  IF v_branch_id IS NULL THEN
    SELECT id INTO v_branch_id FROM branches WHERE code = 'NGP' LIMIT 1;
  END IF;

  -- 1. Demote primary_role
  UPDATE users
    SET primary_role = 'member', updated_at = now()
    WHERE id = v_user_id;

  -- 2. Look up the mcm role (created in 0003_roles_taxonomy.sql)
  SELECT id INTO v_role_id FROM roles WHERE code = 'mcm' LIMIT 1;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Role code ''mcm'' not found in roles table';
  END IF;

  -- 3. Insert assignment unless one is already active
  IF NOT EXISTS (
    SELECT 1 FROM user_role_assignments
    WHERE user_id = v_user_id
      AND role_id = v_role_id
      AND (effective_to IS NULL OR effective_to >= v_today)
  ) THEN
    INSERT INTO user_role_assignments (user_id, role_id, scope_branch_id, effective_from)
    VALUES (v_user_id, v_role_id, v_branch_id, v_today);
  END IF;

  RAISE NOTICE 'Fixed account %, primary_role=member, mcm assignment active', v_user_id;
END $$;
