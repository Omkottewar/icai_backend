// Seed ONE complete demo mock test for showcasing the online-attempt flow.
//
// Inserts a fully populated, online-enabled mock test (10 questions: 8 MCQ +
// 1 numerical + 1 short-answer) so the end-to-end student experience —
// register → attempt → auto-grade → review — can be demoed in one click.
//
// Idempotent: re-running will detect the existing demo by its unique title
// and exit without duplicating rows. To re-seed cleanly, delete by title:
//   DELETE FROM mock_tests WHERE title = '[DEMO] Online Mock — CA Intermediate Advanced Accounting';
//
// Prereqs:
//   - DATABASE_URL (or SUPABASE_URL) in .env
//   - At least one active branch row
//
// Usage:
//   node scripts/seed-demo-mock-test.mjs

import "dotenv/config";
import postgres from "postgres";

const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL or SUPABASE_URL is required");
  process.exit(1);
}

const sql = postgres(DB_URL, { ssl: DB_URL.includes("supabase") ? "require" : undefined });

const DEMO_TITLE = "[DEMO] Online Mock — CA Intermediate Advanced Accounting";
const DEMO_SERIES = "DEMO-INTER-2026";

const QUESTIONS = [
  {
    type: "mcq",
    marks: 2,
    negative: 0.5,
    topic: "AS 10 — Property, Plant & Equipment",
    difficulty: "easy",
    body: "As per AS 10, the cost of an item of Property, Plant and Equipment includes which of the following?",
    options: [
      { label: "A", body: "Initial estimate of the cost of dismantling and removing the item.", correct: true },
      { label: "B", body: "Cost of opening a new facility.", correct: false },
      { label: "C", body: "Costs of conducting business in a new location.", correct: false },
      { label: "D", body: "Administration and other general overhead costs.", correct: false },
    ],
    explanation: "AS 10 requires the initial estimate of dismantling/removal/restoration costs to be capitalised. The other items are explicitly excluded from cost.",
  },
  {
    type: "mcq",
    marks: 2,
    negative: 0.5,
    topic: "AS 2 — Inventories",
    difficulty: "easy",
    body: "Under AS 2, inventories should be valued at:",
    options: [
      { label: "A", body: "Cost", correct: false },
      { label: "B", body: "Net Realisable Value (NRV)", correct: false },
      { label: "C", body: "Lower of cost and NRV", correct: true },
      { label: "D", body: "Higher of cost and NRV", correct: false },
    ],
    explanation: "AS 2 prescribes the 'lower of cost and net realisable value' rule, applied item-by-item.",
  },
  {
    type: "mcq",
    marks: 2,
    negative: 0.5,
    topic: "Partnership — Goodwill",
    difficulty: "medium",
    body: "A and B share profits in the ratio 3:2. C is admitted for 1/5th share. The new profit-sharing ratio of A : B : C will be:",
    options: [
      { label: "A", body: "12 : 8 : 5", correct: true },
      { label: "B", body: "3 : 2 : 1", correct: false },
      { label: "C", body: "9 : 6 : 5", correct: false },
      { label: "D", body: "3 : 2 : 5", correct: false },
    ],
    explanation: "C's share = 1/5, so remaining 4/5 is split between A and B in 3:2 → A = 12/25, B = 8/25, C = 5/25. Ratio = 12 : 8 : 5.",
  },
  {
    type: "mcq",
    marks: 2,
    negative: 0.5,
    topic: "AS 9 — Revenue Recognition",
    difficulty: "medium",
    body: "Under AS 9, revenue from the sale of goods is recognised when:",
    options: [
      { label: "A", body: "The order is received from the customer.", correct: false },
      { label: "B", body: "Significant risks and rewards of ownership are transferred to the buyer.", correct: true },
      { label: "C", body: "Cash is received from the customer.", correct: false },
      { label: "D", body: "Goods are dispatched from the warehouse.", correct: false },
    ],
    explanation: "AS 9 requires transfer of significant risks and rewards (not mere dispatch or cash receipt) for revenue recognition on sale of goods.",
  },
  {
    type: "mcq",
    marks: 3,
    negative: 0.75,
    topic: "Company Accounts — Bonus Issue",
    difficulty: "medium",
    body: "A company has 1,00,000 equity shares of Rs.10 each fully paid. It issues bonus shares in the ratio 1:4 out of free reserves. After the bonus issue, the number of equity shares outstanding will be:",
    options: [
      { label: "A", body: "1,25,000", correct: true },
      { label: "B", body: "1,40,000", correct: false },
      { label: "C", body: "1,20,000", correct: false },
      { label: "D", body: "4,00,000", correct: false },
    ],
    explanation: "Bonus 1:4 means 1 bonus share for every 4 held → 1,00,000 / 4 = 25,000 bonus shares. Total = 1,00,000 + 25,000 = 1,25,000.",
  },
  {
    type: "mcq",
    marks: 2,
    negative: 0.5,
    topic: "Branch Accounts",
    difficulty: "medium",
    body: "Under the Stock and Debtors System of branch accounting, which of the following accounts is NOT typically maintained at the Head Office?",
    options: [
      { label: "A", body: "Branch Stock Account", correct: false },
      { label: "B", body: "Branch Debtors Account", correct: false },
      { label: "C", body: "Branch Adjustment Account", correct: false },
      { label: "D", body: "Branch Trading and Profit & Loss Account (memorandum)", correct: true },
    ],
    explanation: "Under Stock & Debtors, profit is computed via the Branch Adjustment A/c — a separate memorandum Trading & P&L is associated with the Final-Accounts/Debtors System, not Stock & Debtors.",
  },
  {
    type: "mcq",
    marks: 2,
    negative: 0.5,
    topic: "AS 4 — Contingencies",
    difficulty: "hard",
    body: "A major fire occurred at the company's warehouse on 5 May 2026, destroying inventory worth Rs.2 crore. The financial statements for FY 2025-26 are approved on 20 May 2026. As per AS 4, this event is:",
    options: [
      { label: "A", body: "An adjusting event — restate the financial statements.", correct: false },
      { label: "B", body: "A non-adjusting event — disclose in the notes only.", correct: true },
      { label: "C", body: "Ignored as it occurred after the balance sheet date.", correct: false },
      { label: "D", body: "Recognised as a prior-period item.", correct: false },
    ],
    explanation: "The fire arose from conditions after the balance-sheet date (31 Mar 2026), so it is a non-adjusting event. AS 4 requires disclosure if material — which Rs.2 crore clearly is.",
  },
  {
    type: "mcq",
    marks: 3,
    negative: 0.75,
    topic: "Hire Purchase",
    difficulty: "hard",
    body: "Under the Hire Purchase system, when the buyer defaults and the seller repossesses the asset, the seller's accounting treatment is to:",
    options: [
      { label: "A", body: "Credit the Hire Purchaser's Account and debit the Goods Repossessed Account at agreed/fair value.", correct: true },
      { label: "B", body: "Write off the entire balance as bad debt.", correct: false },
      { label: "C", body: "Recognise the full hire-purchase price as profit.", correct: false },
      { label: "D", body: "Make no entry until the asset is resold.", correct: false },
    ],
    explanation: "On repossession the seller records the asset back into stock (debit Goods Repossessed at fair/agreed value) and closes the Hire Purchaser's account; any shortfall is the loss on repossession.",
  },
  {
    type: "numerical",
    marks: 4,
    negative: 0,
    topic: "Depreciation — WDV",
    difficulty: "medium",
    body: "A machine was purchased for Rs.5,00,000 on 1 April 2023. Depreciation is charged at 20% p.a. on the Written Down Value (WDV) method. Calculate the WDV (in Rs.) at the end of 31 March 2026 (i.e., after 3 full years).",
    numerical_answer: 256000,
    numerical_tolerance: 100,
    explanation: "Year 1: 5,00,000 × 0.80 = 4,00,000. Year 2: 4,00,000 × 0.80 = 3,20,000. Year 3: 3,20,000 × 0.80 = 2,56,000. Closing WDV = Rs.2,56,000.",
  },
  {
    type: "short",
    marks: 4,
    negative: 0,
    topic: "AS 5 — Prior-Period Items",
    difficulty: "medium",
    body: "Briefly explain the difference between a 'prior-period item' and a 'change in accounting estimate' under AS 5. (Answer in 3–5 sentences.)",
    explanation: "Prior-period items are errors or omissions in prior-period financial statements (e.g., omitted invoice) — disclosed separately so current-period results are not distorted. A change in estimate (e.g., revising useful life of an asset) arises from new information and is applied prospectively — no restatement. Key distinction: errors → prior period; new information → estimate change.",
  },
];

