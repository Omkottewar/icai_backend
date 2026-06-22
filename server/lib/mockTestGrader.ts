// Auto-grader for mock-test attempts.
//
// Three grading rules:
//
//   • mcq        — full marks if the student's selected_option_ids set
//                  EXACTLY equals the set of options where is_correct=true.
//                  (Multi-select: must pick all correct AND no incorrect.)
//                  Wrong / partial answer → -negative_marks (clamped at 0).
//                  Unanswered → 0 (no negative, even with negative marking).
//
//   • numerical  — full marks if |student - correct| ≤ tolerance.
//                  Wrong → -negative_marks. Blank → 0.
//
//   • short/long — auto-grade SKIPS these; marks_awarded stays NULL
//                  until an admin enters it via the review endpoint.
//
// Returns:
//   { answers: [{ question_id, marks_awarded }],
//     score_auto: number,                          // sum of objective marks
//     unanswered_subjective: number }              // for the UI to show
//                                                   // "awaiting manual review"
//
// Pure function — no DB, no side effects. Callers persist the result.

export interface GraderQuestion {
  id: string;
  question_type: "mcq" | "numerical" | "short" | "long";
  marks: number;
  negative_marks: number;                    // numeric, treat as positive deduction
  // For MCQ: pass the option ids that are correct.
  correct_option_ids?: string[];
  // For numerical:
  numerical_answer?: number | null;
  numerical_tolerance?: number;
}

export interface GraderAnswer {
  question_id: string;
  selected_option_ids?: string[] | null;
  numerical_value?: number | null;
  text_answer?: string | null;
}

export interface GraderResult {
  answers: Array<{ question_id: string; marks_awarded: number | null }>;
  score_auto: number;
  unanswered_subjective: number;
}

function setEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  for (const x of b) if (!seen.has(x)) return false;
  return true;
}

export function grade(questions: GraderQuestion[], answers: GraderAnswer[]): GraderResult {
  const ansByQ = new Map(answers.map((a) => [a.question_id, a]));
  const results: GraderResult["answers"] = [];
  let scoreAuto = 0;
  let unansweredSubjective = 0;

  for (const q of questions) {
    const a = ansByQ.get(q.id);

    if (q.question_type === "short" || q.question_type === "long") {
      // Auto-grader skips subjective. Admin grades manually.
      results.push({ question_id: q.id, marks_awarded: null });
      if (!a || (!a.text_answer || a.text_answer.trim() === "")) continue;
      unansweredSubjective += 1;
      continue;
    }

    // Objective: blank → 0, no negative.
    const blank =
      !a ||
      (q.question_type === "mcq" && (!a.selected_option_ids || a.selected_option_ids.length === 0)) ||
      (q.question_type === "numerical" && (a.numerical_value == null || Number.isNaN(Number(a.numerical_value))));

    if (blank) {
      results.push({ question_id: q.id, marks_awarded: 0 });
      continue;
    }

    let awarded = 0;
    if (q.question_type === "mcq") {
      const correct = q.correct_option_ids ?? [];
      const picked = a!.selected_option_ids ?? [];
      awarded = setEq(picked, correct) ? q.marks : -Math.abs(q.negative_marks || 0);
    } else {
      // numerical
      const correct = Number(q.numerical_answer ?? NaN);
      const tol = Math.abs(Number(q.numerical_tolerance ?? 0));
      const v = Number(a!.numerical_value);
      if (Number.isFinite(correct) && Math.abs(v - correct) <= tol) {
        awarded = q.marks;
      } else {
        awarded = -Math.abs(q.negative_marks || 0);
      }
    }

    results.push({ question_id: q.id, marks_awarded: awarded });
    scoreAuto += awarded;
  }

  // We don't clamp scoreAuto to 0; if a student aced negative marking they
  // can absolutely end up below zero. The display layer can clamp if
  // WICASA's policy requires non-negative totals.
  return { answers: results, score_auto: scoreAuto, unanswered_subjective: unansweredSubjective };
}
