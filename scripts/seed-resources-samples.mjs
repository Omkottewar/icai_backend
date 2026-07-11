// Seeds a small, realistic set of e-journal issues + paper presentations
// so the /resources page has something meaningful for a visitor to browse.
//
// Without this the Resources page shows only the top category tiles and
// the newsletter grid — the "E-Journal Archive" and "Paper Presentations"
// sections stay empty (the ejournal section is conditionally rendered and
// hides entirely when there are no rows).
//
// What this does:
//   1. Ensures the closed topic taxonomy exists in resource_topics.
//   2. Upserts 5 quarterly e-journal issues (last 5 quarters, ending in
//      the current quarter) and tags each with 2–3 topics.
//   3. Upserts 6 paper presentations covering GST 2.0, Ind AS 117,
//      faceless assessments, PMLA/IFSCA, AI in audit, and CBAM. Each is
//      status='published', hidden=false, so it shows up on /resources.
//
// Idempotent — every insert is UPSERT on the unique `slug` column. Safe
// to re-run to tweak copy or add more items.
//
// Usage:
//   node scripts/seed-resources-samples.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

// ─── Topic taxonomy ──────────────────────────────────────────────────────
// Same codes used by scripts/seed-mock-data.mjs — keep them aligned so a
// re-run of either script doesn't fight over the taxonomy.
const TOPICS = [
  ["GST",       "Goods & Services Tax"],
  ["DT",        "Direct Tax"],
  ["IT",        "Information Technology"],
  ["AUDIT",     "Auditing & Assurance"],
  ["CORP_LAW",  "Corporate Law"],
  ["FEMA",      "FEMA & International Tax"],
  ["IND_AS",    "Ind AS / IFRS"],
  ["BFSI",      "Banking & Insurance"],
  ["FORENSIC",  "Forensic Accounting"],
  ["VALUATION", "Valuation"],
];

// ─── E-journal issues (last 5 quarters, ending with current) ─────────────
function lastNQuarters(n) {
  const now = new Date();
  const curQ = Math.floor(now.getMonth() / 3) + 1;
  const curY = now.getFullYear();
  const out = [];
  let y = curY, q = curQ;
  for (let i = 0; i < n; i++) {
    out.push({ year: y, quarter: q });
    q -= 1;
    if (q === 0) { q = 4; y -= 1; }
  }
  return out;
}

const EJOURNAL_EDITORIALS = [
  {
    title:   "GST 2.0 — Rate Rationalisation & Compliance Playbook",
    summary: "The single biggest indirect-tax reset since 2017 lands mid-quarter. In this issue: what changes for the two-slab structure (5% and 18%), how the demerit-goods 40% band is drawn, the transition rules for input tax credit balances on the switchover date, and updated return schemas. Includes a practitioner walkthrough on advising SMEs whose tax outgo shifts materially — favourably or otherwise.",
    topicCodes: ["GST", "DT"],
  },
  {
    title:   "Ind AS 117 in the Real World — Insurance Contracts Applied",
    summary: "Two full reporting cycles into Ind AS 117 for Indian insurers, we look at what actually broke and what quietly worked. Coverage: contract boundaries in group health policies, the general measurement model vs. premium allocation approach in practice, and the disclosure trap most first-year audits missed. Guest commentary from CA-in-charge of a mid-tier insurer's first-year audit.",
    topicCodes: ["IND_AS", "AUDIT", "BFSI"],
  },
  {
    title:   "Faceless Assessments — Learning from 3 Years of Orders",
    summary: "A structured survey of 240 faceless assessment orders from the Vidarbha region — trends in additions sustained vs. reversed at first-appeal, the shift in evidence-gathering under Section 144B, and where the department is still dropping the ball on video-conferencing rights. Companion checklist for members on preparing a defensible reply within the 15-day window.",
    topicCodes: ["DT"],
  },
  {
    title:   "Forensic Angle in Statutory Audit — Beyond SA 240",
    summary: "How much forensic is 'enough' in a statutory audit? This issue argues that the post-COVID surge in related-party structuring has quietly changed what SA 240 diligence looks like on the ground. Practitioner notes on cash-flow triangulation, deepfake-invoice detection, and the emerging use of forensic-lite procedures in Tier-2 city audits.",
    topicCodes: ["AUDIT", "FORENSIC"],
  },
  {
    title:   "Valuation for Fast-Track M&A — 2026 Practice Notes",
    summary: "Post the ICAI Valuation Standards revision and the SEBI-mandated registered-valuer framework, we bring together practice notes from 5 recent Vidarbha-region transactions. Includes worked examples of DCF sensitivity ranges, treatment of ESOPs in enterprise value, and the disclosure protocol when a swing factor materially changes the concluded value.",
    topicCodes: ["VALUATION", "CORP_LAW"],
  },
];

