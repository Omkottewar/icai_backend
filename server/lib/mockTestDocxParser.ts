// Parse a .docx file into a list of mock-test questions.
//
// Convention the user follows in Word — tolerant of small variations:
//
//   Q1. What is GST?  [2 marks, -0.5, gst, easy]
//   A) Goods and Services Tax
//   B) Goods Selling Tax   *
//   C) Government Sales Tax
//   D) General Service Tax
//   Answer: B
//   Explanation: GST stands for Goods and Services Tax.
//
//   2. The maximum penalty under section X is ₹___ ?  [numerical]
//   Answer: 50000
//   Tolerance: 100
//
//   3) Discuss the impact of GST on small businesses.  [short, 5 marks]
//
// Conventions:
//   • Question prefix: Q1. / 1. / Q1) / 1) / (any number)
//   • Option prefix:   A) / A. / (A)
//   • Correct option:  trailing "*" OR (correct) OR an "Answer: X" line
//   • Bold option text in the .docx is treated as the correct answer too
//     (set bold via Word's Bold button on the line)
//   • Inline meta in square brackets after the question:
//        [2 marks]  [-0.5]   [easy|medium|hard]   [topic-or-anything-else]
//        [numerical]  [short]  [long]
//
// Output is a list of `ParsedQuestion` objects ready for the bulk-import
// endpoint. Parse errors are reported per question so the admin can
// inspect + fix in the preview UI before committing.

import mammoth from "mammoth";

export interface ParsedQuestion {
  question_no: number;
  question_type: "mcq" | "numerical" | "short" | "long";
  body: string;
  marks: number;
  negative_marks: number;
  topic_tag: string | null;
  difficulty: string | null;
  // MCQ
  options: Array<{ option_label: string; body: string; is_correct: boolean }>;
  // Numerical
  numerical_answer: number | null;
  numerical_tolerance: number;
  // Optional review-mode explanation
  explanation: string | null;
  // Issues the parser flagged (rendered as warnings in the preview UI)
  warnings: string[];
}

export interface ParseResult {
  questions: ParsedQuestion[];
  /** Top-level parse warnings (file-level, not per question). */
  warnings: string[];
}

// ─── helpers ──────────────────────────────────────────────────────────────

// Line-starts-with regexes used to find question / option / answer lines.
const Q_LINE  = /^\s*(?:Q\s*)?(\d+)\s*[.):-]\s+(.*)$/i;
const OPT_LINE = /^\s*\(?\s*([A-Ha-h])\s*[).:]\s*(.+?)\s*$/;
const ANS_LINE = /^\s*(?:Ans(?:wer)?|Correct(?:\s+answer)?)\s*[:.\-]\s*(.+?)\s*$/i;
const TOL_LINE = /^\s*(?:Tolerance|Tol)\s*[:.\-]\s*([-+0-9.eE]+)\s*$/i;
const EXP_LINE = /^\s*(?:Exp(?:lanation)?)\s*[:.\-]\s*(.+?)\s*$/i;

// Meta tags inside [...] on the question line. Order doesn't matter.
// Known forms:
//   2 marks     → marks
//   -0.5        → negative marks
//   easy|medium|hard → difficulty
//   numerical|mcq|short|long → type
//   anything else → topic_tag (first unknown token only)
function parseMeta(line: string): {
  cleanBody: string;
  marks?: number;
  negative_marks?: number;
  difficulty?: string;
  topic_tag?: string;
  forcedType?: ParsedQuestion["question_type"];
} {
  const meta: ReturnType<typeof parseMeta> = { cleanBody: line };
  // Last [...] block on the line is treated as the meta block.
  const m = line.match(/\[([^\]]+)\]\s*$/);
  if (!m) return meta;
  const body = line.slice(0, m.index).trim();
  meta.cleanBody = body;
  const tokens = m[1]!.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  for (const t of tokens) {
    if (/^-?\d+(?:\.\d+)?\s*marks?$/i.test(t)) {
      meta.marks = Math.abs(parseFloat(t));
      continue;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(t)) {
      const v = parseFloat(t);
      if (v < 0) meta.negative_marks = Math.abs(v);
      else if (meta.marks == null) meta.marks = v;
      continue;
    }
    if (/^easy|medium|hard$/i.test(t)) { meta.difficulty = t.toLowerCase(); continue; }
    if (/^(mcq|numerical|short|long)$/i.test(t)) { meta.forcedType = t.toLowerCase() as any; continue; }
    if (!meta.topic_tag) meta.topic_tag = t.toLowerCase();
  }
  return meta;
}

