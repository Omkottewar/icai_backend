// Seeds 5 realistic ICAI Nagpur Branch newsletters covering recent months.
//
// The branch newsletter is a monthly PDF publication that goes to every
// member. Each seeded issue carries:
//   • a real-life editor's note that ties to what actually happened that
//     month (deadlines, events, judgments) — dated relative to "now" so
//     they always look current no matter when this seed runs.
//   • issue_month / issue_year populated so the archive lists them in
//     reverse chronological order.
//   • No PDF file yet — pdf_file_id stays NULL. Upload the real PDF via
//     /admin/newsletters when you have it; the editor's note carries the
//     archive listing until then.
//
// Idempotent — the branch_newsletters_issue_uq index means the same
// (year, month) can't be inserted twice. Existing issues are UPDATEd.
//
// Usage:
//   node scripts/seed-newsletters.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

// Anchor everything to "now" so the archive always shows recent issues.
// Issue #1 = current month; then 4 back-issues stretching into the past.
const now = new Date();
const cur = { m: now.getMonth() + 1, y: now.getFullYear() };
const monthsBack = (n) => {
  const d = new Date(now);
  d.setMonth(d.getMonth() - n);
  return { m: d.getMonth() + 1, y: d.getFullYear() };
};

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const NEWSLETTERS = [
  {
    ...cur,
    title: `Nagpur Branch Newsletter — ${MONTH_NAMES[cur.m]} ${cur.y}`,
    editor_note:
`Members, another packed month at the branch — thank you for your continued participation.

Highlights inside this issue:
• Coverage of the two-day GST Annual Return workshop held at Hotel Centre Point — 240+ registrations across the state.
• Practitioner note on Section 43B(h) MSME payment deductibility from CA Rajendra Sarda.
• WICASA foundation mock-test series results — top 10 rankers announced on page 8.
• Reminder: half-yearly UDIN reconciliation deadline is approaching. See the members' service update on page 3.
• Newly-passed grievance response from the branch on the reading-room booking flow.

We invite article contributions from members and students — email nagpur@icai.org with a 300-word abstract by the 25th of every month.

Warm regards,
Editorial Team, ICAI Nagpur Branch`,
    hidden: false,
  },
  {
    ...monthsBack(1),
    title: `Nagpur Branch Newsletter — ${MONTH_NAMES[monthsBack(1).m]} ${monthsBack(1).y}`,
    editor_note:
`This issue focuses on the Indirect Tax Half-Year in Review.

Key contents:
• Digest of every GST Council recommendation from the last six months, mapped to CGST Act sections and CBIC circulars.
• Case-law roundup: Safari Retreats (Supreme Court) — construction ITC and the Section 17(5)(d) 'plant' interpretation.
• 'From the Chairperson's desk' — a note on the branch's Vision 2030 roadmap and the upcoming Chitnavis Centre digitisation initiative.
• Committee news: the Direct Tax study circle now meets every alternate Saturday — join through the branch portal.
• Member benevolent fund (CABF): monthly disbursement summary and how members can contribute.

The full technical article on 'ITC Reversal — Rule 42/43 Complications' by CA Pramod Diwan begins on page 12.

— Editorial Team`,
    hidden: false,
  },
  {
    ...monthsBack(2),
    title: `Nagpur Branch Newsletter — ${MONTH_NAMES[monthsBack(2).m]} ${monthsBack(2).y}`,
    editor_note:
`Direct Tax Special Issue.

This month's newsletter walks members through the Income-tax return-filing cycle end-to-end for AY 2026-27:
• Schema changes across ITR-1 to ITR-7 with a comparison table.
• Faceless assessment — the auditor's guide to representing clients before the National Faceless Assessment Centre (NFAC).
• Section 44AD / 44ADA presumptive schemes — computation examples with the 6% / 8% dichotomy for digital vs cash receipts.
• Transfer pricing: master file and CbCR thresholds updated after Finance (No. 2) Act 2024.
• 'Ask the Panel' — six questions on TDS on rent, interest on housing loan, and Section 115BAC opt-in/opt-out.

Save the date: annual regional conference on 15-16 of next month at Hotel Tuli Imperial — early-bird registration closes on the 25th.

— Editorial Team`,
    hidden: false,
  },
  {
    ...monthsBack(3),
    title: `Nagpur Branch Newsletter — ${MONTH_NAMES[monthsBack(3).m]} ${monthsBack(3).y}`,
    editor_note:
`Audit & Assurance Focus.

Contents:
• Ready-reference guide to CARO 2020 clauses, mapped against Companies Act sections and typical audit assertions.
• SA 315 (Revised) — practitioner walkthrough on identifying and assessing risks of material misstatement in mid-market audits.
• Independence pitfalls: three real cases where firms lost the audit tender for undisclosed related-party services.
• 'Peer Review Corner' — checklist of documentation gaps most commonly flagged during peer reviews at Nagpur firms.
• Book review: 'Auditing IT Systems' by CA Nayan Doshi — recommended for members handling BFSI clients.

Regulatory tracker: NFRA circulars, IND AS amendments effective from April, and MCA notifications relevant for statutory auditors.

— Editorial Team`,
    hidden: false,
  },
  {
    ...monthsBack(4),
    title: `Nagpur Branch Newsletter — ${MONTH_NAMES[monthsBack(4).m]} ${monthsBack(4).y}`,
    editor_note:
`Members' Networking & Practice Management Edition.

Inside:
• Annual Members' Meet recap — 480+ members attended, panel discussions on 'AI in CA Practice' and 'Building a Boutique Practice'.
• Practice management: interview with CA Sonali Mahajan on scaling a two-partner firm to twelve associates in five years.
• WICASA update: coding-for-CAs workshop series launched; Python for data-heavy assignments walkthroughs are now archived under the portal's Resources section.
• Sports Day results — cricket, chess, and table-tennis winners across the members and student categories.
• Career pulse: five industry openings at Nagpur-based firms, three articleship vacancies at chartered firms.

Members contributing articles for next month's issue can submit through the portal (/resources/submit) — abstracts under 300 words.

— Editorial Team`,
    hidden: false,
  },
];

try {
  let inserted = 0, updated = 0;

  for (const n of NEWSLETTERS) {
    const [existing] = await sql`
      SELECT id FROM branch_newsletters WHERE issue_year = ${n.y} AND issue_month = ${n.m} LIMIT 1
    `;

    if (existing) {
      await sql`
        UPDATE branch_newsletters
           SET title       = ${n.title},
               editor_note = ${n.editor_note},
               hidden      = ${n.hidden},
               published_at = COALESCE(published_at, now()),
               updated_at  = now()
         WHERE id = ${existing.id}
      `;
      console.log(`= updated: ${n.title}`);
      updated++;
    } else {
      await sql`
        INSERT INTO branch_newsletters (
          title, issue_month, issue_year, editor_note, hidden, published_at
        ) VALUES (
          ${n.title}, ${n.m}, ${n.y}, ${n.editor_note}, ${n.hidden}, now()
        )
      `;
      console.log(`+ created: ${n.title}`);
      inserted++;
    }
  }

  console.log("\n───────────────────────────────────────────────");
  console.log(`✓ Newsletters — ${inserted} created, ${updated} updated`);
  console.log("───────────────────────────────────────────────\n");
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
