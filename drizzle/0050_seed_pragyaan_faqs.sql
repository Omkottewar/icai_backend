-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0050 — Seed Pragyaan FAQ site_content slots
--
-- Seeds the four faq_* site_content rows that back Pragyaan's starter chips.
-- Without these rows the chatbot answers "I don't know" when a visitor clicks
-- "What member benefits does the branch provide?" or any other starter, because
-- the KB had no content covering those topics.
--
-- Idempotent — ON CONFLICT keeps any admin edits the slot may already have.
-- The bodies mirror frontend/src/hooks/useSiteContent.js SITE_CONTENT_DEFAULTS
-- so the public site and the chatbot agree on what the branch tells visitors.
--
-- After applying this migration, run `npm run pragyaan:ingest` to push these
-- four bodies into kb_sources + kb_chunks (or wait for the scheduled job).
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO site_content (slug, data) VALUES
  ('faq_branch_services', jsonb_build_object('body',
$body$### How do I register for a branch event?
Open the **Events** page from the top nav, pick the event you want, and click **Register**. CPE events show the fee and seat availability inline. Logged-in members can pay by card or UPI; receipts and the e-ticket are emailed.

### Where can I find the latest branch newsletter?
The most recent issue is on the **Newsletter** page. Past issues are linked from the same page in reverse-chronological order — open any to read or download the PDF.

### How do I contact the branch office?
The **Contact** page lists the branch address, phone, email and Google Maps location. Office hours are Mon–Sat 10:30–18:00. For event-specific queries, the event page lists the committee owner; for grievances, use the **Grievance form** on the Contact page (48-hour SLA).

### How do I claim CPE hours for an attended event?
CPE hours auto-credit to your ICAI member ID once the branch closes attendance for the event (usually within 5 working days). Log in to the portal and open **My CPE** to see the running total, certificates and individual event breakdown. If hours are missing 7 days after the event, raise a grievance from the Contact page.$body$
  )),
  ('faq_for_members', jsonb_build_object('body',
$body$### What member benefits does the branch provide?
Every Nagpur Branch member gets:
- **Member-only CPE rates** on branch programmes (typically 30–50% off the public fee)
- **Free access** to the branch library (4,200+ titles) and reading room
- **Networking events** — annual members' meet, Sports day, family events
- **Empanelment opportunities** circulated when assignments come in
- **CABF assistance** (Chartered Accountants Benevolent Fund) for members and their families in distress
- **Mentoring/guidance** for new practitioners through the Members in Industry & Practice cells
- **Curated knowledge digests** on tax, audit and regulatory updates emailed monthly

### How do I update my membership details?
Personal details (address, phone, email, firm) are maintained on the **ICAI Self-Service Portal** (eservices.icai.org). Log in with your member ID → *Edit Member Profile*. Changes propagate to the branch within 24 hours. For corrections to records the branch holds locally (e.g., CPE attribution mismatches), email the branch office or raise a grievance.

### Where are the latest professional standards circulars?
The **Resources** section on the branch portal mirrors the head-office Professional Standards, Auditing & Accounting, and Direct/Indirect Tax circulars the branch has formally summarised for members. For the authoritative original notification, follow the link to icai.org. The branch newsletter also flags the month's most important regulatory changes on page 1.

### How do I claim CPE hours for an attended event?
CPE hours auto-credit to your ICAI member ID once the branch closes attendance for the event (usually within 5 working days). Open **My CPE** in the portal to see the running total and certificates. If hours are missing 7 days after the event, raise a grievance from the Contact page.$body$
  )),
  ('faq_for_students', jsonb_build_object('body',
$body$### What are the articleship registration steps?
1. Clear **CA Foundation** (or qualify via direct-entry route).
2. Complete **ICITSS — Orientation + ITT** (15 days each) before joining a principal. The branch runs ITT/Orientation batches every month — check the **Events** page for the next batch.
3. Find a principal (CA in practice) and execute **Form 102/103** within 30 days of joining.
4. Submit Form 103 to the Regional Office (WIRC) along with proof of ICITSS, your registration fee and the principal's declaration.
5. The branch helps with form review and submission — bring your documents to the office Mon–Sat 10:30–18:00.

### When are the next CA exam dates?
ICAI conducts CA Foundation, Intermediate and Final exams in **May and November** every year. Exact dates are notified by the Examination Department (icai.org/exam) about 4 months before each cycle. The branch republishes the dates on the homepage ticker and on the **Announcements** page as soon as the head office notifies them.

### What student resources does the branch offer?
- **Mock test series** before every exam cycle — both physical (at the branch) and online
- **Subject-wise revision lectures** by senior faculty
- **WICASA** (Western India Chartered Accountants Students Association) — sports, cultural and academic events
- **Career counselling** sessions for new entrants
- **Free reading room** access (80 seats) and a digital library
- **Articleship matchmaking** — student-employer registry maintained by the branch
- Past test papers, suggested answers and study materials in the **Resources** section

### How do I get my CPE/ITT details?
- **CPE hours (members)** — log in to the portal → **My CPE**.
- **ITT/Orientation completion (students)** — certificates are issued by the branch on completion; a digital copy is emailed and a physical one is available at the branch office. Lost certificate? Raise a grievance with your batch dates.$body$
  )),
  ('faq_for_employers', jsonb_build_object('body',
$body$### How can my firm post a job opening?
Verified employers (CA firms and corporates) can post openings via the **Employer Portal** — log in, click **Post a Job**, and submit the role description, vacancy count, location, qualification, experience band and the closing date. Postings are reviewed by the branch within one working day and stay live for 30 days (extendable). A per-post fee applies; the current fee schedule is shown on the post-creation page.

### How do I recruit articled assistants through the branch?
1. **Verify your firm** with the branch (one-time KYC — proof of firm registration + principal's ICAI number).
2. List your **Articleship vacancies** under the same Employer Portal — separate flow from full-time roles.
3. Browse the **Student Registry** — students who've completed ICITSS and are looking for placement.
4. Use the in-app messaging to schedule interviews and exchange Form 102.
5. The branch runs **campus drives** during ITT batches — register your firm to participate.

### What employer services does the branch offer?
- **Job-posting platform** (jobs + articleship vacancies)
- **Verified-employer badge** after one-time KYC
- **Empanelment listings** — branch-curated assignments for empanelled firms
- **Member directory access** for empanelling associates/consultants
- **CPE programme sponsorship** — branded sessions for your team at the branch
- **Annual employer meet** — networking with the active practitioner community
For pricing and to begin verification, contact the branch office (Contact page).$body$
  ))
ON CONFLICT (slug) DO NOTHING;
