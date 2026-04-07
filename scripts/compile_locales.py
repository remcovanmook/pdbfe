#!/usr/bin/env python3
"""
Compile upstream PeeringDB .po translation files into flat JSON dictionaries
for the frontend i18n module.

Fetches .po files from the peeringdb/translations GitHub repository (Weblate)
and writes one JSON file per language to frontend/locales/.

Usage:
    source .venv/bin/activate
    python scripts/compile_locales.py

Dependencies:
    pip install polib       (already in .venv)
"""

import json
import os
import sys
import urllib.request
import urllib.error
import tempfile

try:
    import polib
except ImportError:
    print("Error: polib is required. Install it with: pip install polib", file=sys.stderr)
    sys.exit(1)


# Curated language set matching upstream settings.LANGUAGES.
# Keys are the locale directory names used in the peeringdb/translations repo.
# Values are the short codes used in our frontend.
LANGUAGES = {
    "cs_CZ": "cs",
    "de_DE": "de",
    "el_GR": "el",
    "es":    "es",
    "fr_FR": "fr",
    "it":    "it",
    "ja_JP": "ja",
    "lt":    "lt",
    "oc":    "oc",
    "pt":    "pt",
    "ro_RO": "ro",
    "ru_RU": "ru",
    "zh_CN": "zh-cn",
    "zh_TW": "zh-tw",
}

REPO_BASE = "https://raw.githubusercontent.com/peeringdb/translations/master/locale"

# Where to write the generated JSON files
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "frontend", "locales")


def fetch_po(locale_dir, catalog="django"):
    """
    Fetches a .po file from the upstream translations repository.

    Args:
        locale_dir: Directory name in the repo (e.g. 'pt', 'de_DE').
        catalog: Either 'django' or 'djangojs'.

    Returns:
        The raw .po file content as a string, or None if not found.
    """
    url = f"{REPO_BASE}/{locale_dir}/LC_MESSAGES/{catalog}.po"
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except urllib.error.URLError as e:
        print(f"  Warning: Network error fetching {url}: {e}", file=sys.stderr)
        return None


def parse_po_to_dict(po_content):
    """
    Parses .po file content and returns a flat dictionary of
    translated entries. Skips fuzzy, untranslated, and empty entries.

    Args:
        po_content: Raw .po file content string.

    Returns:
        dict mapping msgid -> msgstr for translated entries.
    """
    result = {}

    # Write to a tempfile because polib.pofile() expects a file path
    with tempfile.NamedTemporaryFile(mode="w", suffix=".po", delete=False) as tmp:
        tmp.write(po_content)
        tmp_path = tmp.name

    try:
        po = polib.pofile(tmp_path)
        for entry in po.translated_entries():
            if entry.msgid and entry.msgstr and "fuzzy" not in entry.flags:
                result[entry.msgid] = entry.msgstr
    finally:
        os.unlink(tmp_path)

    return result


def compile_locale(locale_dir, short_code):
    """
    Downloads and compiles both django.po and djangojs.po for a locale into
    a single flat JSON dictionary.

    Args:
        locale_dir: Directory name in the upstream repo.
        short_code: Frontend language code for the output filename.

    Returns:
        Number of translated entries, or -1 on failure.
    """
    merged = {}

    # Process both catalogs
    for catalog in ("django", "djangojs"):
        content = fetch_po(locale_dir, catalog)
        if content:
            entries = parse_po_to_dict(content)
            merged.update(entries)

    if not merged:
        return -1

    out_path = os.path.join(OUTPUT_DIR, f"{short_code}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2, sort_keys=True)

    return len(merged)


def main():
    """Entry point. Compiles all configured locales and prints a summary."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Compiling locales from {REPO_BASE}")
    print(f"Output directory: {OUTPUT_DIR}")
    print()

    total = 0
    skipped = 0

    for locale_dir, short_code in sorted(LANGUAGES.items()):
        print(f"  {locale_dir} -> {short_code}.json ...", end=" ", flush=True)
        count = compile_locale(locale_dir, short_code)
        if count < 0:
            print("SKIP (no translations found)")
            skipped += 1
        else:
            print(f"OK ({count} entries)")
            total += 1

    print()
    print(f"Done. Compiled {total} locales, {skipped} skipped.")


if __name__ == "__main__":
    main()