// Deterministic slug: 'ejournal-2026-q3'.
function ejournalSlug(year, quarter) {
  return `ejournal-${year}-q${quarter}`;
}

function ejournalLabel(year, quarter) {
  const qNames = ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"];
  return `Vol ${year - 2023}, Issue ${quarter} — ${qNames[quarter - 1]} ${year}`;
}

// ─── Paper presentations ─────────────────────────────────────────────────
// Speaker names are real-sounding practitioners; committee_tag is the
// legacy free-text tag used by the resources page for chip colour lookup.
const PAPERS = [
  {
    slug:          "gst-2-0-rate-rationalisation-primer",
    title:         "GST 2.0 — Rate Rationalisation Primer & Transitional ITC",
    speaker_name:  "CA Rajesh Loya",
    author_designation: "Partner, Loya & Loya",
    committee_tag: "GST",
    presented_on:  "2026-06-18",
    topicCodes:    ["GST"],
    abstract:
      "Walks through the mid-2026 GST rate reset — the collapse to a two-slab (5% / 18%) structure with a 40% demerit-goods band, the transitional rules for closing ITC balances, and the compliance shifts for practitioners advising SMEs. Includes worked examples for restaurants, textiles and building materials — the three sectors with the largest rate delta.",
    description:
      "### Overview\n\nThe rate rationalisation announced in the 55th GST Council meeting is the most substantive tax reset since the original 2017 rollout. This presentation was delivered at the branch CPE meet on **18 June 2026** and walks through both the *structural* changes and the *transitional mechanics* that practitioners will spend the next two quarters wrestling with.\n\n### Sector deep-dives\n\n1. **Restaurants** — the shift from 5% (without ITC) to 18% (with ITC) reworks the entire pricing model. Members with mid-scale QSR clients should re-run the ITC accretion vs. menu-price elasticity for both dine-in and delivery.\n2. **Textiles** — the inverted-duty structure that plagued job-workers since 2017 is finally addressed. Practical guidance on filing the transition refund claim before the 90-day window closes.\n3. **Building materials** — cement stays at 28% (in effect) while sanitary-ware moves to 18%. The mixed-supply implications for turnkey builders are non-trivial.\n\n### Transitional ITC\n\nSection 140-style transitional credit provisions apply. Members must file the transitional-credit statement within 60 days of the effective date; unreported balances lapse. The Council's clarification circular is expected in the next fortnight.",
  },
  {
    slug:          "ind-as-117-first-year-audit-lessons",
    title:         "Ind AS 117 — First-Year Audit Lessons for Insurers",
    speaker_name:  "CA Meenakshi Deshmukh",
    author_designation: "Partner, Deshmukh Kale & Co.",
    committee_tag: "Audit",
    presented_on:  "2026-05-14",
    topicCodes:    ["IND_AS", "AUDIT", "BFSI"],
    abstract:
      "Practitioner review of the first-year audit lessons under Ind AS 117 — including boundary determination in group health, choice between the general measurement model and PAA, and the transition disclosures that most 2025 audits missed. Draws on the presenter's engagement work with a mid-tier general insurer.",
    description:
      "### Why this session matters now\n\nInd AS 117 became mandatory for Indian insurers with reporting periods starting **1 April 2024**. The 2025 first-year audits are complete — and there are consistent lessons emerging across audit files that will bite in the second-year audit if unaddressed.\n\n### The three high-risk areas\n\n1. **Contract boundaries in group policies** — every renewable group health policy needs a contract-boundary assessment. In practice, most first-year files assumed a single-year boundary without documenting why.\n2. **PAA vs. GMM eligibility** — the premium allocation approach shortcut is only available if coverage is ≤ 1 year *or* results are 'not materially different' from the GMM. The latter test is where most files skimped on evidence.\n3. **Disclosure of confidence level of the risk adjustment** — a mandatory disclosure that a surprising number of first-year files left blank.\n\n### Practical checklist for year-2\n\n- Contract boundary memo, dated and signed off by the actuarial function\n- PAA-eligibility test worked out for each portfolio\n- Reconciliation of the CSM (Contractual Service Margin) roll-forward with the P&L unwind\n- Confidence-level disclosure with the methodology used to derive it",
  },
  {
    slug:          "faceless-appeals-strategy-2026",
    title:         "Faceless Appeals — Strategy Notes from 3 Years of Orders",
    speaker_name:  "CA Vikram Choudhary",
    author_designation: "Senior Partner, Sharma Choudhary & Associates",
    committee_tag: "Direct Tax",
    presented_on:  "2026-04-22",
    topicCodes:    ["DT"],
    abstract:
      "A structured survey of 240 faceless assessment and appeal orders from the Vidarbha region, categorised by additions sustained, reversed, or partly modified. Extracts the top 10 grounds on which the department consistently loses at first-appeal — and the top 5 where it consistently wins.",
    description:
      "### Methodology\n\nThe survey covers **240 orders** issued under Section 144B and Section 250 for AY 2020-21 to AY 2023-24, sourced from members practising in the Nagpur / Amravati / Chandrapur region. Each order was coded against 15 dimensions — nature of addition, quality of show-cause, reply-window granted, VC availed, and disposal outcome.\n\n### Top losing grounds for the department\n\n1. Additions under 68/69 without confronting the taxpayer with the primary evidence — 78% reversal rate on appeal.\n2. Denial of TDS credit on procedural grounds despite Form 26AS reconciliation.\n3. Section 14A additions without recording satisfaction as required by *Maxopp Investment*.\n\n### Top winning grounds for the department\n\n1. Cash deposits during demonetisation without a satisfactory source explanation (89% sustained).\n2. Bogus purchase additions where the taxpayer failed to produce transport documents.\n\n### Members' playbook\n\nA 15-day reply window is workable if the file is prepared before the notice. The presentation includes a template *ready-response bank* for the six most-common show-cause categories.",
  },
  {
    slug:          "ai-in-statutory-audit-2026",
    title:         "AI in Statutory Audit — Where It Actually Helps, and Where It Doesn't",
    speaker_name:  "CA Anand Iyer",
    author_designation: "Partner, Iyer Naidu Advisory LLP",
    committee_tag: "Audit",
    presented_on:  "2026-03-11",
    topicCodes:    ["AUDIT", "IT"],
    abstract:
      "An unvarnished practitioner assessment of AI-assisted audit tooling — 100% JE sampling, embedding-based anomaly detection, and LLM-drafted management representation letters. What works, what breaks under partner review, and how to keep the file audit-defensible when part of the substantive work is machine-generated.",
    description:
      "### The claim vs. the reality\n\nVendors have been selling 'AI audit' since 2023. Two full audit seasons in, the honest picture is: some techniques are now routine and add value; others create more review work than they save.\n\n### What works\n\n- **100% journal-entry testing** with embedding-based clustering to surface unusual postings. Replaces sample-based JE testing under SA 240 and produces a defensible outlier list.\n- **Confirmation reconciliation** via structured extraction from bank/creditor confirmations.\n- **Analytical review at the account-level** using time-series anomaly detection — flags month-end reversals and cut-off games.\n\n### What doesn't (yet)\n\n- LLM-drafted audit conclusions. They confabulate references and paragraph numbers.\n- LLM-drafted management representation letters. Legal counsel should still be in the loop.\n- Automated risk-assessment memos — SA 315 requires exercise of *professional* judgement.\n\n### The documentation trap\n\nSA 230 requires the file to record the *nature, timing and extent* of procedures. If part of your substantive work is machine-generated, the file must record the prompt, the model version, the input dataset hash, and the reviewer sign-off. Most audit files aren't there yet.",
  },
  {
    slug:          "cbam-and-eu-carbon-reporting",
    title:         "EU CBAM — What Indian Exporters (and Their CAs) Need to Know",
    speaker_name:  "CA Priya Rathi",
    author_designation: "Partner, Rathi Jain & Partners",
    committee_tag: "Direct Tax",
    presented_on:  "2026-02-19",
    topicCodes:    ["FEMA", "CORP_LAW"],
    abstract:
      "The EU's Carbon Border Adjustment Mechanism moves out of its transitional reporting phase in 2026. Iron & steel, cement, aluminium, fertilizer, hydrogen and electricity exporters — many with meaningful Vidarbha-region presence — face a real cash-cost per tonne. Practical primer on embedded-emissions calculation, verification, and the CBAM certificate purchase flow.",
    description:
      "### Why Nagpur CAs should care\n\nCentral India has a concentrated footprint in the CBAM-covered sectors — Vidarbha cement, Chandrapur steel and Butibori-cluster ferro-alloys are all in scope. Exporters who treated the 2023–2025 reporting phase as a form-filling exercise are about to discover it now has a **euro-denominated cash cost per tonne**.\n\n### Embedded emissions — the technical piece\n\nDirect (Scope 1) emissions are computed at the installation level; indirect (Scope 2) emissions are computed for cement and fertilizer using a country-average electricity emissions factor unless the exporter can substantiate a lower plant-specific number.\n\n### The verification requirement\n\nFrom 1 January 2026, embedded emissions must be verified by an EU-accredited verifier. The scarcity of these verifiers in India means members should be advising clients to lock in verification slots at least six months ahead of the annual CBAM declaration deadline.\n\n### CBAM certificates — the money question\n\nOne CBAM certificate covers 1 tCO₂e. Weekly certificate price is published by the European Commission. Members should model the annual cash outflow for their exporter clients — it's a real cash-flow item now, not a compliance line.",
  },
  {
    slug:          "pmla-and-cas-2026",
    title:         "PMLA & the CA — Practitioner Obligations After the 2023 Amendment",
    speaker_name:  "CA Sandeep Bhagchandka",
    author_designation: "Partner, Mundra & Bhagchandka",
    committee_tag: "Direct Tax",
    presented_on:  "2026-01-15",
    topicCodes:    ["CORP_LAW", "FEMA"],
    abstract:
      "The May-2023 PMLA amendment brought CAs, CSs and CMAs squarely within the reporting-entity net for a specified set of activities. Session covers the trigger activities, the KYC / CDD requirements, record-keeping horizons, and the interaction with ICAI's parallel Code of Ethics obligations.",
    description:
      "### The five trigger activities\n\nCAs (and CSs / CMAs) are 'reporting entities' under PMLA when they engage in — on behalf of a client — any of:\n\n1. Buying / selling immovable property\n2. Managing client money, securities or assets\n3. Managing bank / savings / securities accounts\n4. Organising contributions for company formation or operation\n5. Creating / operating / managing companies, LLPs or trusts (including nominee arrangements)\n\nIf your engagement doesn't touch any of these, you are outside the reporting-entity perimeter.\n\n### If you are inside the perimeter\n\n- **KYC / CDD** at onboarding, refreshed on a risk-weighted cycle.\n- **Beneficial-ownership identification** — required, not optional.\n- **Record retention** — 5 years post the end of the client relationship.\n- **Suspicious Transaction Reports** to FIU-IND — the reporting timeline is 7 working days from the date the transaction is deemed suspicious.\n\n### The ethics overlay\n\nICAI's Code of Ethics imposes a separate confidentiality obligation. The PMLA carve-out for STR filing is narrow — members should document the assessment that led to the filing decision to defend it under an ICAI disciplinary proceeding.",
  },
];

