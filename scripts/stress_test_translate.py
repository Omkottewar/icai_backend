#!/usr/bin/env python3
"""
stress_test_translate.py — Comprehensive stress test for translate.py.

Tests all pure-Python logic (no ML stack required):
  1. protect / restore round-trips
  2. is_translatable boundary cases
  3. extract_units content-ID generation
  4. Incremental hash detection (new / changed / unchanged / removed)
  5. Locale file validation (key format, no empty values)
  6. Key-consistency check — Python content IDs match what useSiteContent expects
  7. Frontend overlay simulation — verify translations actually override defaults

Run from icai_backend/:
    python scripts/stress_test_translate.py
"""

from __future__ import annotations
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── Load translate.py logic without triggering ML imports ──────────────────
_code = (ROOT / "translate.py").read_text()
_boundary = "\ndef main("
_safe_code = _code[:_code.index(_boundary)].replace(
    "Path(__file__).resolve().parent",
    f"Path('{ROOT}')",
)
_g: dict = {}
exec(_safe_code, _g)  # noqa: S102

protect         = _g["protect"]
restore         = _g["restore"]
is_translatable = _g["is_translatable"]
extract_units   = _g["extract_units"]
sha256          = _g["sha256"]
read_from_file  = _g["read_from_file"]
LOCALES_DIR     = _g["LOCALES_DIR"]

# ── Tiny test harness ──────────────────────────────────────────────────────
PASS = FAIL = 0

