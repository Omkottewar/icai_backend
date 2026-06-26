-- 0048_event_gst.sql
-- Adds the per-event GST flag and branch-level GSTIN setting requested in
-- requirements H.20. Defaults to GST NOT applicable; the admin form will
-- expose a checkbox + percent picker so each event can opt in.
--
-- branch_gstin lives on site_settings (not events) because every event
-- billed under the branch shares the same 15-char registration.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS gst_applicable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gst_percent    numeric(4,2) NOT NULL DEFAULT 18.00;

-- Seed a placeholder GSTIN slot so the admin UI's site-settings page surfaces
-- it without the admin having to know the exact key name. Branch admin fills
-- this in once before publishing the first GST-applicable event.
INSERT INTO site_settings (key, value)
VALUES ('branch_gstin', '')
ON CONFLICT (key) DO NOTHING;