async function upsertTopics() {
  const idByCode = new Map();
  let inserted = 0, updated = 0;
  for (let i = 0; i < TOPICS.length; i++) {
    const [code, name] = TOPICS[i];
    const [row] = await sql`
      INSERT INTO resource_topics (code, name, sort_order, active)
      VALUES (${code}, ${name}, ${i}, true)
      ON CONFLICT (code) DO UPDATE SET
        name       = EXCLUDED.name,
        sort_order = EXCLUDED.sort_order,
        active     = true
      RETURNING id, (xmax = 0) AS inserted
    `;
    idByCode.set(code, row.id);
    if (row.inserted) inserted++; else updated++;
  }
  console.log(`✓ Topics — ${inserted} created, ${updated} updated`);
  return idByCode;
}

async function upsertEjournalIssues(topicIdByCode) {
  const quarters = lastNQuarters(EJOURNAL_EDITORIALS.length);
  let inserted = 0, updated = 0;
  for (let i = 0; i < EJOURNAL_EDITORIALS.length; i++) {
    const q = quarters[i];
    const meta = EJOURNAL_EDITORIALS[i];
    const slug = ejournalSlug(q.year, q.quarter);
    const label = ejournalLabel(q.year, q.quarter);
    // Published date roughly at the end of the quarter (last day of the
    // second month) — good enough for "sort by year/quarter desc" ordering.
    const publishedAt = new Date(q.year, q.quarter * 3 - 2, 28).toISOString();

    const [row] = await sql`
      INSERT INTO ejournal_issues (
        slug, title, issue_label, issue_year, issue_quarter,
        editorial_summary, status, published_at, view_count
      ) VALUES (
        ${slug}, ${meta.title}, ${label}, ${q.year}, ${q.quarter},
        ${meta.summary}, 'published', ${publishedAt}, ${50 + i * 17}
      )
      ON CONFLICT (slug) DO UPDATE SET
        title             = EXCLUDED.title,
        issue_label       = EXCLUDED.issue_label,
        editorial_summary = EXCLUDED.editorial_summary,
        published_at      = EXCLUDED.published_at,
        status            = 'published',
        hidden            = false,
        updated_at        = now()
      RETURNING id, (xmax = 0) AS inserted
    `;
    if (row.inserted) inserted++; else updated++;

    // Refresh topic tags — wipe & re-insert so re-runs don't accumulate.
    await sql`DELETE FROM ejournal_topics WHERE issue_id = ${row.id}`;
    for (const code of meta.topicCodes) {
      const topicId = topicIdByCode.get(code);
      if (!topicId) continue;
      await sql`
        INSERT INTO ejournal_topics (issue_id, topic_id)
        VALUES (${row.id}, ${topicId})
        ON CONFLICT DO NOTHING
      `;
    }
  }
  console.log(`✓ E-journal issues — ${inserted} created, ${updated} updated`);
}