async function main() {
  // Find a branch
  const [branch] = await sql`
    SELECT id, name FROM branches
    WHERE code = 'NGP' OR lower(name) LIKE '%nagpur%'
    ORDER BY active DESC LIMIT 1
  `;
  let branchId = branch?.id;
  if (!branchId) {
    const [any] = await sql`SELECT id FROM branches WHERE active = true LIMIT 1`;
    if (!any) throw new Error("No branches in DB. Insert at least one branch first.");
    branchId = any.id;
  }

  // Idempotency check
  const existing = await sql`
    SELECT id FROM mock_tests WHERE title = ${DEMO_TITLE} AND deleted_at IS NULL LIMIT 1
  `;
  if (existing.length > 0) {
    console.log(`Demo mock test already exists (id=${existing[0].id}). Skipping insert.`);
    console.log(`To re-seed: DELETE FROM mock_tests WHERE id = '${existing[0].id}';`);
    await sql.end();
    return;
  }

  // Schedule 7 days from now at 10:00, registration closes 1 day before
  const now = new Date();
  const scheduledAt = new Date(now.getTime() + 7 * 86400000);
  scheduledAt.setUTCHours(4, 30, 0, 0); // 10:00 IST
  const regCloseAt = new Date(scheduledAt.getTime() - 86400000);

  const totalMarks = QUESTIONS.reduce((s, q) => s + q.marks, 0);

  const [test] = await sql`
    INSERT INTO mock_tests (
      branch_id, title, series_name, level, group_no, paper_no,
      scheduled_at, duration_mins, venue, capacity, fee_paise, status,
      description, max_score, supports_online, registration_close_at
    ) VALUES (
      ${branchId},
      ${DEMO_TITLE},
      ${DEMO_SERIES},
      'intermediate', 1, 1,
      ${scheduledAt.toISOString()},
      90,
      'Online — Attempt from anywhere',
      500,
      0,
      'open_for_registration',
      ${"A 10-question demo mock covering Advanced Accounting topics (AS 2, 4, 5, 9, 10, Partnership, Company Accounts, Branch, Hire Purchase, Depreciation). Designed to showcase the online-attempt → auto-grade → review flow. 90 minutes, 25 marks."},
      ${totalMarks},
      true,
      ${regCloseAt.toISOString()}
    )
    RETURNING id
  `;
  if (!test) throw new Error("Failed to insert mock_tests row");
  const testId = test.id;
  console.log(`Created mock_test id=${testId} (max_score=${totalMarks})`);

  let qInserted = 0;
  let oInserted = 0;
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const [qRow] = await sql`
      INSERT INTO mock_test_questions (
        mock_test_id, question_no, question_type, body, marks, negative_marks,
        topic_tag, difficulty, numerical_answer, numerical_tolerance, explanation
      ) VALUES (
        ${testId}, ${i + 1}, ${q.type}, ${q.body}, ${q.marks}, ${String(q.negative)},
        ${q.topic ?? null}, ${q.difficulty ?? null},
        ${q.numerical_answer != null ? String(q.numerical_answer) : null},
        ${q.numerical_tolerance != null ? String(q.numerical_tolerance) : "0"},
        ${q.explanation ?? null}
      )
      RETURNING id
    `;
    if (!qRow) continue;
    qInserted++;

    if (q.type === "mcq" && Array.isArray(q.options)) {
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        const [oRow] = await sql`
          INSERT INTO mock_test_options (question_id, option_label, body, is_correct, sort_order)
          VALUES (${qRow.id}, ${opt.label}, ${opt.body}, ${opt.correct}, ${j})
          RETURNING id
        `;
        if (oRow) oInserted++;
      }
    }
  }

  console.log(`Inserted ${qInserted} questions, ${oInserted} options.`);
  console.log(`\nDemo mock test ready:`);
  console.log(`  Title:        ${DEMO_TITLE}`);
  console.log(`  Scheduled:    ${scheduledAt.toISOString()}`);
  console.log(`  Status:       open_for_registration`);
  console.log(`  Online:       enabled`);
  console.log(`  Duration:     90 mins`);
  console.log(`  Max score:    ${totalMarks}`);
  console.log(`  Visit:        /resources/mock-tests  (public listing)`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
