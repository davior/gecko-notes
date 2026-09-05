"""Diff `app.assistant.plan_parse` against the TypeScript `parsePlan` it was ported from.

`tests/test_plan_parse.py` pins what we *believe* the parser does. This pins what the
original actually does, which is the only thing that matters: the browser and the
worker now both turn a model reply into a plan, and a disagreement between them is a
plan that gets approved in the review modal and then executed as something else.

It covers the whole ported surface, not just the parse. `plan_prompt.py` carries the
labels and the two turns that ask for a deferred body, and those go into a prompt — a
drift there is a body written to the wrong brief, which nothing downstream would flag.

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
from app.assistant.plan_prompt import (  # noqa: E402
    action_needs_generation,
    build_content_step_instruction,
    build_plan_summary,
    default_action_label,
)

HERE = os.path.dirname(os.path.abspath(__file__))

# Mirrors LABELS in reference.mjs. Ids absent from it must render as the bare id.
LABELS = {
    "n1": "First note",
    "n2": "Second note",
    "n3": "Third note",
    "f1": "Research",
    "c1": "Ideas",
    "r1": "Summarise",
}


def _ours(raw):
    """Everything the port produces for one sample, in reference.mjs's shape."""
    plan = parse_plan(raw)
    actions = plan.get("actions") or []
    return {
        "plan": plan,
        "labels": [default_action_label(a, LABELS) for a in actions],
        "summary": build_plan_summary(plan),
        "steps": [
            build_content_step_instruction(a, i, LABELS)
            for i, a in enumerate(actions)
            if action_needs_generation(a)
        ],
    }


def _canonical(value):
    """As the wire sees it.

    Key order is not part of the contract — both sides serialise to JSON and every
    consumer reads by key — so sort keys before comparing. Everything else, including
    which optional keys are present at all, is compared exactly.
    """
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


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
        ours_all = _ours(sample["raw"])
        if _canonical(ours_all) == _canonical(expected):
            continue
        diverged += 1
        print("=" * 78)
        print("SAMPLE     :", sample["name"])
        print("WHY        :", sample["why"])
        print("INPUT      :", json.dumps(sample["raw"], ensure_ascii=False)[:400])
        # Report the first field that differs rather than two walls of JSON.
        for field in ("plan", "labels", "summary", "steps"):
            ours = _canonical(ours_all.get(field))
            theirs = _canonical(expected.get(field))
            if ours != theirs:
                print(f"FIELD      : {field}")
                print("TYPESCRIPT :", theirs[:900])
                print("PYTHON     :", ours[:900])

    print("=" * 78)
    print(f"{len(corpus) - diverged}/{len(corpus)} samples agree on plan, labels and prompts")
    return 1 if diverged else 0


if __name__ == "__main__":
    raise SystemExit(main())