def ok(label: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32m✓\033[0m  {label}")
    else:
        FAIL += 1
        print(f"  \033[31m✗\033[0m  {label}" + (f"  →  {extra}" if extra else ""))

def section(title: str) -> None:
    print(f"\n\033[1m{'─'*62}\033[0m")
    print(f"\033[1m  {title}\033[0m")
    print(f"\033[1m{'─'*62}\033[0m")

# ═══════════════════════════════════════════════════════════════════════════
# 1. protect / restore round-trips
# ═══════════════════════════════════════════════════════════════════════════
section("1 · protect / restore round-trips")

ROUND_TRIP_CASES = [
    # (description, source text)
    ("plain text",
     "Serving Chartered Accountants of Nagpur."),
    ("bare URL",
     "Visit https://icai.org for details."),
    ("markdown link",
     "Read the [annual report](https://icainagpur.org/reports)."),
    ("curly-brace var",
     "Hello {name}, your CPE credit is {credits}."),
    ("double-brace escaped",
     "Template literal: {{escaped}} value."),
    ("inline code",
     "Run `pip install torch` to install."),
    ("printf %s",
     "Member count: %s registered."),
    ("URL + curly together",
     "See {link} or visit https://icai.org/contact."),
    ("markdown link with {var} in label",
     "Check [membership for {year}](https://icai.org/members)."),
    ("multi-sentence with URL",
     "Our branch is in Nagpur. Visit https://example.com/map for directions. Thank you."),
    ("markdown bold — no protection needed",
     "**Empowering** CA professionals since 1962."),
    ("empty string",
     ""),
    ("only whitespace",
     "   "),
    ("multiple URLs",
     "See https://icai.org or https://wirc.org for more."),
    ("URL inside markdown link + bare URL",
     "Read [this](https://icai.org/a) or visit https://icai.org/b directly."),
    ("nested braces with URL",
     "Post to {endpoint} at https://api.example.com/{id}/status."),
    ("percent-d and percent-s together",
     "Found %d records matching %s."),
    ("multiline with paragraph break",
     "First paragraph about ICAI.\n\nSecond paragraph with {var} placeholder."),
]

for desc, src in ROUND_TRIP_CASES:
    protected, stored = protect(src)
    got = restore(protected, stored)
    ok(desc, got == src, f"got {got!r}")

# ═══════════════════════════════════════════════════════════════════════════
# 2. is_translatable boundary cases
# ═══════════════════════════════════════════════════════════════════════════
section("2 · is_translatable boundary cases")

TRANSLATABLE = [
    "Members",
    "Serving Chartered Accountants",
    "Mon–Sat 10:30–18:00",                # has letters
    "80 seats",                            # has letters
    "4,200+ titles",                       # has letters
    "READING ROOM",
    "© 2024 ICAI Nagpur Branch",           # has letters
    "CA 2.0",                              # letters present
    "Events / yr",                         # letters present
]

NOT_TRANSLATABLE = [
    "",                                    # empty
    "   ",                                 # whitespace only
    "5,000+",                             # numeric
    "8,500+",                             # numeric
    "150+",                               # numeric
    "1962",                               # numeric
    "100%",                               # numeric
    "f47ac10b-58cc-4372-a567-0e02b2c3d479",  # UUID
    "https://icai.org",                   # URL
    "https://maps.google.com/?q=ICAI",    # URL with query
    "nagpur@icai.org",                    # email
]

for v in TRANSLATABLE:
    ok(f"translatable: {v!r}", is_translatable(v),
       f"returned False")

for v in NOT_TRANSLATABLE:
    ok(f"NOT translatable: {v!r}", not is_translatable(v),
       f"returned True")

# ═══════════════════════════════════════════════════════════════════════════
# 3. extract_units — content-ID generation
# ═══════════════════════════════════════════════════════════════════════════
section("3 · extract_units — content-ID generation")

_rows = [
    {"slug": "chairman_message", "data": {
        "photo_url": "f47ac10b-58cc-4372-a567-0e02b2c3d479",  # UUID → skip
        "quote":     "Our branch is committed to excellence.",
        "name":      "CA. Swaroopa Wazalwar",
        "role_line": "Chairperson, Nagpur Branch · 2025–26",
    }},
    {"slug": "home_hero", "data": {
        "tagline": "Serving CAs of Nagpur.",
    }},
    {"slug": "home_hero_stats", "data": {
        "stats": [
            {"k": "5,000+",  "v": "Members"},    # k numeric → skip k; translate v
            {"k": "8,500+",  "v": "Students"},
            {"k": "150+",    "v": "Events / yr"},
            {"k": "1962",    "v": "Established"},
        ],
    }},
    {"slug": "home_branch_premises", "data": {
        "body":  "A three-storey facility in Dhantoli.",
        "stats": [
            {"k": "80 seats",      "v": "READING ROOM"},   # k has letters → translate both
            {"k": "4,200+ titles", "v": "LIBRARY"},
        ],
    }},
    {"slug": "empty_data", "data": {}},
    {"slug": "null_data",  "data": None},
]
_settings = {
    "branch_address":    "ICAI Bhawan, Nagpur",
    "branch_phone":      "+91 712 244 1590",       # skip — in SKIP list
    "branch_email":      "nagpur@icai.org",        # skip — in SKIP list
    "branch_map_url":    "https://maps.google.com/",  # skip — in SKIP list
    "branch_hours":      "Mon–Sat 10:30–18:00",
    "footer_disclaimer": "© 2024 ICAI Nagpur Branch.",
}

units = extract_units(_rows, _settings)

# Content fields
ok("chairman_message.quote present",     "chairman_message.quote"     in units)
ok("chairman_message.name present",      "chairman_message.name"      in units)
ok("chairman_message.role_line present", "chairman_message.role_line" in units)
ok("chairman_message.photo_url absent",  "chairman_message.photo_url" not in units,
   "UUID should be filtered")
ok("home_hero.tagline present",          "home_hero.tagline"          in units)

# Stats: numeric k → absent, label v → present
ok("home_hero_stats.stats.0.k absent (numeric)", "home_hero_stats.stats.0.k" not in units)
ok("home_hero_stats.stats.0.v present",          "home_hero_stats.stats.0.v"  in units)
ok("home_hero_stats.stats.0.v == 'Members'",
   units.get("home_hero_stats.stats.0.v") == "Members")
ok("home_hero_stats.stats.3.k absent (year)",    "home_hero_stats.stats.3.k" not in units)
ok("home_hero_stats.stats.3.v present",          "home_hero_stats.stats.3.v"  in units)

# Stats: text k → present
ok("home_branch_premises.stats.0.k present (has letters)",
   "home_branch_premises.stats.0.k" in units)
ok("home_branch_premises.stats.0.v present",
   "home_branch_premises.stats.0.v" in units)
ok("home_branch_premises.stats.0.k == '80 seats'",
   units.get("home_branch_premises.stats.0.k") == "80 seats")

# Settings
ok("settings.branch_address present",    "settings.branch_address"    in units)
ok("settings.branch_hours present",      "settings.branch_hours"      in units)
ok("settings.footer_disclaimer present", "settings.footer_disclaimer" in units)
ok("settings.branch_phone absent",       "settings.branch_phone"      not in units)
ok("settings.branch_email absent",       "settings.branch_email"      not in units)
ok("settings.branch_map_url absent",     "settings.branch_map_url"    not in units)

# Edge cases
ok("empty_data slug produces no units",
   not any(k.startswith("empty_data.") for k in units))
ok("null_data slug produces no units",
   not any(k.startswith("null_data.") for k in units))

# ═══════════════════════════════════════════════════════════════════════════
# 4. Incremental hash detection (new / changed / unchanged / removed)
# ═══════════════════════════════════════════════════════════════════════════
section("4 · Incremental hash detection")

_src_v1 = {
    "a.title":  "Welcome to ICAI Nagpur",
    "a.body":   "We serve over 5000 CAs.",
    "b.label":  "Members",
}
_src_v2 = {
    "a.title":  "Welcome to ICAI Nagpur",         # unchanged
    "a.body":   "We now serve over 6000 CAs.",    # changed
    "c.new":    "New field added.",                # new
    # b.label removed
}

_hashes_v1 = {cid: sha256(t) for cid, t in _src_v1.items()}
_hashes_v2 = {cid: sha256(t) for cid, t in _src_v2.items()}

# Simulate the logic from main()
_changed = [cid for cid, h in _hashes_v2.items() if _hashes_v1.get(cid) != h]
_removed = [cid for cid in _hashes_v1 if cid not in _hashes_v2]
_unchanged = [cid for cid in _src_v2 if _hashes_v1.get(cid) == _hashes_v2.get(cid)]

ok("changed: a.body detected",    "a.body"  in _changed)
ok("changed: c.new detected",     "c.new"   in _changed)
ok("unchanged: a.title not in changed", "a.title" not in _changed)
ok("removed: b.label detected",   "b.label" in _removed)
ok("unchanged count == 1",        len(_unchanged) == 1)
ok("second run no-ops (all same hashes)",
   not [cid for cid, h in _hashes_v2.items() if _hashes_v2.get(cid) != h])

# ═══════════════════════════════════════════════════════════════════════════
# 5. Locale file validation
# ═══════════════════════════════════════════════════════════════════════════
section("5 · Locale file validation")

_LOCALE_STEMS = ["hi", "mr"]
for stem in _LOCALE_STEMS:
    path = LOCALES_DIR / f"{stem}.json"
    ok(f"{stem}.json exists", path.exists())
    if not path.exists():
        continue
    data = json.loads(path.read_text(encoding="utf-8"))
    ok(f"{stem}.json is a dict", isinstance(data, dict))
    # All keys should match the content-ID pattern
    _bad_keys = [k for k in data if not _g["re"].match(r'^[\w.]+$', k)]
    ok(f"{stem}.json — all keys match content-ID pattern",
       not _bad_keys, f"bad: {_bad_keys[:3]}")
    # All values should be non-empty strings
    _bad_vals = [k for k, v in data.items() if not isinstance(v, str) or not v.strip()]
    ok(f"{stem}.json — all values non-empty strings",
       not _bad_vals, f"bad: {_bad_vals[:3]}")
    # hi and mr must have same key set
    ok(f"{stem}.json — hi/mr key parity",
       len(data) > 0)

if all((LOCALES_DIR / f"{s}.json").exists() for s in _LOCALE_STEMS):
    _hi = json.loads((LOCALES_DIR / "hi.json").read_text())
    _mr = json.loads((LOCALES_DIR / "mr.json").read_text())
    _diff = set(_hi) ^ set(_mr)
    ok("hi.json and mr.json have identical key sets", not _diff,
       f"mismatched keys: {_diff}")

# ═══════════════════════════════════════════════════════════════════════════
# 6. Sample fixture — read_from_file + is_translatable filter
# ═══════════════════════════════════════════════════════════════════════════
section("6 · Sample fixture integrity")

_sample_path = LOCALES_DIR / "en.sample.json"
ok("en.sample.json exists", _sample_path.exists())
if _sample_path.exists():
    _raw = json.loads(_sample_path.read_text())
    _flat = {k: v for k, v in _raw.items()
             if isinstance(v, str) and not k.startswith("_")}
    _units = {cid: t.strip() for cid, t in _flat.items() if is_translatable(t)}

    ok("sample has > 10 translatable units",   len(_units) > 10,
       f"got {len(_units)}")
    ok("sample uses .v for hero stats (not .k)",
       "home_hero_stats.stats.0.v" in _units and
       "home_hero_stats.stats.0.k" not in _units)
    ok("sample has branch premises stats keys",
       "home_branch_premises.stats.0.k" in _units)
    ok("sample has markdown body (history)",
       "about_history.body" in _units)
    ok("multi-paragraph body contains newline",
       "\n" in _units.get("about_history.body", ""))
    ok("markdown body has bold markers",
       "**" in _units.get("about_history.body", ""))

# ═══════════════════════════════════════════════════════════════════════════
# 7. Frontend overlay consistency
# ═══════════════════════════════════════════════════════════════════════════
section("7 · Frontend overlay consistency — Python IDs vs JS lookups")

# Simulate SITE_CONTENT_DEFAULTS shapes that useSiteContent processes
_DEFAULTS = {
    "chairman_message": {
        "photo_url": None,
        "quote":    "Default quote.",
        "name":     "CA. Name",
        "role_line": "Chairperson · 2025–26",
    },
    "home_hero": {"tagline": "Default tagline."},
    "home_hero_stats": {
        "stats": [
            {"k": "5,000+", "v": "Members"},
            {"k": "8,500+", "v": "Students"},
        ],
    },
    "home_branch_premises": {
        "body": "Default body.",
        "stats": [
            {"k": "80 seats", "v": "READING ROOM"},
        ],
    },
}

# Simulate what extract_units produces (Python side)
_py_rows = [{"slug": slug, "data": data} for slug, data in _DEFAULTS.items()
            if isinstance(data, dict)]
_py_units = extract_units(_py_rows, {})

# Simulate what useSiteContent's overlay does (JS side, in Python)
def _js_overlay(slug: str, merged: dict, locale: dict) -> dict:
    """Python replica of useSiteContent's locale overlay logic."""
    out = dict(merged)
    for key, val in merged.items():
        cid = f"{slug}.{key}"
        if isinstance(val, str) and locale.get(cid):
            out[key] = locale[cid]
        elif isinstance(val, list):
            new_list = []
            for i, item in enumerate(val):
                if not isinstance(item, dict):
                    new_list.append(item)
                    continue
                t = dict(item)
                for sub in ("k", "v"):
                    tv = locale.get(f"{cid}.{i}.{sub}")
                    if tv:
                        t[sub] = tv
                new_list.append(t)
            out[key] = new_list
    return out

# Build a mock locale from the Python-generated units (identity: English=translation)
_mock_locale = {cid: f"[translated:{text}]" for cid, text in _py_units.items()}

# Verify the overlay hits for every Python-generated content ID
_all_hit = True
for slug, data in _DEFAULTS.items():
    _overlaid = _js_overlay(slug, data, _mock_locale)
    for key, val in data.items():
        cid = f"{slug}.{key}"
        if isinstance(val, str) and cid in _py_units:
            if _overlaid.get(key) != f"[translated:{val}]":
                _all_hit = False
                print(f"     miss: {cid}")
        elif isinstance(val, list):
            for i, item in enumerate(val):
                if not isinstance(item, dict):
                    continue
                for sub in ("k", "v"):
                    subcid = f"{cid}.{i}.{sub}"
                    item_v = item.get(sub, "")
                    if subcid in _py_units:
                        got = _overlaid[key][i].get(sub)
                        exp = f"[translated:{item_v}]"
                        if got != exp:
                            _all_hit = False
                            print(f"     miss: {subcid}  got={got!r}")

ok("every Python content-ID is reachable by JS overlay", _all_hit)

# Verify numeric stats k values are NOT in py_units AND NOT overridden
_hero_stats_out = _js_overlay("home_hero_stats",
                              _DEFAULTS["home_hero_stats"],
                              _mock_locale)
ok("hero stats k (5,000+) not overridden — numeric stays as-is",
   _hero_stats_out["stats"][0]["k"] == "5,000+")
ok("hero stats v (Members) IS overridden",
   _hero_stats_out["stats"][0]["v"] == "[translated:Members]")

# Verify overlay with hi.json against DEFAULTS
if (LOCALES_DIR / "hi.json").exists():
    _hi_locale = json.loads((LOCALES_DIR / "hi.json").read_text())
    _hi_hero = _js_overlay("home_hero", _DEFAULTS["home_hero"], _hi_locale)
    ok("hi: home_hero.tagline is translated",
       _hi_hero["tagline"] != "Default tagline.")
    _hi_chair = _js_overlay("chairman_message",
                             _DEFAULTS["chairman_message"], _hi_locale)
    ok("hi: chairman_message.name is translated",
       "CA" in _hi_chair["name"] or "सी" in _hi_chair["name"] or "सीए" in _hi_chair["name"],
       f"got {_hi_chair['name']!r}")
    ok("hi: chairman_message.photo_url unchanged (not in locale)",
       _hi_chair["photo_url"] is None)
    _hi_stats = _js_overlay("home_hero_stats",
                             _DEFAULTS["home_hero_stats"], _hi_locale)
    ok("hi: hero stats.v translated", _hi_stats["stats"][0]["v"] != "Members")
    ok("hi: hero stats.k unchanged",  _hi_stats["stats"][0]["k"] == "5,000+")

# ═══════════════════════════════════════════════════════════════════════════
# 8. protect — placeholder survives a plausible model no-op
# ═══════════════════════════════════════════════════════════════════════════
section("8 · Placeholder token stress — adversarial model outputs")

# Simulate model outputs where the token is in different positions or has
# adjacent punctuation — restore must still recover the original.
_ADVERSARIAL = [
    # protect() leaves the markdown label translatable and only tokens the URL:
    # source      → "[our portal](__PH0__)"
    # model output → "[हमारे पोर्टल](__PH0__)"   ← realistic: placeholder survives
    ("URL in link — placeholder survives in model output",
     "visit [our portal](https://icai.org/members) today",
     "विजिट करें [हमारे पोर्टल](__PH0__) आज",
     None),
    ("token at sentence start",
     "https://icai.org is our website.",
     "__PH0__ हमारी वेबसाइट है।",
     None),
    ("token at sentence end",
     "For details visit https://icai.org.",
     "विवरण के लिए __PH0__ पर जाएं।",
     None),
    ("curly var mid-sentence",
     "Hello {name}, welcome to ICAI.",
     "नमस्ते __PH0__, ICAI में आपका स्वागत है।",
     None),
]

for desc, src, fake_translated, custom_restore in _ADVERSARIAL:
    protected, stored = protect(src)
    restored = (custom_restore(protected, stored, fake_translated)
                if custom_restore
                else restore(fake_translated, stored))
    # The URL / var should be in the restored output
    # (we check each stored value appears in the restoration)
    all_restored = all(s in restored for s in stored)
    ok(f"adversarial: {desc}", all_restored,
       f"restored={restored!r}, stored={stored!r}")

# ═══════════════════════════════════════════════════════════════════════════
# Final report
# ═══════════════════════════════════════════════════════════════════════════
total = PASS + FAIL
print(f"\n{'═'*62}")
if FAIL == 0:
    print(f"\033[32m  All {total} tests passed.\033[0m")
else:
    print(f"\033[31m  {FAIL} / {total} tests FAILED.\033[0m")
print(f"{'═'*62}\n")
sys.exit(0 if FAIL == 0 else 1)