async function upsertPapers(topicIdByCode) {
  let inserted = 0, updated = 0;
  for (const p of PAPERS) {
    // Published date = a few days after the presentation date so the
    // "most recent" sort order matches the presented_on ordering.
    const presentedOn = new Date(p.presented_on);
    const publishedAt = new Date(presentedOn.getTime() + 3 * 86400 * 1000).toISOString();

    const [row] = await sql`
      INSERT INTO paper_presentations (
        slug, title, abstract, description,
        speaker_name, author_designation, committee_tag,
        presented_on, status, published_at, view_count, hidden
      ) VALUES (
        ${p.slug}, ${p.title}, ${p.abstract}, ${p.description},
        ${p.speaker_name}, ${p.author_designation}, ${p.committee_tag},
        ${p.presented_on}, 'published', ${publishedAt}, ${20 + Math.floor(Math.random() * 180)}, false
      )
      ON CONFLICT (slug) DO UPDATE SET
        title              = EXCLUDED.title,
        abstract           = EXCLUDED.abstract,
        description        = EXCLUDED.description,
        speaker_name       = EXCLUDED.speaker_name,
        author_designation = EXCLUDED.author_designation,
        committee_tag      = EXCLUDED.committee_tag,
        presented_on       = EXCLUDED.presented_on,
        published_at       = EXCLUDED.published_at,
        status             = 'published',
        hidden             = false,
        updated_at         = now()
      RETURNING id, (xmax = 0) AS inserted
    `;
    if (row.inserted) inserted++; else updated++;

    // Refresh topic tags.
    await sql`DELETE FROM paper_topics WHERE paper_id = ${row.id}`;
    for (const code of p.topicCodes) {
      const topicId = topicIdByCode.get(code);
      if (!topicId) continue;
      await sql`
        INSERT INTO paper_topics (paper_id, topic_id)
        VALUES (${row.id}, ${topicId})
        ON CONFLICT DO NOTHING
      `;
    }
  }
  console.log(`✓ Paper presentations — ${inserted} created, ${updated} updated`);
}

try {
  const topicIdByCode = await upsertTopics();
  await upsertEjournalIssues(topicIdByCode);
  await upsertPapers(topicIdByCode);
  console.log("\n───────────────────────────────────────────────");
  console.log("✓ Resources sample data seeded");
  console.log("───────────────────────────────────────────────\n");
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
