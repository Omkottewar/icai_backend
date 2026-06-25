#!/usr/bin/env python3
"""
translate.py  —  Admin-triggered batch translation pipeline for ICAI site content.

Translates English site_content and site_settings from PostgreSQL into Hindi and
Marathi using IndicTrans2 running locally (CPU / float32, no GPU, no API calls).
Only strings that changed since the last run are retranslated (incremental).

See TRANSLATE_README.md for setup, first-time model auth, and integration notes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import textwrap
from pathlib import Path
from typing import Optional

# ──────────────────────────────────────────────────────────────────────────────
# CONFIGURATION  ── edit these or override via CLI flags / env vars
# ──────────────────────────────────────────────────────────────────────────────

BASE_DIR    = Path(__file__).resolve().parent
LOCALES_DIR = BASE_DIR / "locales"
STATE_FILE  = LOCALES_DIR / ".translation_state.json"

# Source language FLORES code.
SRC_LANG = "eng_Latn"

# Target languages: short code → (FLORES code, output-file stem).
SUPPORTED_LANGUAGES: dict[str, tuple[str, str]] = {
    "hi": ("hin_Deva", "hi"),   # Hindi
    "mr": ("mar_Deva", "mr"),   # Marathi
}

# IndicTrans2 checkpoint for English → Indic.
# These checkpoints are gated on HuggingFace Hub — run
#   huggingface-cli login
# once before the first run.  See TRANSLATE_README.md.
# Switch back to the 1B model once HF access is approved for your account.
# EN_INDIC_MODEL = "ai4bharat/indictrans2-en-indic-1B"
EN_INDIC_MODEL = "ai4bharat/indictrans2-en-indic-dist-200M"

# Sentences per model.generate() call.
DEFAULT_BATCH_SIZE = 8

# site_settings keys that must NOT be translated (URLs, phone, e-mail, map).
SKIP_SETTINGS_KEYS: set[str] = {
    "branch_email",
    "branch_phone",
    "branch_map_url",
    "social_facebook",
    "social_twitter",
    "social_linkedin",
    "social_youtube",
    "social_instagram",
}


# ──────────────────────────────────────────────────────────────────────────────
# PLACEHOLDER PROTECTION
# ──────────────────────────────────────────────────────────────────────────────
# Patterns are applied in order (longest / most-specific first) before the text
# reaches the model.  The originals are restored verbatim after postprocessing.

_LINK_PAT   = re.compile(r'\[([^\]\n]+)\]\(([^)\n]+)\)')   # [label](url)
_URL_PAT    = re.compile(r'https?://[^\s\])"\']+')          # bare URL
_CURLY_PAT  = re.compile(r'\{\{[^}]*\}\}|\{[a-zA-Z_]\w*\}')  # {var} / {{escaped}}
_CODE_PAT   = re.compile(r'`[^`\n]+`')                     # `inline code`
_PRINTF_PAT = re.compile(r'%(?:\([^)]+\))?[sdfr]')         # %s %d %(name)s

_PH_FMT = "__PH{i}__"
_PH_RE  = re.compile(r'__PH(\d+)__')


def protect(text: str) -> tuple[str, list[str]]:
    """
    Replace non-translatable spans with numbered tokens.
    Returns (modified_text, list_of_original_spans).
    For markdown links [label](url) the label is kept for translation;
    only the URL is protected.
    """
    stored: list[str] = []

    def _store(val: str) -> str:
        i = len(stored)
        stored.append(val)
        return _PH_FMT.format(i=i)

    def _link_repl(m: re.Match) -> str:
        return f"[{m.group(1)}]({_store(m.group(2))})"

    result = _LINK_PAT.sub(_link_repl, text)
    result = _URL_PAT.sub(lambda m: _store(m.group()), result)
    result = _CURLY_PAT.sub(lambda m: _store(m.group()), result)
    result = _CODE_PAT.sub(lambda m: _store(m.group()), result)
    result = _PRINTF_PAT.sub(lambda m: _store(m.group()), result)
    return result, stored


def restore(text: str, stored: list[str]) -> str:
    """Restore __PHn__ tokens to their original spans."""
    def _repl(m: re.Match) -> str:
        i = int(m.group(1))
        return stored[i] if i < len(stored) else m.group()
    return _PH_RE.sub(_repl, text)


# ──────────────────────────────────────────────────────────────────────────────
# CONTENT DETECTION
# ──────────────────────────────────────────────────────────────────────────────

_UUID_RE    = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I
)
_URL_FULL   = re.compile(r'^https?://', re.I)
_EMAIL_RE   = re.compile(r'^[\w.+-]+@[\w-]+\.[a-z]{2,}$', re.I)
_NUMERIC_RE = re.compile(r'^[\d,+\-.%\s]+$')
_REL_PATH_RE = re.compile(r'^/[^\s]+$')   # /upload/site/uuid.jpg — relative paths


def is_translatable(value: str) -> bool:
    """Return True if the string should be included in the translation units."""
    v = value.strip()
    if not v:
        return False
    if (
        _UUID_RE.match(v)
        or _URL_FULL.match(v)
        or _EMAIL_RE.match(v)
        or _NUMERIC_RE.match(v)
        or _REL_PATH_RE.match(v)
    ):
        return False
    return True


# ──────────────────────────────────────────────────────────────────────────────
# SOURCE CONTENT EXTRACTION  (DB rows → flat {content_id: english_text})
# ──────────────────────────────────────────────────────────────────────────────
# Stable content IDs:
#   site_content  →  "<slug>.<field_key>"
#   stats arrays  →  "<slug>.<field_key>.<index>.k"  /  "….<index>.v"
#   site_settings →  "settings.<key>"


def extract_units(
    content_rows: list[dict],
    settings: dict[str, str],
    ann_rows: "list[dict] | None" = None,
) -> dict[str, str]:
    """Flatten site_content rows + settings + announcements into {content_id: english_text}."""
    units: dict[str, str] = {}

    for row in content_rows:
        slug = row["slug"]
        data = row.get("data") or {}
        if isinstance(data, dict):
            _flatten(slug, data, units)

    for key, value in settings.items():
        if key in SKIP_SETTINGS_KEYS:
            continue
        if isinstance(value, str) and is_translatable(value):
            units[f"settings.{key}"] = value.strip()

    for row in (ann_rows or []):
        title = row.get("title")
        if isinstance(title, str) and is_translatable(title):
            units[f"announcements.{row['id']}.title"] = title.strip()

    return units


def _flatten(prefix: str, data: dict, out: dict[str, str]) -> None:
    for field_key, value in data.items():
        cid = f"{prefix}.{field_key}"
        if isinstance(value, str) and is_translatable(value):
            out[cid] = value.strip()
        elif isinstance(value, list):
            # Stats-style: [{"k": label, "v": value}, …]
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    for sub in ("k", "v"):
                        sv = item.get(sub)
                        if isinstance(sv, str) and is_translatable(sv):
                            out[f"{cid}.{i}.{sub}"] = sv.strip()


# ──────────────────────────────────────────────────────────────────────────────
# HASH / STATE
# ──────────────────────────────────────────────────────────────────────────────

def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_state() -> dict[str, str]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(state: dict[str, str]) -> None:
    LOCALES_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


# ──────────────────────────────────────────────────────────────────────────────
# LOCALE FILE  I/O
# ──────────────────────────────────────────────────────────────────────────────

def load_locale(stem: str) -> dict[str, str]:
    path = LOCALES_DIR / f"{stem}.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_locale(stem: str, data: dict[str, str], *, pending: bool = False) -> Path:
    LOCALES_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{stem}.pending" if pending else stem
    path = LOCALES_DIR / f"{name}.json"
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


# ──────────────────────────────────────────────────────────────────────────────
# SENTENCE SPLITTING
# ──────────────────────────────────────────────────────────────────────────────

_FALLBACK_SENT_RE = re.compile(r'(?<=[.!?])\s+')


def split_sentences(text: str) -> list[str]:
    """Split text into sentences using NLTK, falling back to regex."""
    try:
        import nltk  # type: ignore
        for resource in ("tokenizers/punkt_tab", "tokenizers/punkt"):
            try:
                nltk.data.find(resource)
                break
            except LookupError:
                pass
        else:
            nltk.download("punkt_tab", quiet=True)
        sents = nltk.sent_tokenize(text, language="english")
        return [s for s in sents if s.strip()] or [text]
    except Exception:
        parts = _FALLBACK_SENT_RE.split(text)
        return [p for p in parts if p.strip()] or [text]


# ──────────────────────────────────────────────────────────────────────────────
# TRANSLATION PIPELINE  (IndicTrans2 — CPU / float32)
# ──────────────────────────────────────────────────────────────────────────────

def load_model(model_id: str):
    """Load tokenizer, model, and IndicProcessor.  Call once; reuse for all languages."""
    print(f"[model] Loading '{model_id}' (CPU / float32) …", flush=True)
    import torch  # type: ignore
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer  # type: ignore
    from IndicTransToolkit import IndicProcessor  # type: ignore

    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    model = AutoModelForSeq2SeqLM.from_pretrained(
        model_id,
        trust_remote_code=True,
        dtype=torch.float32,  # explicit CPU-safe dtype; do NOT use float16 on CPU
    )
    model.eval()
    ip = IndicProcessor(inference=True)

    print("[model] Ready.", flush=True)
    return model, tokenizer, ip


def _batched(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def translate_batch_raw(
    sentences: list[str],
    model,
    tokenizer,
    ip,
    src_lang: str,
    tgt_lang: str,
    batch_size: int,
) -> list[str]:
    """
    Full 5-step IndicTrans2 pipeline over a flat list of sentences.

    Steps (per chunk):
      1. ip.preprocess_batch  — script normalisation + entity protection
      2. tokenizer            — tokenise to tensors
      3. model.generate       — beam search (num_beams=5 for quality)
      4. tokenizer.batch_decode
      5. ip.postprocess_batch — post-normalisation

    Do NOT call .to("cuda") or .half() — this runs on CPU in float32.
    """
    import torch  # type: ignore

    results: list[str] = []
    for chunk in _batched(sentences, batch_size):
        preprocessed = ip.preprocess_batch(chunk, src_lang=src_lang, tgt_lang=tgt_lang)
        inputs = tokenizer(
            preprocessed,
            truncation=True,
            padding="longest",
            return_tensors="pt",
        )
        with torch.no_grad():
            generated = model.generate(
                **inputs,
                use_cache=False,
                min_length=0,
                max_length=256,
                num_beams=5,
                num_return_sequences=1,
            )
        decoded = tokenizer.batch_decode(
            generated,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=True,
        )
        postprocessed = ip.postprocess_batch(decoded, lang=tgt_lang)
        results.extend(postprocessed)
    return results


def translate_string(
    text: str,
    model,
    tokenizer,
    ip,
    src_lang: str,
    tgt_lang: str,
    batch_size: int,
) -> str:
    """
    Translate a single source string end-to-end.

    - Multi-paragraph markdown is processed paragraph-by-paragraph so that
      double newlines are preserved in the output.
    - URLs, interpolation placeholders ({var}), and inline code are protected
      before translation and restored verbatim afterwards.
    - Each paragraph is split into sentences; all sentences within a paragraph
      are translated in a single batched call.
    """
    if not text.strip():
        return text

    # Split on paragraph separators (double newline), keeping the separators.
    parts = re.split(r'(\n\n+)', text)
    out_parts: list[str] = []

    for part in parts:
        if not part.strip():          # blank / separator — keep as-is
            out_parts.append(part)
            continue

        protected, stored = protect(part)
        sentences = split_sentences(protected)
        translated = translate_batch_raw(
            sentences, model, tokenizer, ip, src_lang, tgt_lang, batch_size
        )
        rejoined = " ".join(translated)
        out_parts.append(restore(rejoined, stored))

    return "".join(out_parts)


# ──────────────────────────────────────────────────────────────────────────────
# DATABASE / SOURCE-FILE  I/O
# ──────────────────────────────────────────────────────────────────────────────

def read_from_db(env_path: Optional[Path] = None) -> tuple[list[dict], dict[str, str]]:
    """Connect to PostgreSQL and read site_content + site_settings."""
    env_path = env_path or (BASE_DIR / ".env")
    if env_path.exists():
        try:
            from dotenv import load_dotenv  # type: ignore
            load_dotenv(env_path, override=False)
        except ModuleNotFoundError:
            # dotenv not installed — parse the .env file manually for DATABASE_URL.
            # When spawned by the Node server the variable is already inherited, so
            # this path only matters when running translate.py standalone without
            # python-dotenv installed.
            if not os.environ.get("DATABASE_URL"):
                with open(env_path) as _f:
                    for _line in _f:
                        _line = _line.strip()
                        if _line.startswith("DATABASE_URL=") and "=" in _line:
                            os.environ["DATABASE_URL"] = _line.split("=", 1)[1].strip().strip('"').strip("'")
                            break

    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set.  Add it to .env or export it as an env var."
        )
    # psycopg2 requires postgresql://, not the shorthand postgres://
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]

    import psycopg2          # type: ignore
    import psycopg2.extras   # type: ignore

    conn = psycopg2.connect(url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT slug, data FROM site_content ORDER BY slug")
            rows = [dict(r) for r in cur.fetchall()]
            cur.execute("SELECT key, value FROM site_settings ORDER BY key")
            settings: dict[str, str] = {r["key"]: r["value"] for r in cur.fetchall()}
            cur.execute(
                "SELECT id, title FROM announcements "
                "WHERE deleted_at IS NULL "
                "ORDER BY display_order ASC, created_at DESC"
            )
            ann_rows = [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()
    return rows, settings, ann_rows


def read_from_file(path: Path) -> dict[str, str]:
    """
    Read a flat  {content_id: english_text}  JSON file.

    This is the same format written to locales/en.json by a normal DB run,
    so --source-file locales/en.json works for offline / fixture testing.
    """
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: expected a JSON object, got {type(raw).__name__}")
    # Skip underscore-prefixed keys (used as in-file comments, e.g. "_note").
    return {k: v for k, v in raw.items() if isinstance(v, str) and not k.startswith("_")}


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Translate ICAI site content with IndicTrans2 (offline, CPU).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Examples:
              python translate.py                              # translate hi + mr, merge live
              python translate.py --languages mr               # Marathi only
              python translate.py --dry-run                    # report changes, no writes
              python translate.py --review                     # write *.pending.json
              python translate.py --force                      # retranslate everything
              python translate.py --source-file locales/en.json   # offline / fixture mode
        """),
    )
    p.add_argument(
        "--languages", "-l",
        nargs="+",
        default=list(SUPPORTED_LANGUAGES),
        choices=list(SUPPORTED_LANGUAGES),
        metavar="LANG",
        help="Target language codes (default: all). Choices: "
             + " ".join(SUPPORTED_LANGUAGES),
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Run translation and print a diff but do not write any files.",
    )
    p.add_argument(
        "--review",
        action="store_true",
        help=(
            "Write changes to <lang>.pending.json rather than <lang>.json "
            "so a fluent speaker can review before merging."
        ),
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Ignore stored hashes and retranslate every string.",
    )
    p.add_argument(
        "--source-file",
        type=Path,
        metavar="FILE",
        help="Read English source from a flat JSON file instead of the database.",
    )
    p.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help=f"Sentences per model call (default: {DEFAULT_BATCH_SIZE}).",
    )
    p.add_argument(
        "--model",
        default=EN_INDIC_MODEL,
        help=f"HuggingFace checkpoint to use (default: {EN_INDIC_MODEL}).",
    )
    return p.parse_args()


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main() -> int:
    args = parse_args()

    # ── 1. Load source content ──────────────────────────────────────────────
    if args.source_file:
        print(f"[source] Reading from file: {args.source_file}", flush=True)
        flat = read_from_file(args.source_file)
        units: dict[str, str] = {
            cid: text.strip()
            for cid, text in flat.items()
            if is_translatable(text)
        }
    else:
        print("[source] Querying database …", flush=True)
        content_rows, settings, ann_rows = read_from_db()
        units = extract_units(content_rows, settings, ann_rows)
        if not args.dry_run:
            save_locale("en", units)
            print(f"[source] Wrote locales/en.json ({len(units)} strings).", flush=True)

    print(f"[source] {len(units)} translatable string(s) found.", flush=True)
    if not units:
        return 0

    # ── 2. Detect changes ───────────────────────────────────────────────────
    state: dict[str, str] = {} if args.force else load_state()
    current_hashes = {cid: sha256(text) for cid, text in units.items()}

    changed_cids: list[str] = sorted(
        cid for cid, h in current_hashes.items()
        if state.get(cid) != h
    )
    removed_cids: list[str] = sorted(
        cid for cid in state
        if cid not in units
    )

    print(
        f"[delta] {len(changed_cids)} to translate, "
        f"{len(units) - len(changed_cids)} unchanged, "
        f"{len(removed_cids)} removed.",
        flush=True,
    )

    if not changed_cids and not removed_cids:
        print("[delta] Nothing to do.")
        return 0

    # ── 3. Load model once ──────────────────────────────────────────────────
    model = tokenizer = ip = None
    if changed_cids:
        model, tokenizer, ip = load_model(args.model)

    # ── 4. Deduplicate source texts ─────────────────────────────────────────
    # Identical source strings are translated only once per language,
    # even if they appear under multiple content IDs.
    unique_texts: list[str] = list(dict.fromkeys(units[cid] for cid in changed_cids))

    # ── 5. Translate and write per target language ──────────────────────────
    for lang_code in args.languages:
        flores_code, file_stem = SUPPORTED_LANGUAGES[lang_code]
        n = len(unique_texts)
        print(f"\n[{lang_code}] Translating {n} unique string(s) → {flores_code} …", flush=True)

        # Translate unique texts (model is already loaded).
        text_to_translation: dict[str, str] = {}
        for i, text in enumerate(unique_texts, 1):
            print(f"  [{i}/{n}]", flush=True)
            text_to_translation[text] = translate_string(
                text, model, tokenizer, ip, SRC_LANG, flores_code, args.batch_size
            )

        # Merge into existing locale dict.
        locale = load_locale(file_stem)
        for rid in removed_cids:
            locale.pop(rid, None)
        for cid in changed_cids:
            locale[cid] = text_to_translation[units[cid]]
        locale = dict(sorted(locale.items()))  # stable key order

        # Print diff summary.
        print(f"  Changes [{lang_code}]:", flush=True)
        for cid in changed_cids:
            snippet = locale.get(cid, "???")[:70].replace("\n", "↵")
            print(f"    + {cid}: {snippet!r}")
        for rid in removed_cids:
            print(f"    - {rid}  (removed)")

        if args.dry_run:
            print(f"[dry-run] No files written.")
        else:
            path = save_locale(file_stem, locale, pending=args.review)
            print(f"  Written: {path}", flush=True)

    # ── 6. Save state (hash cache) ──────────────────────────────────────────
    if not args.dry_run:
        new_state = dict(current_hashes)
        for rid in removed_cids:
            new_state.pop(rid, None)
        save_state(new_state)
        print(f"\n[state] Saved ({len(new_state)} content IDs).", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