// Strip a trailing "*" or "(correct)" marker from an option line.
// Returns the cleaned body + whether the marker was present.
function pickCorrectMarker(text: string): { body: string; correct: boolean } {
  let body = text.trim();
  let correct = false;
  const reTrailingStar = /\s*\*+\s*$/;
  const reCorrect = /\s*[(\[]?\s*correct\s*[)\]]?\s*$/i;
  if (reTrailingStar.test(body)) { correct = true; body = body.replace(reTrailingStar, "").trim(); }
  if (reCorrect.test(body))      { correct = true; body = body.replace(reCorrect, "").trim(); }
  return { body, correct };
}

// Resolve a free-form "Answer:" string against the option list.
// Accepts: "B", "b)", "Option B", "Goods and Services Tax", "A, C" (multi-correct).
// Returns the set of matched option indices (0-based). Empty if nothing matches.
function resolveAnswer(answer: string, opts: ParsedQuestion["options"]): number[] {
  const result = new Set<number>();
  // Multi-correct: split on comma / and / & / +
  for (const piece of answer.split(/[,&+]|\band\b/i).map((s) => s.trim()).filter(Boolean)) {
    // Match by letter label
    const letterMatch = piece.match(/^[(]?\s*([A-Ha-h])\s*[).]?\s*$|^Option\s*([A-Ha-h])\s*$/i);
    if (letterMatch) {
      const letter = (letterMatch[1] ?? letterMatch[2]!).toUpperCase();
      const idx = opts.findIndex((o) => o.option_label.toUpperCase() === letter);
      if (idx >= 0) result.add(idx);
      continue;
    }
    // Match by body text (case-insensitive)
    const lower = piece.toLowerCase();
    const idx = opts.findIndex((o) => o.body.toLowerCase() === lower);
    if (idx >= 0) result.add(idx);
  }
  return [...result];
}

// Split mammoth's HTML output into logical lines. We strip tags but
// preserve which lines were bolded so we can use bold-as-correct-answer
// as a fallback signal.
interface ExtractedLine {
  text: string;
  bold: boolean;
}

function htmlToLines(html: string): ExtractedLine[] {
  // mammoth produces <p>, <br>, <strong>, <em>, etc. Treat <p> and <br>
  // as line breaks, capture whether the line started/contained a <strong>.
  const blocks = html
    // <br/> becomes line break
    .replace(/<br\s*\/?>/gi, "\n")
    // </p><p>... → newline between paragraphs
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<\/?p[^>]*>/gi, "\n");

  const lines: ExtractedLine[] = [];
  for (const raw of blocks.split("\n")) {
    const containsBold = /<strong\b[^>]*>/i.test(raw);
    // Strip ALL remaining tags but keep textual content.
    const text = raw
      .replace(/<[^>]+>/g, "")
      // Decode common entities
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (text) lines.push({ text, bold: containsBold });
  }
  return lines;
}

// ─── main ─────────────────────────────────────────────────────────────────

