// Seeds 5 realistic ICAI mock tests with a 10-question MCQ paper each.
// Every test opts into `supports_online = true` so registered students
// can take the timed online attempt through the portal.
//
// Idempotent — matches existing rows by (branch_id, title). Re-running is
// safe; new questions won't be inserted twice because each MCQ carries a
// deterministic (mock_test_id, question_no) unique-by-application key.
//
// Usage:
//   node scripts/seed-mock-tests.mjs
//   node scripts/seed-mock-tests.mjs --replace   # wipe questions/options before reseeding

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const REPLACE = process.argv.includes("--replace");
const sql = postgres(url, { max: 1, prepare: false });

// ─── Test definitions ────────────────────────────────────────────────────
// Realistic CA-exam papers. Dates are ~30-90 days out so the tests always
// look "upcoming" no matter when you run this. Each carries a curated
// 10-question MCQ paper (see QUESTIONS array below, keyed by test.slug).

const daysFromNowIso = (days, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const TESTS = [
  {
    slug:          "foundation-nov-2026-principles-accounting",
    title:         "CA Foundation — Principles & Practice of Accounting",
    series_name:   "November 2026 Foundation Series",
    level:         "foundation",
    group_no:      null,
    paper_no:      1,
    scheduled_at:  daysFromNowIso(30, 10),
    duration_mins: 180,
    venue:         "ICAI Bhawan, Nagpur",
    capacity:      120,
    max_score:     100,
    description:   "Full-syllabus mock covering accounting principles, journal entries, ledger, trial balance, financial statements of sole proprietorship, partnership fundamentals, and company accounts basics.",
    supports_online: true,
  },
  {
    slug:          "inter-nov-2026-advanced-accounting",
    title:         "CA Intermediate — Advanced Accounting (Group 1, Paper 1)",
    series_name:   "November 2026 Intermediate Series",
    level:         "intermediate",
    group_no:      1,
    paper_no:      1,
    scheduled_at:  daysFromNowIso(37, 10),
    duration_mins: 180,
    venue:         "ICAI Bhawan, Nagpur",
    capacity:      150,
    max_score:     100,
    description:   "Comprehensive mock across AS 1–29, company financial statements, amalgamation, internal reconstruction, branch accounts, and investment accounts.",
    supports_online: true,
  },
  {
    slug:          "inter-nov-2026-taxation",
    title:         "CA Intermediate — Taxation (Group 1, Paper 3)",
    series_name:   "November 2026 Intermediate Series",
    level:         "intermediate",
    group_no:      1,
    paper_no:      3,
    scheduled_at:  daysFromNowIso(44, 10),
    duration_mins: 180,
    venue:         "ICAI Bhawan, Nagpur",
    capacity:      150,
    max_score:     100,
    description:   "Direct Tax (Income Tax basics through PGBP + Capital Gains) and Indirect Tax (GST — supply, levy, ITC, place of supply, registration).",
    supports_online: true,
  },
  {
    slug:          "final-may-2026-financial-reporting",
    title:         "CA Final — Financial Reporting (Group 1, Paper 1)",
    series_name:   "May 2026 Final Series",
    level:         "final",
    group_no:      1,
    paper_no:      1,
    scheduled_at:  daysFromNowIso(60, 10),
    duration_mins: 180,
    venue:         "Chitnavis Centre, Nagpur",
    capacity:      100,
    max_score:     100,
    description:   "Ind AS convergence, business combinations (Ind AS 103), consolidation, revenue (Ind AS 115), leases (Ind AS 116), financial instruments (Ind AS 109), and integrated reporting.",
    supports_online: true,
  },
  {
    slug:          "final-may-2026-audit",
    title:         "CA Final — Audit & Assurance (Group 1, Paper 3)",
    series_name:   "May 2026 Final Series",
    level:         "final",
    group_no:      1,
    paper_no:      3,
    scheduled_at:  daysFromNowIso(67, 10),
    duration_mins: 180,
    venue:         "Chitnavis Centre, Nagpur",
    capacity:      100,
    max_score:     100,
    description:   "SAs (all in force), Companies Act audit requirements, CARO 2020, audit reports & CARO reporting, professional ethics, and code of ethics.",
    supports_online: true,
  },
];

// ─── Question banks ──────────────────────────────────────────────────────
// One 10-question MCQ paper per test, keyed by test.slug. Every question
// carries 4 options, exactly one correct. Marks: 1 for straightforward
// definition/fact questions, 2 for application/analytical.

const QUESTIONS = {
  "foundation-nov-2026-principles-accounting": [
    {
      body: "Which accounting concept requires that revenue be recognized when it is earned and matched with the expenses incurred to generate it?",
      topic: "Accounting concepts", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Going concern concept", correct: false },
        { l: "B", t: "Matching concept", correct: true },
        { l: "C", t: "Consistency concept", correct: false },
        { l: "D", t: "Conservatism concept", correct: false },
      ],
      explanation: "The matching concept requires that expenses be recognised in the same period as the revenues they help generate.",
    },
    {
      body: "The rule 'Debit what comes in, Credit what goes out' applies to which type of account?",
      topic: "Golden rules", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Personal Account", correct: false },
        { l: "B", t: "Real Account", correct: true },
        { l: "C", t: "Nominal Account", correct: false },
        { l: "D", t: "Contingent Account", correct: false },
      ],
      explanation: "Real accounts (assets like cash, furniture) follow 'Debit what comes in, Credit what goes out'.",
    },
    {
      body: "A trial balance is prepared primarily to:",
      topic: "Trial balance", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Determine the profit or loss for the period", correct: false },
        { l: "B", t: "Verify the arithmetical accuracy of the ledger accounts", correct: true },
        { l: "C", t: "Ascertain the financial position of the business", correct: false },
        { l: "D", t: "Comply with the Companies Act, 2013", correct: false },
      ],
      explanation: "A trial balance's primary purpose is to verify that total debits equal total credits — i.e., arithmetical accuracy.",
    },
    {
      body: "Goods sold on credit to Mr. Rao for ₹10,000 will be recorded in:",
      topic: "Journal entries", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Cash Book", correct: false },
        { l: "B", t: "Purchases Book", correct: false },
        { l: "C", t: "Sales Book", correct: true },
        { l: "D", t: "Journal Proper", correct: false },
      ],
      explanation: "Credit sales of goods are recorded in the Sales Book (Sales Day Book).",
    },
    {
      body: "Depreciation charged on a Straight Line Method for a machine costing ₹1,00,000 with salvage value ₹10,000 and useful life 10 years is:",
      topic: "Depreciation", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "₹9,000 per annum", correct: true },
        { l: "B", t: "₹10,000 per annum", correct: false },
        { l: "C", t: "₹11,000 per annum", correct: false },
        { l: "D", t: "₹9,900 per annum", correct: false },
      ],
      explanation: "SLM depreciation = (Cost − Salvage) ÷ Life = (1,00,000 − 10,000) ÷ 10 = ₹9,000 per year.",
    },
    {
      body: "Which of the following errors will NOT be detected by the trial balance?",
      topic: "Errors", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Wrong balancing of an account", correct: false },
        { l: "B", t: "Posting to the wrong side of an account", correct: false },
        { l: "C", t: "Error of complete omission", correct: true },
        { l: "D", t: "Wrong casting of a subsidiary book", correct: false },
      ],
      explanation: "An error of complete omission (transaction not recorded at all) leaves debits and credits balanced, so the trial balance still tallies.",
    },
    {
      body: "In a partnership, in the absence of a partnership deed, interest on capital is:",
      topic: "Partnership", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Allowed at 6% per annum", correct: false },
        { l: "B", t: "Allowed at 12% per annum", correct: false },
        { l: "C", t: "Not allowed", correct: true },
        { l: "D", t: "Allowed at bank rate", correct: false },
      ],
      explanation: "Section 13 of the Indian Partnership Act, 1932 — no interest on capital is payable to partners unless the partnership deed provides for it.",
    },
    {
      body: "Bank reconciliation statement is prepared by:",
      topic: "BRS", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "The bank", correct: false },
        { l: "B", t: "The account holder / customer", correct: true },
        { l: "C", t: "The Reserve Bank of India", correct: false },
        { l: "D", t: "The auditor of the bank", correct: false },
      ],
      explanation: "The BRS is prepared by the customer (account holder) to reconcile the cash book balance with the bank statement balance.",
    },
    {
      body: "Under the Written Down Value method of depreciation, the amount of depreciation:",
      topic: "Depreciation", difficulty: "medium", marks: 1,
      options: [
        { l: "A", t: "Remains constant each year", correct: false },
        { l: "B", t: "Increases every year", correct: false },
        { l: "C", t: "Decreases every year", correct: true },
        { l: "D", t: "Is zero in the last year", correct: false },
      ],
      explanation: "WDV depreciation is calculated on the book value at the start of each year, which decreases annually — so the depreciation charge also decreases.",
    },
    {
      body: "A cheque received but not yet deposited in the bank is treated as:",
      topic: "Cash book", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Cash in hand", correct: true },
        { l: "B", t: "Bank balance", correct: false },
        { l: "C", t: "Sundry debtor", correct: false },
        { l: "D", t: "Not to be recorded", correct: false },
      ],
      explanation: "A cheque received is treated as cash in hand until it is deposited into the bank account.",
    },
  ],

  "inter-nov-2026-advanced-accounting": [
    {
      body: "Under Ind AS 115 / AS 9, revenue from the sale of goods is recognised when:",
      topic: "Revenue recognition", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "The sale order is placed by the customer", correct: false },
        { l: "B", t: "Significant risks and rewards of ownership are transferred to the buyer", correct: true },
        { l: "C", t: "The goods are physically delivered", correct: false },
        { l: "D", t: "The invoice is issued", correct: false },
      ],
      explanation: "AS 9 requires transfer of significant risks and rewards of ownership; Ind AS 115 refines this into control transfer at a point in time.",
    },
    {
      body: "As per AS 2 (Valuation of Inventories), inventories are valued at:",
      topic: "AS 2", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Cost", correct: false },
        { l: "B", t: "Net realisable value", correct: false },
        { l: "C", t: "Lower of cost and net realisable value", correct: true },
        { l: "D", t: "Higher of cost and net realisable value", correct: false },
      ],
      explanation: "AS 2 requires inventories to be measured at the lower of cost and net realisable value (LOCM principle).",
    },
    {
      body: "When two or more companies join to form a new company and both cease to exist, it is called:",
      topic: "Amalgamation", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Absorption", correct: false },
        { l: "B", t: "External reconstruction", correct: false },
        { l: "C", t: "Amalgamation in the nature of merger", correct: false },
        { l: "D", t: "Amalgamation (by formation of a new company)", correct: true },
      ],
      explanation: "Amalgamation via formation of a new entity — both existing companies dissolve and are replaced by the newly formed one.",
    },
    {
      body: "Goodwill arises when the purchase consideration paid for a business is:",
      topic: "Goodwill", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Less than the net assets acquired", correct: false },
        { l: "B", t: "Equal to the net assets acquired", correct: false },
        { l: "C", t: "Greater than the net assets acquired", correct: true },
        { l: "D", t: "Independent of the net assets acquired", correct: false },
      ],
      explanation: "Goodwill = Purchase Consideration − Fair Value of Net Identifiable Assets. Positive difference is goodwill; negative is capital reserve.",
    },
    {
      body: "In branch accounting, the debtors system is generally used when the branch:",
      topic: "Branch accounts", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Is a small dependent branch with limited transactions", correct: true },
        { l: "B", t: "Is a fully independent foreign branch", correct: false },
        { l: "C", t: "Has its own trial balance", correct: false },
        { l: "D", t: "Deals only in imported goods", correct: false },
      ],
      explanation: "The debtors system suits small dependent branches; larger branches use the stock-and-debtors or final-accounts method.",
    },
    {
      body: "Under AS 10 (Property, Plant and Equipment), the cost of a self-constructed asset includes:",
      topic: "AS 10", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Only direct materials and labour", correct: false },
        { l: "B", t: "Direct costs plus a share of overheads directly attributable to construction", correct: true },
        { l: "C", t: "All costs including internal profits", correct: false },
        { l: "D", t: "Only external contractor payments", correct: false },
      ],
      explanation: "AS 10 permits capitalising directly attributable costs and a proportionate share of production overheads incurred to bring the asset to its intended use.",
    },
    {
      body: "Internal reconstruction of a company is carried out by:",
      topic: "Internal reconstruction", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Forming a new company", correct: false },
        { l: "B", t: "Reducing share capital and reorganising within the existing entity", correct: true },
        { l: "C", t: "Merging with another company", correct: false },
        { l: "D", t: "Winding up the company", correct: false },
      ],
      explanation: "Internal reconstruction keeps the company alive but restructures share capital + liabilities (typically via capital reduction u/s 66 of Companies Act 2013).",
    },
    {
      body: "A contingent liability is:",
      topic: "AS 29", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Recognised in the balance sheet", correct: false },
        { l: "B", t: "Disclosed by way of a note if a reliable estimate can be made and outflow is possible", correct: true },
        { l: "C", t: "Ignored completely", correct: false },
        { l: "D", t: "Provided for at 50% of the estimated amount", correct: false },
      ],
      explanation: "AS 29: contingent liabilities are disclosed in the notes unless the possibility of outflow is remote.",
    },
    {
      body: "Under the pooling of interests method (AS 14), the difference between purchase consideration and the transferor company's share capital is adjusted through:",
      topic: "Amalgamation", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Goodwill account", correct: false },
        { l: "B", t: "Capital reserve", correct: false },
        { l: "C", t: "Reserves of the transferee company", correct: true },
        { l: "D", t: "Profit and loss account of transferor", correct: false },
      ],
      explanation: "Under the pooling of interests method (merger), the difference is adjusted in reserves — no goodwill or capital reserve is created.",
    },
    {
      body: "Which of these is a Nominal Account?",
      topic: "Account types", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Building Account", correct: false },
        { l: "B", t: "Debtors Account", correct: false },
        { l: "C", t: "Rent Account", correct: true },
        { l: "D", t: "Capital Account", correct: false },
      ],
      explanation: "Rent is an expense — a nominal account (income/expense/gain/loss). Building = real, Debtors/Capital = personal.",
    },
  ],

  "inter-nov-2026-taxation": [
    {
      body: "For AY 2026-27, an individual (aged 45, resident) opting for the new regime under Section 115BAC has income of ₹8,00,000. The tax liability (before cess) is:",
      topic: "New regime slabs", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Nil (rebate under 87A applies)", correct: false },
        { l: "B", t: "₹30,000", correct: true },
        { l: "C", t: "₹52,500", correct: false },
        { l: "D", t: "₹72,500", correct: false },
      ],
      explanation: "New regime slabs (AY 2026-27): up to ₹3L nil, 3-7L @5% = ₹20,000, 7-10L @10% on ₹1L = ₹10,000. Total ₹30,000. Rebate u/s 87A caps income up to ₹7L; ₹8L exceeds that.",
    },
    {
      body: "Under Section 44AD (presumptive taxation), the presumptive rate on business turnover received electronically is:",
      topic: "Section 44AD", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "8%", correct: false },
        { l: "B", t: "6%", correct: true },
        { l: "C", t: "10%", correct: false },
        { l: "D", t: "50%", correct: false },
      ],
      explanation: "Sec 44AD: 8% of gross turnover (cash) or 6% on receipts through banking channels / electronic mode.",
    },
    {
      body: "Long-term capital gain on the sale of a listed equity share (STT paid) exceeding ₹1,25,000 is taxed at:",
      topic: "Capital gains", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "10% without indexation", correct: false },
        { l: "B", t: "12.5% without indexation", correct: true },
        { l: "C", t: "20% with indexation", correct: false },
        { l: "D", t: "Exempt under Section 10(38)", correct: false },
      ],
      explanation: "Finance Act 2024: LTCG under 112A on listed equity (STT paid) is 12.5% (without indexation) on gains exceeding ₹1,25,000.",
    },
    {
      body: "Under GST, the term 'aggregate turnover' includes:",
      topic: "GST basics", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Only taxable supplies", correct: false },
        { l: "B", t: "Taxable + exempt + exports + inter-state supplies of a person having same PAN", correct: true },
        { l: "C", t: "Only inter-state supplies", correct: false },
        { l: "D", t: "Purchases + sales", correct: false },
      ],
      explanation: "Sec 2(6) CGST: aggregate turnover includes all taxable supplies, exempt supplies, exports, and inter-state supplies of persons having the same PAN, computed on all-India basis.",
    },
    {
      body: "The threshold turnover for GST registration for a supplier of goods (in a non-special-category state) is:",
      topic: "GST registration", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "₹10 lakhs", correct: false },
        { l: "B", t: "₹20 lakhs", correct: false },
        { l: "C", t: "₹40 lakhs", correct: true },
        { l: "D", t: "₹1 crore", correct: false },
      ],
      explanation: "For suppliers of goods (only) in non-special-category states, the threshold is ₹40 lakhs. For services, it's ₹20 lakhs. Special-category states have lower thresholds.",
    },
    {
      body: "Input Tax Credit (ITC) on which of these is BLOCKED under Section 17(5) of the CGST Act?",
      topic: "Blocked ITC", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "GST on raw materials used in manufacturing", correct: false },
        { l: "B", t: "GST on motor vehicle for personal use of directors", correct: true },
        { l: "C", t: "GST on office stationery", correct: false },
        { l: "D", t: "GST on freight for goods movement", correct: false },
      ],
      explanation: "Sec 17(5): ITC blocked on motor vehicles for transportation of persons (unless used for further supply, transportation of passengers, or driving training).",
    },
    {
      body: "Under Section 80C, the maximum deduction available in aggregate is:",
      topic: "Chapter VI-A", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "₹1,00,000", correct: false },
        { l: "B", t: "₹1,50,000", correct: true },
        { l: "C", t: "₹2,00,000", correct: false },
        { l: "D", t: "₹2,50,000", correct: false },
      ],
      explanation: "The overall Section 80C + 80CCC + 80CCD(1) ceiling is ₹1,50,000. Note: 80C is unavailable under the new regime u/s 115BAC.",
    },
    {
      body: "The 'time of supply' of services under GST is generally:",
      topic: "Time of supply", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Date of contract only", correct: false },
        { l: "B", t: "Earliest of invoice date, payment date, or provision of service date (with certain rules)", correct: true },
        { l: "C", t: "Date of GST payment", correct: false },
        { l: "D", t: "Date of registration", correct: false },
      ],
      explanation: "Sec 13 CGST: time of supply of services = earlier of invoice date (if issued within 30 days of service) OR date of receipt of payment.",
    },
    {
      body: "Income from house property is chargeable to tax under which head?",
      topic: "Income heads", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Income from Other Sources", correct: false },
        { l: "B", t: "Profits and Gains of Business or Profession", correct: false },
        { l: "C", t: "Income from House Property", correct: true },
        { l: "D", t: "Capital Gains", correct: false },
      ],
      explanation: "Sec 22: annual value of property (except property used for own business/profession) is chargeable under 'Income from House Property'.",
    },
    {
      body: "A supply of goods where the location of supplier and place of supply are in the same state attracts:",
      topic: "GST — Nature of supply", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "IGST only", correct: false },
        { l: "B", t: "CGST + SGST", correct: true },
        { l: "C", t: "CGST only", correct: false },
        { l: "D", t: "IGST + Cess", correct: false },
      ],
      explanation: "Intra-state supply: CGST + SGST (or UTGST) apply. Inter-state supply: IGST.",
    },
  ],

  "final-may-2026-financial-reporting": [
    {
      body: "Under Ind AS 115, revenue is recognised when:",
      topic: "Ind AS 115", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "The contract is signed", correct: false },
        { l: "B", t: "Cash is received from the customer", correct: false },
        { l: "C", t: "Control of goods or services is transferred to the customer", correct: true },
        { l: "D", t: "The invoice is raised", correct: false },
      ],
      explanation: "Ind AS 115's core principle: recognise revenue when the entity transfers control of promised goods/services to the customer.",
    },
    {
      body: "For a lessee under Ind AS 116, a short-term lease is one with a lease term of:",
      topic: "Ind AS 116", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "3 months or less", correct: false },
        { l: "B", t: "6 months or less", correct: false },
        { l: "C", t: "12 months or less at commencement and no purchase option", correct: true },
        { l: "D", t: "24 months or less", correct: false },
      ],
      explanation: "Ind AS 116 permits the short-term lease exemption for leases of 12 months or less at commencement, with no purchase option.",
    },
    {
      body: "Under Ind AS 103 (Business Combinations), the acquisition method requires goodwill to be measured as:",
      topic: "Ind AS 103", difficulty: "hard", marks: 2,
      options: [
        { l: "A", t: "Consideration paid − book value of net assets acquired", correct: false },
        { l: "B", t: "Consideration transferred + Non-controlling interest + Fair value of previously held interest − Fair value of net identifiable assets acquired", correct: true },
        { l: "C", t: "Consideration paid − Share capital of acquiree", correct: false },
        { l: "D", t: "Purchase price × Ownership percentage", correct: false },
      ],
      explanation: "Goodwill (Ind AS 103) = Consideration transferred + NCI + FV of previously held equity interest − FV of net identifiable assets. Negative → gain on bargain purchase.",
    },
    {
      body: "Under Ind AS 109, financial assets are classified based on:",
      topic: "Ind AS 109", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Only the entity's intent", correct: false },
        { l: "B", t: "The entity's business model AND the contractual cash flow characteristics", correct: true },
        { l: "C", t: "Only the contractual cash flows", correct: false },
        { l: "D", t: "Historical performance", correct: false },
      ],
      explanation: "Ind AS 109 classification hinges on (i) the entity's business model for managing the asset, and (ii) the SPPI test on contractual cash flows.",
    },
    {
      body: "Expected Credit Loss (ECL) model under Ind AS 109 requires provisioning:",
      topic: "Ind AS 109 — ECL", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Only after default has occurred", correct: false },
        { l: "B", t: "Based on 12-month or lifetime expected credit losses depending on credit risk change", correct: true },
        { l: "C", t: "At a flat 5% of receivables", correct: false },
        { l: "D", t: "Only for related-party receivables", correct: false },
      ],
      explanation: "Ind AS 109 replaces the incurred-loss model with a forward-looking ECL model: 12-month ECL at initial recognition, lifetime ECL when credit risk has increased significantly.",
    },
    {
      body: "Consolidated financial statements are prepared under which Ind AS?",
      topic: "Consolidation", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Ind AS 27", correct: false },
        { l: "B", t: "Ind AS 28", correct: false },
        { l: "C", t: "Ind AS 110", correct: true },
        { l: "D", t: "Ind AS 111", correct: false },
      ],
      explanation: "Ind AS 110 (Consolidated Financial Statements). Ind AS 27 = separate FS, Ind AS 28 = associates, Ind AS 111 = joint arrangements.",
    },
    {
      body: "Under Ind AS 33 (Earnings Per Share), basic EPS is:",
      topic: "Ind AS 33", difficulty: "medium", marks: 1,
      options: [
        { l: "A", t: "Net profit ÷ Total shares outstanding at year-end", correct: false },
        { l: "B", t: "Net profit attributable to equity holders ÷ Weighted average number of equity shares outstanding", correct: true },
        { l: "C", t: "Total revenue ÷ Number of shares", correct: false },
        { l: "D", t: "Net worth ÷ Number of shares", correct: false },
      ],
      explanation: "Basic EPS = Profit attributable to ordinary equity holders ÷ Weighted average number of ordinary shares outstanding during the period.",
    },
    {
      body: "Ind AS 8 governs:",
      topic: "Ind AS 8", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Interim financial reporting", correct: false },
        { l: "B", t: "Accounting policies, changes in accounting estimates and errors", correct: true },
        { l: "C", t: "Events after the reporting period", correct: false },
        { l: "D", t: "Segment reporting", correct: false },
      ],
      explanation: "Ind AS 8 — Accounting Policies, Changes in Accounting Estimates and Errors. Prescribes how to select/change policies, correct errors, and treat estimate changes.",
    },
    {
      body: "Under Ind AS 36 (Impairment of Assets), an impairment loss is recognised when:",
      topic: "Ind AS 36", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Fair value < historical cost", correct: false },
        { l: "B", t: "Carrying amount > Recoverable amount (higher of FV less costs to sell and Value in use)", correct: true },
        { l: "C", t: "The asset is more than 5 years old", correct: false },
        { l: "D", t: "The market interest rate rises", correct: false },
      ],
      explanation: "Impairment loss = Carrying amount − Recoverable amount, where Recoverable = higher of (FV less costs of disposal) and (Value in use).",
    },
    {
      body: "First-time adoption of Ind AS is dealt with under:",
      topic: "Ind AS 101", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Ind AS 1", correct: false },
        { l: "B", t: "Ind AS 8", correct: false },
        { l: "C", t: "Ind AS 101", correct: true },
        { l: "D", t: "Ind AS 115", correct: false },
      ],
      explanation: "Ind AS 101 — First-time Adoption of Indian Accounting Standards. Provides mandatory exceptions and optional exemptions on transition.",
    },
  ],

  "final-may-2026-audit": [
    {
      body: "Under SA 200, the overall objectives of the independent auditor are to:",
      topic: "SA 200", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "Detect fraud and prevent errors", correct: false },
        { l: "B", t: "Obtain reasonable assurance that FS are free from material misstatement and report on them", correct: true },
        { l: "C", t: "Prepare the financial statements", correct: false },
        { l: "D", t: "Certify compliance with tax laws", correct: false },
      ],
      explanation: "SA 200: the auditor's objectives are (a) obtain reasonable assurance about whether FS as a whole are free from material misstatement and (b) report on the FS.",
    },
    {
      body: "Materiality in an audit is:",
      topic: "SA 320", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "A fixed percentage (5%) of revenue", correct: false },
        { l: "B", t: "The threshold above which misstatements could reasonably be expected to influence users' decisions", correct: true },
        { l: "C", t: "Determined only by management", correct: false },
        { l: "D", t: "The audit fee divided by turnover", correct: false },
      ],
      explanation: "SA 320: materiality is judgment-based — misstatements are material if they, individually or in aggregate, could reasonably influence economic decisions of users.",
    },
    {
      body: "The auditor's opinion is 'Qualified' when:",
      topic: "SA 705", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "There are no misstatements", correct: false },
        { l: "B", t: "Misstatements exist but are not pervasive to the FS as a whole", correct: true },
        { l: "C", t: "The auditor is unable to obtain any evidence", correct: false },
        { l: "D", t: "The company is loss-making", correct: false },
      ],
      explanation: "SA 705: Qualified opinion when misstatements (or scope limitations) are material but NOT pervasive. Adverse = material AND pervasive.",
    },
    {
      body: "Under CARO 2020, reporting on internal financial controls with reference to FS is required for:",
      topic: "CARO 2020", difficulty: "hard", marks: 2,
      options: [
        { l: "A", t: "All companies without exception", correct: false },
        { l: "B", t: "Companies covered under Sec 143(3)(i) — i.e., not small/one-person companies below thresholds", correct: true },
        { l: "C", t: "Only listed companies", correct: false },
        { l: "D", t: "Only public sector undertakings", correct: false },
      ],
      explanation: "CARO 2020 requires IFC reporting in line with Sec 143(3)(i) which exempts small/one-person companies below prescribed thresholds.",
    },
    {
      body: "Under the Companies Act 2013, the first auditor of a company (other than a government company) is appointed by:",
      topic: "Sec 139", difficulty: "easy", marks: 1,
      options: [
        { l: "A", t: "The Central Government", correct: false },
        { l: "B", t: "The Board of Directors within 30 days of incorporation", correct: true },
        { l: "C", t: "The Comptroller and Auditor General", correct: false },
        { l: "D", t: "The Registrar of Companies", correct: false },
      ],
      explanation: "Sec 139(6): the first auditor is appointed by the Board within 30 days of incorporation. If Board fails, members appoint within 90 days in an EGM.",
    },
    {
      body: "SA 315 requires the auditor to identify and assess risks of material misstatement through:",
      topic: "SA 315", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Substantive testing only", correct: false },
        { l: "B", t: "Understanding the entity and its environment, including internal control", correct: true },
        { l: "C", t: "External confirmations", correct: false },
        { l: "D", t: "Analytical procedures alone", correct: false },
      ],
      explanation: "SA 315: risk identification and assessment through understanding the entity, its environment, industry, applicable framework, and its internal control.",
    },
    {
      body: "The fundamental principles of professional ethics for a Chartered Accountant include all of the following EXCEPT:",
      topic: "Code of Ethics", difficulty: "medium", marks: 2,
      options: [
        { l: "A", t: "Integrity and Objectivity", correct: false },
        { l: "B", t: "Professional Competence and Due Care", correct: false },
        { l: "C", t: "Guaranteed profitability of client engagements", correct: true },
        { l: "D", t: "Confidentiality and Professional Behaviour", correct: false },
      ],
      explanation: "The five fundamental principles: Integrity, Objectivity, Professional Competence & Due Care, Confidentiality, Professional Behaviour. Guarantees are never a principle.",
    },
    {
      body: "An emphasis of matter paragraph in the audit report:",
      topic: "SA 706", difficulty: "medium", marks: 1,
      options: [
        { l: "A", t: "Modifies the audit opinion", correct: false },
        { l: "B", t: "Draws attention to a matter appropriately disclosed in the FS but fundamental to users' understanding", correct: true },
        { l: "C", t: "Replaces the opinion paragraph", correct: false },
        { l: "D", t: "Contains additional recommendations to management", correct: false },
      ],
      explanation: "SA 706: EOM paragraph highlights a matter already disclosed in the FS — it does NOT modify the auditor's opinion.",
    },
    {
      body: "The maximum term for which a listed company can appoint an audit firm as its statutory auditor under Section 139(2) is:",
      topic: "Auditor rotation", difficulty: "medium", marks: 1,
      options: [
        { l: "A", t: "One term of 5 consecutive years", correct: false },
        { l: "B", t: "Two terms of 5 consecutive years each (i.e., 10 years)", correct: true },
        { l: "C", t: "Three terms of 5 consecutive years", correct: false },
        { l: "D", t: "Unlimited", correct: false },
      ],
      explanation: "Sec 139(2): audit firm — max two terms of 5 consecutive years (10 years) with a 5-year cooling-off. Individual auditor — one term of 5 years.",
    },
    {
      body: "Under SA 570 (Going Concern), if a material uncertainty exists but disclosure is adequate, the auditor should:",
      topic: "SA 570", difficulty: "hard", marks: 2,
      options: [
        { l: "A", t: "Issue an adverse opinion", correct: false },
        { l: "B", t: "Issue an unmodified opinion with a Material Uncertainty Related to Going Concern paragraph", correct: true },
        { l: "C", t: "Disclaim the opinion", correct: false },
        { l: "D", t: "Refuse to sign the audit report", correct: false },
      ],
      explanation: "SA 570: if going-concern uncertainty is adequately disclosed → unmodified opinion + separate 'Material Uncertainty Related to Going Concern' section. Inadequate disclosure → qualified/adverse.",
    },
  ],
};

