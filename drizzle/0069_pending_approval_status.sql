-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0069 — Add 'pending_approval' to the user_status enum.
--
-- Self-signup is being gated behind branch-admin approval. New self-signed-up
-- users are inserted with status='pending_approval' and cannot sign in until
-- a branch admin promotes them to 'active'. The JWT middleware already
-- rejects any status != 'active', so this single enum value is enough to
-- enforce the block — the login/signup endpoints surface a friendly message
-- so the user knows to contact the branch.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TYPE "user_status" ADD VALUE IF NOT EXISTS 'pending_approval';