export async function parseQuestionsDocx(buffer: Buffer): Promise<ParseResult> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const lines = htmlToLines(html);

  const questions: ParsedQuestion[] = [];
  const fileWarnings: string[] = [];

  // State for the currently-being-assembled question.
  let cur: ParsedQuestion | null = null;
  let pendingAnswer: string | null = null;
  let pendingExplanation: string | null = null;
  let lastTouchedTarget: "body" | "option" | "answer" | null = null;
  let lastOptionIdx = -1;

  const finalize = () => {
    if (!cur) return;
    // Resolve a pending Answer: line against the options.
    if (pendingAnswer) {
      if (cur.question_type === "mcq") {
        const matches = resolveAnswer(pendingAnswer, cur.options);
        if (matches.length === 0) {
          cur.warnings.push(`Couldn't match the Answer line ("${pendingAnswer}") to an option.`);
        } else {
          for (const i of matches) cur.options[i]!.is_correct = true;
        }
      } else if (cur.question_type === "numerical") {
        const n = Number(pendingAnswer.replace(/[, ]/g, ""));
        if (Number.isFinite(n)) cur.numerical_answer = n;
        else cur.warnings.push(`Answer "${pendingAnswer}" is not a number.`);
      }
    }
    if (pendingExplanation) cur.explanation = pendingExplanation;

    // Validation pass per question
    if (cur.question_type === "mcq") {
      if (cur.options.length < 2) cur.warnings.push("Less than 2 options found.");
      else if (!cur.options.some((o) => o.is_correct)) {
        // If nothing was marked correct via *, (correct), Answer:, or bold,
        // flag it loudly — admin will need to tick the right one in the preview.
        cur.warnings.push("No option marked as correct. Mark one before importing.");
      }
    } else if (cur.question_type === "numerical") {
      if (cur.numerical_answer == null) cur.warnings.push("Numerical question is missing an Answer.");
    }

    questions.push(cur);
    cur = null;
    pendingAnswer = null;
    pendingExplanation = null;
    lastTouchedTarget = null;
    lastOptionIdx = -1;
  };

  for (const { text, bold } of lines) {
    const qm = Q_LINE.exec(text);
    if (qm) {
      // Boundary — close out the previous question.
      finalize();
      const meta = parseMeta(qm[2]!);
      cur = {
        question_no: questions.length + 1, // we re-number sequentially; ignore Word's numbering
        question_type: meta.forcedType ?? "mcq",       // default; gets corrected if no options + Answer: number
        body: meta.cleanBody,
        marks: Math.max(1, meta.marks ?? 1),
        negative_marks: Math.max(0, meta.negative_marks ?? 0),
        topic_tag: meta.topic_tag ?? null,
        difficulty: meta.difficulty ?? null,
        options: [],
        numerical_answer: null,
        numerical_tolerance: 0,
        explanation: null,
        warnings: [],
      };
      lastTouchedTarget = "body";
      continue;
    }

    if (!cur) {
      // Lines before the first question (a title, a header) — ignore but
      // surface a one-time warning if the doc looks bare.
      if (text && fileWarnings.length === 0 && questions.length === 0 && /^\s*$/.test("") === false) {
        // Don't warn for the first 10 lines — could be a header.
      }
      continue;
    }

    const om = OPT_LINE.exec(text);
    if (om && cur.question_type !== "short" && cur.question_type !== "long") {
      const label = om[1]!.toUpperCase();
      const { body, correct } = pickCorrectMarker(om[2]!);
      cur.options.push({
        option_label: label,
        body,
        // Star marker OR bold-line marker wins. Answer: line is resolved
        // at finalize time so it can override both.
        is_correct: correct || bold,
      });
      lastOptionIdx = cur.options.length - 1;
      lastTouchedTarget = "option";
      // If the question was tentatively classified as MCQ but had no
      // options yet, that's now consistent.
      if (cur.question_type !== "mcq") cur.question_type = "mcq";
      continue;
    }

    const am = ANS_LINE.exec(text);
    if (am) {
      pendingAnswer = am[1]!.trim();
      lastTouchedTarget = "answer";
      // If we still have no options recorded, this is a numerical or
      // subjective question with an Answer line — switch type.
      if (cur.options.length === 0 && cur.question_type === "mcq") {
        cur.question_type = "numerical";
      }
      continue;
    }

    const tm = TOL_LINE.exec(text);
    if (tm) {
      const tol = Number(tm[1]);
      if (Number.isFinite(tol) && tol >= 0) cur.numerical_tolerance = tol;
      continue;
    }

    const em = EXP_LINE.exec(text);
    if (em) {
      pendingExplanation = em[1]!.trim();
      continue;
    }

    // Continuation of the previous logical block.
    if (lastTouchedTarget === "body") {
      cur.body += "\n" + text;
    } else if (lastTouchedTarget === "option" && lastOptionIdx >= 0) {
      cur.options[lastOptionIdx]!.body += " " + text;
    } else if (lastTouchedTarget === "answer" && pendingAnswer) {
      pendingAnswer += " " + text;
    }
  }
  finalize();

  if (questions.length === 0) {
    fileWarnings.push(
      "No questions were detected. Make sure your file starts each question with " +
      "`Q1.` / `1.` / `Q1)` and each option with `A)` / `B)` etc.",
    );
  }

  return { questions, warnings: fileWarnings };
}
