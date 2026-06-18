// Pragyaan AI — paragraph-aware chunker (FIN-151).
//
// Splits a source document into overlapping chunks sized for embedding +
// retrieval. Target ~800 tokens (~3200 chars) per chunk with ~100 tokens
// (~400 chars) of overlap, splitting on paragraph boundaries so a chunk
// rarely cuts a sentence in half. Token counts are approximated as
// chars / 4 (the spec's convention — good enough for sizing + analytics;
// the embedding model does the real tokenisation).
//
// Pure + deterministic: same input ⇒ same chunks. No DB, no provider calls
// here — ingest.ts wires this to embedTexts + kb_chunks inserts.

// ~800 tokens ≈ 3200 chars; ~100-token overlap ≈ 400 chars. Tokens are
// approximated as chars/4 throughout (see tokenCountOf).
const TARGET_CHARS = 3200;
const OVERLAP_CHARS = 400;
// A single paragraph longer than this is hard-split on whitespace so one
// giant block can't blow past the target size.
const MAX_CHARS = TARGET_CHARS + OVERLAP_CHARS;

export interface Chunk {
  /** The chunk text (trimmed). */
  content: string;
  /** 0-based position of this chunk within the source. */
  chunkIndex: number;
  /** Approximate token count (chars / 4, rounded up). */
  tokenCount: number;
}

/** Approximate token count for a string — chars / 4, rounded up. */
export function tokenCountOf(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk `raw` into ~800-token, paragraph-aligned pieces with ~100-token
 * overlap between neighbours. Returns [] for empty/whitespace-only input.
 *
 * Strategy:
 *  1. Normalise newlines and split into paragraphs on blank lines.
 *  2. Greedily pack paragraphs into a buffer until adding the next would
 *     exceed TARGET_CHARS, then flush.
 *  3. Seed each new buffer with ~OVERLAP_CHARS of trailing text from the
 *     previous chunk so context carries across the boundary.
 *  4. Paragraphs larger than MAX_CHARS on their own are hard-split.
 */
export function chunkText(raw: string): Chunk[] {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  // Paragraphs = runs of text separated by one or more blank lines. Oversized
  // paragraphs are pre-split so the packing loop never sees a block it can't
  // place.
  const paragraphs: string[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const p = block.trim();
    if (!p) continue;
    if (p.length > MAX_CHARS) {
      paragraphs.push(...hardSplit(p, TARGET_CHARS));
    } else {
      paragraphs.push(p);
    }
  }

  const chunks: Chunk[] = [];
  let buf = "";

  const flush = () => {
    const content = buf.trim();
    if (!content) return;
    chunks.push({
      content,
      chunkIndex: chunks.length,
      tokenCount: tokenCountOf(content),
    });
  };

  for (const para of paragraphs) {
    if (buf === "") {
      buf = para;
      continue;
    }
    // +2 accounts for the "\n\n" paragraph separator we'll insert.
    if (buf.length + 2 + para.length <= TARGET_CHARS) {
      buf += "\n\n" + para;
    } else {
      flush();
      // Carry the tail of the just-flushed chunk forward as overlap, on a
      // paragraph boundary where possible.
      const overlap = tailOverlap(buf, OVERLAP_CHARS);
      buf = overlap ? overlap + "\n\n" + para : para;
    }
  }
  flush();

  return chunks;
}

// Take roughly the last `chars` characters of `text`, preferring to start at
// a paragraph boundary so the overlap is a clean trailing paragraph rather
// than a mid-sentence fragment. Returns "" if nothing meaningful remains.
function tailOverlap(text: string, chars: number): string {
  if (text.length <= chars) return text.trim();
  const slice = text.slice(text.length - chars);
  const paraBreak = slice.indexOf("\n\n");
  const tail = paraBreak >= 0 ? slice.slice(paraBreak + 2) : slice;
  return tail.trim();
}

// Hard-split an oversized paragraph into <= `size`-char pieces, breaking on
// whitespace near the boundary so words stay intact. Used only for blocks
// with no paragraph breaks (e.g. a wall of text from a scraped page).
function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const ws = text.lastIndexOf(" ", end);
      if (ws > i) end = ws;
    }
    const piece = text.slice(i, end).trim();
    if (piece) out.push(piece);
    i = end;
  }
  return out;
}
