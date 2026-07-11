// Seeds the two real scholarships the Nagpur Branch runs:
//
//   1. "Late Smt. Sunita Devi Suresh Kumar Agrawal Scholarship" — for
//      CA Final students. Merit-cum-need based, ₹1,000/month for 6
//      months, 2 awards per year. Sourced from the branch's own scheme.
//
//   2. "Late Shri V.K. Surana Memorial Scholarship" (VKS Foundation) —
//      50% of CA registration fee for 5 first-year students each year.
//      Funded by a ₹5 lakh corpus donated by V.K. Surana & Co.
//
// Idempotent — UPSERT on the unique `slug` column. Safe to re-run to
// tweak copy or bump deadlines.
//
// Usage:
//   node scripts/seed-scholarships.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

// Next-cycle deadline: whichever of 10 Aug / 10 Feb is soonest.
// Sunita Devi has two cycles per year:
//   • 10 Aug — for May exam (Oct–Mar term)
//   • 10 Feb — for Nov exam (Apr–Sep term)
function nextSunitaDeadline() {
  const now = new Date();
  const y = now.getFullYear();
  const candidates = [
    new Date(y,      1, 10, 23, 59, 59),  // 10 Feb this year
    new Date(y,      7, 10, 23, 59, 59),  // 10 Aug this year
    new Date(y + 1,  1, 10, 23, 59, 59),  // 10 Feb next year
  ];
  const nextD = candidates.find((d) => d > now);
  return nextD.toISOString();
}

const SCHOLARSHIPS = [
  {
    slug:               "sunita-devi-agrawal-scholarship",
    title:              "Late Smt. Sunita Devi Suresh Kumar Agrawal Scholarship",
    summary:            "Merit-cum-need based scholarship for CA Final students who qualified CA IPCC from the Nagpur centre with rank / topper distinction.",
    award_amount_paise: 6_00_000, // ₹6,000 total = ₹1,000/month × 6 months
    deadline_at:        nextSunitaDeadline(),
    applications_open:  true,
    active:             true,
    sort_order:         10,
    external_url:       null,
    eligibility:
`- Currently pursuing **CA Final**.
- Must have qualified **CA IPCC (Intermediate) from the Nagpur centre**.
- Must appear in the **ICAI Merit list of Rank holders** for that IPCC attempt.
  (If no rank holder from Nagpur in that cycle, the applicant with the **highest aggregate marks** in CA IPCC from the Nagpur centre is considered.)
- **Parents' total annual income must not exceed ₹1,80,000/-**.
- Copies of ICAI result / marksheet + income certificate required with the application.`,
    description:
`### About the Scholarship

The Nagpur Branch of WIRC of ICAI awards the **"Late Smt. Sunita Devi Suresh Kumar Agrawal Scholarship"** to two CA Final students each year, on a merit-cum-need basis. Announcements go out in the branch newsletter and this page twice a year.

### Award

- **₹1,000 per month for 6 months** (aggregate ₹6,000 per awardee).
- **2 scholarships** granted each year — one per exam cycle.
- Awarded twice a year in line with the two CA exam cycles (May and November).

### Selection Process

1. Applications are received in the prescribed format on or before the deadline.
2. Verification of CA IPCC result and rank / merit-topper status from the Nagpur centre.
3. Income verification against the ₹1,80,000/- annual limit.
4. If two or more eligible candidates rank equally, preference is given to the student with lower family income.

### Deadlines

| Exam cycle | Term covered | Last date to apply |
|---|---|---|
| **May** attempt | Oct – Mar term | **10 August** |
| **November** attempt | Apr – Sep term | **10 February** |

### How to Apply

Use the branch application form (downloadable from this page or collect from the branch office at ICAI Bhawan, Dhantoli). Send the filled form with attachments — ICAI IPCC marksheet, ICAI Final registration proof, parents' income certificate — to the **Branch Chairperson, Nagpur Branch of WIRC of ICAI** before the deadline.

For clarifications: **nagpur@icai.org** or +91 712 244 3968.`,
  },
  {
    slug:               "vks-foundation-scholarship",
    title:              "Late Shri V.K. Surana Memorial Scholarship (VKS Foundation)",
    summary:            "50% of first-year CA registration fee for 5 deserving new students each year — instituted by VKS Foundation in memory of Late Shri V.K. Surana.",
    award_amount_paise: null,  // Amount varies with the CA registration fee each year
    deadline_at:        null,  // Rolling — 5 students selected each year by the branch
    applications_open:  true,
    active:             true,
    sort_order:         20,
    external_url:       null,
    eligibility:
`- Newly registering with ICAI in the current cycle (first-year Foundation / Intermediate registration).
- Financial need — supporting documents (parents' income affidavit or equivalent) must accompany the application.
- Studying / residing in Nagpur or Vidarbha (branch jurisdiction).
- Not concurrently receiving another registration-fee waiver.
- Final selection is by the Nagpur Branch of WIRC of ICAI. The Branch's decision is final and binding.`,
    description:
`### About the Scholarship

In honour of the late **Shri V.K. Surana**, founder-partner of **V.K. Surana & Co., Nagpur**, the **VKS Foundation** has instituted a corpus of **₹5 Lakhs** with the Nagpur Branch of WIRC of ICAI. The yield from this corpus (and any shortfall met by VKS Foundation) is deployed each year to support new CA aspirants who face financial constraints when registering with ICAI.

> "Financial constraints should not be a deterrent to students pursuing their dreams."
> — Late Shri V.K. Suranaji

### Award

- **50% of the first-year CA registration fee** for **5 deserving students**, selected each year by the Nagpur Branch.
- Direct fee waiver at the point of registration — the Branch remits the awardee's share to ICAI.
- Any shortfall in the corpus yield is topped up by VKS Foundation, so the 5-awardee count is guaranteed year on year.

### Selection Process

1. Applications reviewed by the branch's scholarship committee.
2. Verification of registration status with ICAI + income / need documents.
3. 5 candidates selected each year on the basis of demonstrated financial need and academic seriousness.
4. Award applied directly to the ICAI registration fee — awardees do not receive cash.

### How to Apply

Fill the application through the portal, or collect the physical form from the branch office. Documents required:

- Proof of ICAI registration (or intent-to-register acknowledgement).
- Parents' income affidavit or bank statement.
- Latest marksheet (10th / 12th / graduation, whichever is latest).
- Short 100-word statement of intent.

For clarifications: **nagpur@icai.org** or +91 712 244 3968. VKS Foundation office: C/o V.K. Surana & Co., VCA Complex, Civil Lines, Nagpur — 440001.`,
  },
];