// ─── Runner ───────────────────────────────────────────────────────────────

try {
  // 1. Resolve the branch id — prefer NGP if seeded, fall back to any active.
  let [branch] = await sql`SELECT id, code FROM branches WHERE code = 'NGP' LIMIT 1`;
  if (!branch) [branch] = await sql`SELECT id, code FROM branches WHERE active = true LIMIT 1`;
  if (!branch) {
    console.error("✗ No branch found. Run scripts/seed-committees.mjs (or bootstrap branches) first.");
    process.exit(1);
  }
  console.log(`Using branch: ${branch.code} (${branch.id})`);

  let testsInserted = 0, testsUpdated = 0, questionsInserted = 0, optionsInserted = 0;

  for (const spec of TESTS) {
    // Upsert the mock test row keyed on (branch_id, title). Titles are
    // unique enough per branch to serve as our natural key here.
    const [existing] = await sql`
      SELECT id FROM mock_tests WHERE branch_id = ${branch.id} AND title = ${spec.title} AND deleted_at IS NULL LIMIT 1
    `;

    let testId;
    if (existing) {
      testId = existing.id;
      await sql`
        UPDATE mock_tests SET
          series_name         = ${spec.series_name},
          level               = ${spec.level},
          group_no            = ${spec.group_no},
          paper_no            = ${spec.paper_no},
          scheduled_at        = ${spec.scheduled_at},
          duration_mins       = ${spec.duration_mins},
          venue               = ${spec.venue},
          capacity            = ${spec.capacity},
          max_score           = ${spec.max_score},
          description         = ${spec.description},
          supports_online     = ${spec.supports_online},
          status              = 'open_for_registration',
          updated_at          = now()
        WHERE id = ${testId}
      `;
      testsUpdated++;
      console.log(`= updated: ${spec.title}`);
    } else {
      const [row] = await sql`
        INSERT INTO mock_tests (
          branch_id, title, series_name, level, group_no, paper_no,
          scheduled_at, duration_mins, venue, capacity, max_score,
          description, supports_online, status
        ) VALUES (
          ${branch.id}, ${spec.title}, ${spec.series_name}, ${spec.level},
          ${spec.group_no}, ${spec.paper_no}, ${spec.scheduled_at},
          ${spec.duration_mins}, ${spec.venue}, ${spec.capacity}, ${spec.max_score},
          ${spec.description}, ${spec.supports_online}, 'open_for_registration'
        )
        RETURNING id
      `;
      testId = row.id;
      testsInserted++;
      console.log(`+ created: ${spec.title}`);
    }

    // Wipe + reseed questions when --replace is set, or when the test is
    // brand-new. Otherwise skip — safe to run repeatedly without piling on.
    const questions = QUESTIONS[spec.slug];
    if (!Array.isArray(questions)) {
      console.warn(`  (no question bank for ${spec.slug} — skipping questions)`);
      continue;
    }

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM mock_test_questions WHERE mock_test_id = ${testId} AND deleted_at IS NULL`;
    if (count > 0 && !REPLACE) {
      console.log(`  → ${count} questions already exist; pass --replace to overwrite`);
      continue;
    }
    if (count > 0 && REPLACE) {
      await sql`DELETE FROM mock_test_questions WHERE mock_test_id = ${testId}`;
      console.log(`  ↺ wiped ${count} existing questions`);
    }

    let qNo = 1;
    for (const q of questions) {
      const [qRow] = await sql`
        INSERT INTO mock_test_questions (
          mock_test_id, question_no, question_type, body, marks,
          topic_tag, difficulty, explanation
        ) VALUES (
          ${testId}, ${qNo}, 'mcq', ${q.body}, ${q.marks ?? 1},
          ${q.topic ?? null}, ${q.difficulty ?? null}, ${q.explanation ?? null}
        ) RETURNING id
      `;
      questionsInserted++;

      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        await sql`
          INSERT INTO mock_test_options (
            question_id, option_label, body, is_correct, sort_order
          ) VALUES (
            ${qRow.id}, ${opt.l}, ${opt.t}, ${opt.correct}, ${i}
          )
        `;
        optionsInserted++;
      }
      qNo++;
    }
    console.log(`  + ${questions.length} questions with ${questions.length * 4} options`);
  }

  console.log("\n───────────────────────────────────────────────");
  console.log(`✓ Mock tests   — ${testsInserted} inserted, ${testsUpdated} updated`);
  console.log(`✓ Questions    — ${questionsInserted} inserted`);
  console.log(`✓ Options      — ${optionsInserted} inserted`);
  console.log("───────────────────────────────────────────────\n");
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
