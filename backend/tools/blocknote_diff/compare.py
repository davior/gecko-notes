"""Diff `markdown_to_blocks` against BlockNote's own Markdown parser.

The unit tests in `tests/test_markdown_blocks.py` pin the converter's behaviour, but
they can only assert what we *believe* BlockNote does. This compares against what it
actually does, and it is how four wrong beliefs were caught the first time round
(heading levels stop at 3; there is no divider block; an unlabelled fence has no
language; alt text goes in `caption`).

Not part of the pytest run — it needs Node and a package install, so it is a
deliberate step when bumping @blocknote/core rather than a per-commit cost.

    cd backend/tools/blocknote_diff
    npm install @blocknote/core@<version> @blocknote/server-util@<version>
    node reference.mjs corpus.json > reference.json
    cd ../.. && python tools/blocknote_diff/compare.py

Exits non-zero if anything diverges. Add a sample to corpus.json whenever the
assistant is seen emitting Markdown this does not already cover.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("JWT_SECRET_KEY", "tools-only-secret")

from app.blocks.markdown_blocks import markdown_to_blocks  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# Props BlockNote always writes out and we let default. Comparing them would be
# comparing formatting conventions, not fidelity.
DEFAULTS = {
    "backgroundColor": "default",
    "textColor": "default",
    "textAlignment": "left",
    "isToggleable": False,
    "colspan": 1,
    "rowspan": 1,
}


def _props(props):
    return {k: v for k, v in (props or {}).items() if DEFAULTS.get(k) != v}


def _normalise(blocks):
    out = []
    for block in blocks:
        node = {"type": block.get("type"), "props": _props(block.get("props"))}
        content = block.get("content")
        if isinstance(content, list):
            node["content"] = [
                (i.get("type"), i.get("text"), i.get("styles"), i.get("href"))
                for i in content
            ]
        elif isinstance(content, dict):
            node["content"] = [
                [
                    [
                        (t.get("text"), t.get("styles"))
                        for t in (cell.get("content") if isinstance(cell, dict) else cell) or []
                    ]
                    for cell in row.get("cells", [])
                ]
                for row in content.get("rows", [])
            ]
        node["children"] = _normalise(block.get("children") or [])
        out.append(node)
    return out


def main() -> int:
    corpus = json.load(open(os.path.join(HERE, "corpus.json")))
    reference_path = os.path.join(HERE, "reference.json")
    if not os.path.exists(reference_path):
        print("reference.json missing — run `node reference.mjs corpus.json > reference.json` first")
        return 2
    reference = json.load(open(reference_path))

    diverged = 0
    for markdown, expected in zip(corpus, reference):
        ours = _normalise(markdown_to_blocks(markdown))
        theirs = _normalise(expected)
        if ours != theirs:
            diverged += 1
            print("=" * 72)
            print("INPUT     :", json.dumps(markdown))
            print("BLOCKNOTE :", json.dumps(theirs))
            print("OURS      :", json.dumps(ours))

    print("=" * 72)
    print(f"{len(corpus) - diverged}/{len(corpus)} samples structurally identical")
    return 1 if diverged else 0


if __name__ == "__main__":
    raise SystemExit(main())