try {
  let inserted = 0, updated = 0;
  for (const s of SCHOLARSHIPS) {
    const [existing] = await sql`SELECT id FROM scholarships WHERE slug = ${s.slug} LIMIT 1`;
    if (existing) {
      await sql`
        UPDATE scholarships SET
          title              = ${s.title},
          summary            = ${s.summary},
          description        = ${s.description},
          eligibility        = ${s.eligibility},
          award_amount_paise = ${s.award_amount_paise},
          deadline_at        = ${s.deadline_at},
          applications_open  = ${s.applications_open},
          external_url       = ${s.external_url},
          active             = ${s.active},
          sort_order         = ${s.sort_order},
          updated_at         = now()
        WHERE id = ${existing.id}
      `;
      console.log(`= updated: ${s.title}`);
      updated++;
    } else {
      await sql`
        INSERT INTO scholarships (
          slug, title, summary, description, eligibility,
          award_amount_paise, deadline_at, applications_open,
          external_url, active, sort_order
        ) VALUES (
          ${s.slug}, ${s.title}, ${s.summary}, ${s.description}, ${s.eligibility},
          ${s.award_amount_paise}, ${s.deadline_at}, ${s.applications_open},
          ${s.external_url}, ${s.active}, ${s.sort_order}
        )
      `;
      console.log(`+ created: ${s.title}`);
      inserted++;
    }
  }

  console.log("\n───────────────────────────────────────────────");
  console.log(`✓ Scholarships — ${inserted} created, ${updated} updated`);
  console.log("───────────────────────────────────────────────\n");
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
