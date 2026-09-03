"""Note bodies back out as Markdown.

A worker that discovers notes mid-turn has to put their bodies in front of the model,
and the model targets sections by heading — so what matters is that the structure
survives, not that the output matches BlockNote's serializer byte for byte (it
deliberately doesn't; see the module docstring).

Round-tripping is therefore the real test, and `tools/blocknote_diff/corpus.json` is
already a corpus of Markdown the assistant actually emits, so it does double duty here:
every sample goes Markdown → blocks → Markdown → blocks, and the two block trees must
match. That catches a dropped heading level or a mangled list far more reliably than
asserting on strings.
"""

import json
import os

import pytest

from app.blocks import blocks_to_markdown, markdown_to_blocks, note_to_markdown


def strip_ids(blocks):
    """Block ids are freshly generated on every parse, so they are never comparable."""
    out = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        node = {
            "type": block.get("type"),
            "props": block.get("props") or {},
            "children": strip_ids(block.get("children") or []),
        }
        if "content" in block:
            node["content"] = block["content"]
        out.append(node)
    return out


def round_trip(markdown):
    """(blocks from the original, blocks from our re-rendered Markdown)."""
    blocks = markdown_to_blocks(markdown)
    return strip_ids(blocks), strip_ids(markdown_to_blocks(blocks_to_markdown(blocks)))


# ─── the corpus, round-tripped ───────────────────────────────────────────────


def _corpus():
    path = os.path.join(
        os.path.dirname(__file__), "..", "tools", "blocknote_diff", "corpus.json"
    )
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


@pytest.mark.parametrize("markdown", _corpus())
def test_every_corpus_sample_survives_a_round_trip(markdown):
    before, after = round_trip(markdown)
    assert before == after


# ─── the structures that carry meaning ───────────────────────────────────────


def test_heading_levels_survive():
    # edit_section finds its target by heading, so a level lost here is a section the
    # model can no longer address.
    out = blocks_to_markdown(markdown_to_blocks("# One\n\n## Two\n\n### Three"))
    assert out.splitlines() == ["# One", "", "## Two", "", "### Three"]


def test_nested_lists_keep_their_depth():
    before, after = round_trip("- one\n- two\n  - nested\n    - deeper")
    assert before == after


def test_a_bulleted_list_does_not_run_into_a_numbered_one():
    # With no blank line between them most parsers read one list, not two.
    out = blocks_to_markdown(markdown_to_blocks("- a\n- b\n\n1. x\n2. y"))
    assert "- b\n\n1. x" in out


def test_a_numbered_run_restarts_after_something_else():
    out = blocks_to_markdown(markdown_to_blocks("1. a\n2. b\n\ntext\n\n1. c\n2. d"))
    assert out.count("1. ") == 2


def test_check_list_state_survives():
    before, after = round_trip("- [ ] todo\n- [x] done")
    assert before == after
    assert "- [x] done" in blocks_to_markdown(markdown_to_blocks("- [x] done"))


def test_inline_marks_survive():
    before, after = round_trip("Some **bold**, *italic*, `code` and ~~struck~~ text.")
    assert before == after


def test_a_link_keeps_its_href():
    out = blocks_to_markdown(markdown_to_blocks("See [the docs](https://example.dev/a)."))
    assert "[the docs](https://example.dev/a)" in out


def test_marks_wrap_the_words_not_the_spaces():
    # "** bold **" is not bold to most parsers, so a mark that swallowed its
    # surrounding whitespace would round-trip as plain text.
    blocks = [{
        "type": "paragraph",
        "props": {},
        "content": [{"type": "text", "text": " bold ", "styles": {"bold": True}}],
    }]
    assert blocks_to_markdown(blocks).strip() == "**bold**"


def test_a_code_block_keeps_its_language_and_literal_text():
    out = blocks_to_markdown(markdown_to_blocks("```python\nx = a * b * c\n```"))
    assert "```python" in out
    # Inside a fence a `*` is a `*` — it must not come back marked up.
    assert "x = a * b * c" in out


def test_tables_survive():
    before, after = round_trip("| a | b |\n| --- | --- |\n| 1 | 2 |")
    assert before == after


