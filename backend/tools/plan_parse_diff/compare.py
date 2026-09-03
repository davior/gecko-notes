"""Diff `app.assistant.plan_parse` against the TypeScript `parsePlan` it was ported from.

`tests/test_plan_parse.py` pins what we *believe* the parser does. This pins what the
original actually does, which is the only thing that matters: the browser and the
worker now both turn a model reply into a plan, and a disagreement between them is a
plan that gets approved in the review modal and then executed as something else.

Not part of the pytest run — it needs Node and the frontend's node_modules, so it is a
deliberate step when either parser is touched rather than a per-commit cost.

    cd frontend && npm install          # once, for esbuild
    cd ../backend/tools/plan_parse_diff
    node reference.mjs corpus.json > reference.json
    cd ../.. && python tools/plan_parse_diff/compare.py

Exits non-zero if anything diverges. Add a sample to corpus.json whenever a model is
seen emitting a shape this does not already cover — that is what the corpus is for.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("JWT_SECRET_KEY", "tools-only-secret")

from app.assistant.plan_parse import parse_plan  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def _canonical(plan):
    """A plan as the wire sees it.

    Key order is not part of the contract — both sides serialise to JSON and every
    consumer reads by key — so sort keys before comparing. Everything else, including
    which optional keys are present at all, is compared exactly.
    """
    return json.dumps(plan, sort_keys=True, ensure_ascii=False)


def main() -> int:
    corpus = json.load(open(os.path.join(HERE, "corpus.json"), encoding="utf-8"))
    reference_path = os.path.join(HERE, "reference.json")
    if not os.path.exists(reference_path):
        print("reference.json missing — run `node reference.mjs corpus.json > reference.json` first")
        return 2
    reference = json.load(open(reference_path, encoding="utf-8"))

    if len(reference) != len(corpus):
        print(f"reference.json has {len(reference)} entries for {len(corpus)} samples — regenerate it")
        return 2

    diverged = 0
    for sample, expected in zip(corpus, reference):
        ours = _canonical(parse_plan(sample["raw"]))
        theirs = _canonical(expected)
        if ours != theirs:
            diverged += 1
            print("=" * 78)
            print("SAMPLE     :", sample["name"])
            print("WHY        :", sample["why"])
            print("INPUT      :", json.dumps(sample["raw"], ensure_ascii=False)[:400])
            print("TYPESCRIPT :", theirs[:800])
            print("PYTHON     :", ours[:800])

    print("=" * 78)
    print(f"{len(corpus) - diverged}/{len(corpus)} samples parse identically")
    return 1 if diverged else 0


if __name__ == "__main__":
    raise SystemExit(main())
