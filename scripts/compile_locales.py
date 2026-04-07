#!/usr/bin/env python3
"""
Compile upstream PeeringDB .po translation files into flat JSON dictionaries
for the frontend i18n module.

Fetches .po files from the peeringdb/translations GitHub repository (Weblate),
filters them to only include strings the frontend actually uses (defined in
frontend/locales/strings.json), and writes one JSON file per language to
frontend/locales/.

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
STRINGS_FILE = os.path.join(OUTPUT_DIR, "strings.json")


def load_ui_strings():
    """
    Loads the set of UI strings the frontend uses from strings.json.
    These are the only keys that will be included in the compiled locale
    JSON files. Strings not in this set are upstream-only (admin, forms)
    and would bloat the frontend dictionary for no benefit.

    Returns:
        set of string keys, or None if the file doesn't exist (meaning
        no filtering — include everything from upstream).
    """
    if not os.path.isfile(STRINGS_FILE):
        print(f"  Warning: {STRINGS_FILE} not found, including all upstream strings")
        return None

    with open(STRINGS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    return set(data.get("strings", []))


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


def compile_locale(locale_dir, short_code, ui_strings):
    """
    Downloads and compiles both django.po and djangojs.po for a locale into
    a single flat JSON dictionary, filtered to only include strings the
    frontend uses.

    Args:
        locale_dir: Directory name in the upstream repo.
        short_code: Frontend language code for the output filename.
        ui_strings: Set of string keys to include, or None for no filtering.

    Returns:
        Tuple of (included_count, total_upstream_count) or (-1, 0) on failure.
    """
    all_upstream = {}

    # Process both catalogs
    for catalog in ("django", "djangojs"):
        content = fetch_po(locale_dir, catalog)
        if content:
            entries = parse_po_to_dict(content)
            all_upstream.update(entries)

    if not all_upstream:
        return (-1, 0)

    # Filter to only include strings the frontend uses
    if ui_strings is not None:
        filtered = {k: v for k, v in all_upstream.items() if k in ui_strings}
    else:
        filtered = all_upstream

    out_path = os.path.join(OUTPUT_DIR, f"{short_code}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(filtered, f, ensure_ascii=False, indent=2, sort_keys=True)

    return (len(filtered), len(all_upstream))


def main():
    """Entry point. Compiles all configured locales and prints a summary."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    ui_strings = load_ui_strings()
    if ui_strings:
        print(f"UI strings catalog: {len(ui_strings)} keys from {STRINGS_FILE}")
    print(f"Fetching from: {REPO_BASE}")
    print(f"Output: {OUTPUT_DIR}")
    print()

    total = 0
    skipped = 0
    coverage_data = []

    for locale_dir, short_code in sorted(LANGUAGES.items()):
        print(f"  {locale_dir} -> {short_code}.json ...", end=" ", flush=True)
        included, upstream_total = compile_locale(locale_dir, short_code, ui_strings)
        if included < 0:
            print("SKIP (no translations found)")
            skipped += 1
        else:
            print(f"OK ({included} of {upstream_total} upstream entries)")
            total += 1
            if ui_strings:
                coverage_data.append((short_code, included, len(ui_strings)))

    print()
    print(f"Done. Compiled {total} locales, {skipped} skipped.")

    # Print coverage report for our UI strings
    if coverage_data:
        print()
        print("UI string coverage:")
        for code, translated, total_strings in sorted(coverage_data, key=lambda x: -x[1]):
            pct = (translated / total_strings * 100) if total_strings else 0
            bar = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
            print(f"  {code:6s} {bar} {translated:3d}/{total_strings} ({pct:.0f}%)")

        # Report which strings have no translation in ANY locale
        if ui_strings:
            print()
            all_translated = set()
            for locale_dir, short_code in LANGUAGES.items():
                locale_path = os.path.join(OUTPUT_DIR, f"{short_code}.json")
                if os.path.isfile(locale_path):
                    with open(locale_path, "r", encoding="utf-8") as f:
                        all_translated.update(json.load(f).keys())
            never_translated = ui_strings - all_translated
            if never_translated:
                print(f"Never translated ({len(never_translated)} strings):")
                for s in sorted(never_translated):
                    print(f"  - {s}")
            else:
                print("All UI strings have at least one translation.")


if __name__ == "__main__":
    main()