def test_a_pipe_inside_a_cell_is_escaped():
    blocks = [{
        "type": "table",
        "props": {},
        "content": {
            "type": "tableContent",
            "rows": [{"cells": [{"type": "tableCell", "content": [
                {"type": "text", "text": "a|b", "styles": {}}
            ]}]}],
        },
    }]
    assert "a\\|b" in blocks_to_markdown(blocks)


def test_images_keep_their_alt_and_url():
    out = blocks_to_markdown(markdown_to_blocks("![alt text](https://x.dev/i.png)"))
    assert out.strip() == "![alt text](https://x.dev/i.png)"


# ─── what Markdown cannot express ────────────────────────────────────────────


def test_a_diagram_is_named_rather_than_dropped():
    # Dropping it is how you get a plan that "rewrites" a section and silently
    # deletes the diagram sitting in it.
    blocks = [{
        "type": "diagram",
        "props": {"diagramId": "dg-123", "source": "graph TD;A-->B"},
        "children": [],
    }]
    out = blocks_to_markdown(blocks)
    assert "dg-123" in out
    assert "graph TD;A-->B" in out


def test_a_child_note_and_a_reference_carry_their_ids():
    blocks = [
        {"type": "childNote", "props": {"childNoteId": "n1", "title": "Chapter"}, "children": []},
        {"type": "noteReference", "props": {"noteId": "n2", "noteTitle": "Sources"}, "children": []},
    ]
    out = blocks_to_markdown(blocks)
    assert "Chapter" in out and "n1" in out
    assert "Sources" in out and "n2" in out


# ─── not falling over ────────────────────────────────────────────────────────


def test_empty_paragraphs_are_dropped_rather_than_padding_the_prompt():
    blocks = markdown_to_blocks("one") + [
        {"type": "paragraph", "props": {}, "content": [], "children": []}
    ] + markdown_to_blocks("two")
    assert blocks_to_markdown(blocks).strip() == "one\n\ntwo"


@pytest.mark.parametrize("value", ["", "[]", "not json", None, 42, {}])
def test_a_malformed_body_never_takes_a_turn_down(value):
    assert isinstance(note_to_markdown(value), str)


def test_the_stored_json_string_is_accepted_directly():
    stored = json.dumps(markdown_to_blocks("# Hi\n\nthere"))
    assert blocks_to_markdown(stored).strip() == "# Hi\n\nthere"


def test_an_unknown_block_type_still_shows_its_text():
    blocks = [{
        "type": "somethingNew",
        "props": {},
        "content": [{"type": "text", "text": "still readable", "styles": {}}],
        "children": [],
    }]
    assert "still readable" in blocks_to_markdown(blocks)


# ─── marks and escaping ──────────────────────────────────────────────────────


def test_nested_marks_group_instead_of_wrapping_each_run():
    # BlockNote's own serializer wraps every run separately and patches the seams with
    # &#x20; entities, turning this into `**bold with&#x20;*****italic*****&#x20;
    # inside**`. Re-readable, but not something you would want to read.
    out = blocks_to_markdown(markdown_to_blocks("**bold with *italic* inside**"))
    assert out.strip() == "**bold with *italic* inside**"


def test_a_literal_marker_is_escaped_so_it_stays_literal():
    before, after = round_trip(r"\*not italic\* and a \`tick\`")
    assert before == after


def test_escaping_leaves_ordinary_prose_alone():
    # The parser is conservative about all three of these, so backslashing them would
    # be noise in the prompt rather than fidelity.
    for text in ["snake_case_name", "~/notes/today", "see [sic] there", "5 * 3"]:
        blocks = [{
            "type": "paragraph", "props": {},
            "content": [{"type": "text", "text": text, "styles": {}}],
        }]
        rendered = blocks_to_markdown(blocks).strip()
        assert "\\" not in rendered or text == "5 * 3", rendered


def test_a_marker_inside_a_code_span_is_not_escaped():
    # Backticks already make everything literal; a backslash added in there is a
    # backslash the reader sees.
    before, after = round_trip("`**not bold**`")
    assert before == after
    assert blocks_to_markdown(markdown_to_blocks("`**not bold**`")).strip() == "`**not bold**`"
