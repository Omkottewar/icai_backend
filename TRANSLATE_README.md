# Translation Pipeline — IndicTrans2

Admin-triggered batch translation of ICAI site content into Hindi and Marathi.  
No translation happens at runtime: this script is run once when content changes,
and the app serves the resulting static JSON files.

---

## Architecture

```
Admin edits content
        │
        ▼
  python translate.py          ← this script
        │
        ├─ reads site_content + site_settings from PostgreSQL
        ├─ detects which strings changed (SHA-256 hash comparison)
        ├─ runs IndicTrans2 locally (CPU, no API, no GPU needed)
        └─ writes locales/hi.json  locales/mr.json
                   │
                   ▼
        Node/Express serves JSON
        Frontend overlays translations onto English content
```

The English source is also cached to `locales/en.json` after each DB run so you
can re-run offline with `--source-file locales/en.json`.

---

## First-time setup

### 1. Prerequisites

- Python 3.9 or newer  
  *(the repo's `transenv` uses Python 3.14 — all packages support it)*
- ~5 GB free disk (model weights cache to `~/.cache/huggingface/hub`)

### 2. Activate the virtual environment

```bash
cd icai_backend
source transenv/bin/activate
```

Or create a fresh one:

```bash
python -m venv transenv
source transenv/bin/activate
```

### 3. Install PyTorch (CPU build — MUST come first)

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

### 4. Install remaining dependencies

```bash
pip install -r requirements-translate.txt
```

### 5. Authenticate with HuggingFace (one-time)

The `ai4bharat/indictrans2-en-indic-1B` checkpoint is gated.  
You need to:

1. Create a free account at <https://huggingface.co>
2. Accept the model terms at  
   <https://huggingface.co/ai4bharat/indictrans2-en-indic-1B>
3. Log in from the terminal:

```bash
huggingface-cli login
```

Model weights are downloaded on the **first run only** and cached locally.
Subsequent runs are fully offline.

---

## Configuration

All configuration lives at the top of `translate.py`.  Most defaults are correct
for this project; the only value you may need to change is `EN_INDIC_MODEL` if you
want to use the distilled (smaller/faster) checkpoint.

| Constant | Default | Description |
|---|---|---|
| `LOCALES_DIR` | `icai_backend/locales/` | Output directory |
| `SRC_LANG` | `eng_Latn` | Source FLORES code |
| `EN_INDIC_MODEL` | `ai4bharat/indictrans2-en-indic-1B` | 1B-param model (recommended) |
| `DEFAULT_BATCH_SIZE` | `8` | Sentences per `model.generate()` call |
| `SKIP_SETTINGS_KEYS` | URLs, phone, email | site_settings keys that must not be translated |

**Distilled fallback** (less RAM, lower quality):

```python
EN_INDIC_MODEL = "ai4bharat/indictrans2-en-indic-dist-200M"
```

---

## Usage

```
python translate.py [OPTIONS]

Options:
  -l, --languages LANG [LANG ...]
                    Target languages: hi mr  (default: both)
  --dry-run         Translate and print what would change; do not write files.
  --review          Write to <lang>.pending.json instead of <lang>.json so a
                    fluent speaker can review before going live.
  --force           Ignore stored hashes — retranslate everything.
  --source-file FILE
                    Read source content from a flat JSON file instead of the DB.
                    Useful for offline testing or CI.
  --batch-size N    Sentences per model call (default: 8). Reduce if you hit OOM.
  --model ID        HuggingFace model ID (overrides EN_INDIC_MODEL).
```

### Common workflows

**Normal run (triggered by admin after content update):**
```bash
python translate.py
```

**Translate only Hindi:**
```bash
python translate.py --languages hi
```

**Dry-run to see what would change without writing:**
```bash
python translate.py --dry-run
```

**Human review before publishing:**
```bash
python translate.py --review
# Review locales/hi.pending.json and locales/mr.pending.json
# If satisfied, rename them:
mv locales/hi.pending.json locales/hi.json
mv locales/mr.pending.json locales/mr.json
```

**Force full retranslation:**
```bash
python translate.py --force
```

**Offline demo with the included fixture (no DB needed):**
```bash
python translate.py --source-file locales/en.sample.json --dry-run
# Remove --dry-run to actually write locales/hi.json and locales/mr.json
python translate.py --source-file locales/en.sample.json
```

---

## Output format

Each locale file is a flat UTF-8 JSON object keyed by stable content IDs:

```json
{
  "about_history.body": "आईसीएआई नागपुर शाखा **1952** में स्थापित हुई ...",
  "chairman_message.name": "सीए रमेश शर्मा",
  "chairman_message.quote": "केंद्रीय भारत के चार्टर्ड अकाउंटेंट्स के लिए ...",
  "settings.branch_address": "प्लॉट नं. 123, सीए रोड, सिविल लाइन्स, नागपुर ...",
  ...
}
```

Content IDs follow the pattern:

| Source | Content ID |
|---|---|
| `site_content` row slug `chairman_message`, field `quote` | `chairman_message.quote` |
| `site_content` stats array, first item's label | `home_hero_stats.stats.0.k` |
| `site_settings` key `branch_address` | `settings.branch_address` |

Fields containing only numbers, UUIDs, URLs, or email addresses are not included
(they don't need translation and the frontend falls back to the English value).

---

## Incremental / idempotent re-runs

The script tracks a SHA-256 hash of each source string in
`locales/.translation_state.json`.  On each run:

- **Unchanged strings** → skipped (zero model calls, output byte-stable)
- **New or changed strings** → translated and merged into the locale files
- **Removed strings** → deleted from locale files

A second consecutive run with no source changes produces **no translation work**
and does not modify the output files.

---

## Integrating with the Node backend

The script writes static files to `locales/`.  The Express server can serve them
directly:

```ts
// In server/index.ts (or wherever static files are configured)
import path from "path";
app.use("/locales", express.static(path.join(__dirname, "../locales")));
```

Frontend fetches the appropriate file at startup:

```js
const lang = navigator.language.startsWith("hi") ? "hi"
           : navigator.language.startsWith("mr") ? "mr"
           : "en";

const localeData = lang === "en"
  ? {}
  : await fetch(`/locales/${lang}.json`).then(r => r.json());

// Overlay: translated value wins; English content from API is the fallback.
function t(slug, field) {
  const key = `${slug}.${field}`;
  return localeData[key] ?? englishContent[slug]?.[field] ?? "";
}
```

---

## FLORES language codes reference

| Language | Code |
|---|---|
| English | `eng_Latn` |
| Hindi | `hin_Deva` |
| Marathi | `mar_Deva` |
| Bengali | `ben_Beng` |
| Gujarati | `guj_Gujr` |
| Kannada | `kan_Knda` |
| Malayalam | `mal_Mlym` |
| Odia | `ory_Orya` |
| Punjabi | `pan_Guru` |
| Tamil | `tam_Taml` |
| Telugu | `tel_Telu` |
| Urdu | `urd_Arab` |

To add a new language, extend `SUPPORTED_LANGUAGES` in `translate.py`.

---

## Troubleshooting

**`RuntimeError: DATABASE_URL is not set`**  
Make sure `.env` is present in `icai_backend/` and contains `DATABASE_URL`.

**`ModuleNotFoundError: IndicTransToolkit`**  
```bash
pip install IndicTransToolkit
# or from source:
pip install git+https://github.com/VarunGumma/IndicTransToolkit.git
```

**`OSError: You are trying to access a gated repo`**  
Run `huggingface-cli login` and accept the model terms on the Hub (see First-time setup).

**Out-of-memory on CPU**  
Reduce `--batch-size` to 4 or 2, or switch to the distilled model (`-dist-200M`).

**Translation quality is poor for a specific string**  
1. Check that the string is not being split at an awkward sentence boundary.
2. Try wrapping multi-sentence values in shorter paragraphs.
3. After running with `--review`, a fluent speaker can edit `*.pending.json` by hand before promoting it to the live file.
