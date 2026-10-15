// Posting fees by type — single source of truth shared between
// admin/jobs.ts (which lets staff override individual postings) and
// employer.ts (which charges the posting fee at self-service creation).
//
// Values are in paise. If branch policy changes, update here and both
// surfaces pick up the new amount on the next request. Could be hoisted
// into site_settings later if admin needs to tune per-tenure or
// seasonally — kept constant for now because the branch committee
// confirmed these fees in writing and they don't change by context.
export const JOB_POSTING_FEE_PAISE: Record<"job" | "articleship" | "assignment", number> = {
  job:         100000,  // ₹1,000
  articleship:  50000,  // ₹500
  assignment:  100000,  // ₹1,000 — short-term / freelance engagements for members
};

export function jobPostingFeePaise(type: string): number {
  return JOB_POSTING_FEE_PAISE[type as keyof typeof JOB_POSTING_FEE_PAISE] ?? 0;
}
