-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0101 — Payment sold-out notifications
--
-- Fires when confirm.ts detects an event filled up between pay-click and
-- payment-confirm. Two templates:
--
--   payment_sold_out_treasurer  → every active branch_treasurer. Includes
--                                  the payment id, event, amount, and payer
--                                  so the treasurer can process a refund.
--   payment_sold_out_payer      → the user whose payment landed too late.
--                                  Explains they're on the waitlist and a
--                                  refund is being processed manually.
--
-- Design choice: no auto-refund. The branch wants a human to co-sign every
-- refund so the audit trail stays clean — the treasurer is the designated
-- co-signer per CLIENT_REQUIREMENTS section P.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('payment_sold_out_treasurer',
   'Payment — event sold out, refund required',
   'Fires to every active branch treasurer when a paid event filled up between pay-click and confirmation. The payer has been added to the waitlist; treasurer must process the refund manually.',
   ARRAY['inapp','email']::text[],
   'Refund required — {{event_title}} sold out before payment landed',
   E'Hi {{first_name}},\n\nA payment landed after "{{event_title}}" reached capacity. The payer has been auto-waitlisted and now needs a refund.\n\n  Payer:          {{payer_name}} ({{payer_email}})\n  Amount:         ₹{{amount_rupees}}\n  Payment ID:     {{payment_id}}\n  SabPaisa Txn:   {{sabpaisa_txn_id}}\n  Event:          {{event_title}} on {{event_date}}\n\nProcess the refund from the admin console → Refunds queue. The payment is flagged `needs_refund = event_full_after_payment`.\n\n{{refund_queue_link}}\n\n— ICAI Nagpur Portal',
   'Refund required: {{event_title}}',
   '{{payer_name}} — ₹{{amount_rupees}}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('payment_sold_out_payer',
   'Payment — event filled before payment confirmed',
   'Fires to the user whose payment confirmed after the event filled up. They are on the waitlist; the branch treasurer will process a refund manually.',
   ARRAY['inapp','email']::text[],
   'We received your payment, but {{event_title}} filled up — refund being processed',
   E'Hi {{first_name}},\n\nYour payment of ₹{{amount_rupees}} for "{{event_title}}" was received, but by the time it reached us the event had filled up. We''re sorry about the mix-up.\n\nWhat happens next:\n\n  • You''re on the waitlist. If a seat opens up, we''ll let you know first.\n  • The branch treasurer will process your refund manually. You should see the amount back on the original payment method within 5–7 business days.\n  • Keep this payment ID handy for any queries: {{payment_id}}\n\nIf you don''t see the refund by {{refund_eta_date}}, reply to this email or write to nagpur@icai.org and we''ll chase it up.\n\n— ICAI Nagpur Branch (WIRC)',
   'Payment received but event full — refund being processed',
   '{{event_title}} — ₹{{amount_rupees}}')
ON CONFLICT (key) DO NOTHING;
