"""Fidelity tests for Markdown -> BlockNote conversion.

These matter more than most: the converter's failure mode is silent. A block shape
that drifts from what BlockNote expects doesn't raise, it produces a note that
renders wrong — so the assertions here are the only thing standing between a
generated essay and a mangled one.

The round-trip tests at the bottom are the load-bearing ones. They read the
converter's output back with the readers that already ship (`segmenter._inline_text`,
`segmenter._table_text`, `notes.extract_full_text`), which pins writer and reader
together: if either side's idea of the shape moves, a test fails here rather than a
video render going silent or a word count reading zero.
"""

import re

import pytest

from app.blocks.markdown_blocks import markdown_to_blocks
from app.routers.notes import extract_full_text
from app.video.segmenter import _inline_text, _table_text


# ─── helpers ─────────────────────────────────────────────────────────────────


def only(md: str) -> dict:
    """The single block `md` converts to."""
    blocks = markdown_to_blocks(md)
    assert len(blocks) == 1, f"expected one block, got {[b['type'] for b in blocks]}"
    return blocks[0]


def text_of(block: dict) -> str:
    return _inline_text(block.get("content"))


def styles_in(block: dict) -> list:
    return [item.get("styles") for item in block["content"] if item.get("type") == "text"]


def norm(s: str) -> str:
    """Collapse whitespace — round-trip asserts text survives, not its spacing."""
    return re.sub(r"\s+", " ", s).strip()


# ─── block envelope ──────────────────────────────────────────────────────────


def test_every_block_carries_an_id_type_props_and_children():
    for block in markdown_to_blocks("# Title\n\nBody text.\n\n- one\n- two"):
        assert isinstance(block["id"], str) and block["id"]
        assert isinstance(block["type"], str) and block["type"]
        assert isinstance(block["props"], dict)
        assert isinstance(block["children"], list)


def test_block_ids_are_unique():
    blocks = markdown_to_blocks("# A\n\n# B\n\n# C\n\npara\n\n- x\n- y")
    ids = [b["id"] for b in blocks]
    assert len(ids) == len(set(ids))


# ─── headings ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("hashes,level", [("#", 1), ("##", 2), ("###", 3)])
def test_atx_headings_carry_their_level(hashes, level):
    block = only(f"{hashes} Chapter One")
    assert block["type"] == "heading"
    assert block["props"]["level"] == level
    assert text_of(block) == "Chapter One"


@pytest.mark.parametrize("hashes,level", [("####", 4), ("#####", 5), ("######", 6)])
def test_headings_go_all_the_way_to_level_six(hashes, level):
    # Checked against ServerBlockNoteEditor 0.49, which accepts 1-6. Clamping these
    # to 3 would silently promote sub-headings and break section matching later.
    block = only(f"{hashes} Deep")
    assert block["props"]["level"] == level
    assert text_of(block) == "Deep"


def test_closed_atx_heading_drops_the_trailing_hashes():
    assert text_of(only("## Chapter Two ##")) == "Chapter Two"


def test_a_hash_without_a_space_is_not_a_heading():
    assert only("#hashtag")["type"] == "paragraph"


# ─── paragraphs ──────────────────────────────────────────────────────────────


def test_a_plain_line_becomes_a_paragraph():
    block = only("Just some prose.")
    assert block["type"] == "paragraph"
    assert block["content"] == [{"type": "text", "text": "Just some prose.", "styles": {}}]


def test_soft_wrapped_lines_join_into_one_paragraph():
    block = only("One line\nand its continuation.")
    assert block["type"] == "paragraph"
    assert text_of(block) == "One line and its continuation."


def test_a_blank_line_starts_a_new_paragraph():
    blocks = markdown_to_blocks("First.\n\nSecond.")
    assert [b["type"] for b in blocks] == ["paragraph", "paragraph"]
    assert [text_of(b) for b in blocks] == ["First.", "Second."]


# ─── inline marks ────────────────────────────────────────────────────────────


def test_bold():
    assert styles_in(only("**loud**")) == [{"bold": True}]


def test_italic_with_asterisks_and_underscores():
    assert styles_in(only("*soft*")) == [{"italic": True}]
    assert styles_in(only("_soft_")) == [{"italic": True}]


def test_strikethrough():
    assert styles_in(only("~~gone~~")) == [{"strike": True}]


def test_inline_code():
    block = only("call `run()` now")
    assert [(i["text"], i["styles"]) for i in block["content"]] == [
        ("call ", {}),
        ("run()", {"code": True}),
        (" now", {}),
    ]


def test_triple_asterisks_are_bold_and_italic():
    assert styles_in(only("***both***")) == [{"bold": True, "italic": True}]


def test_marks_nest():
    block = only("**bold with *italic* inside**")
    assert [(i["text"], i["styles"]) for i in block["content"]] == [
        ("bold with ", {"bold": True}),
        ("italic", {"bold": True, "italic": True}),
        (" inside", {"bold": True}),
    ]


def test_code_spans_do_not_process_markup_inside_them():
    block = only("`**not bold**`")
    assert [(i["text"], i["styles"]) for i in block["content"]] == [
        ("**not bold**", {"code": True}),
    ]


def test_escaped_delimiters_stay_literal():
    block = only(r"\*not italic\*")
    assert [(i["text"], i["styles"]) for i in block["content"]] == [("*not italic*", {})]


def test_an_unmatched_asterisk_stays_literal():
    assert text_of(only("2 * 3 = 6")) == "2 * 3 = 6"


def test_underscores_inside_a_word_do_not_italicise():
    # Technical notes are full of snake_case; GFM's word-boundary rule matters here.
    assert [(i["text"], i["styles"]) for i in only("use snake_case_names here")["content"]] == [
        ("use snake_case_names here", {})
    ]


# ─── links ───────────────────────────────────────────────────────────────────


def test_a_link_becomes_a_link_node():
    block = only("see [the docs](https://example.com/x) here")
    link = block["content"][1]
    assert link["type"] == "link"
    assert link["href"] == "https://example.com/x"
    assert _inline_text(link["content"]) == "the docs"


def test_a_link_label_keeps_its_marks():
    link = only("[**bold link**](https://example.com)")["content"][0]
    assert link["content"][0]["styles"] == {"bold": True}


def test_a_link_title_is_ignored_but_does_not_break_parsing():
    link = only('[label](https://example.com "a title")')["content"][0]
    assert link["href"] == "https://example.com"
    assert _inline_text(link["content"]) == "label"


def test_an_angle_bracketed_destination_is_unwrapped():
    assert only("[x](<https://example.com/a b>)")["content"][0]["href"] == "https://example.com/a b"


# ─── lists ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("marker", ["-", "*", "+"])
def test_bullet_lists(marker):
    blocks = markdown_to_blocks(f"{marker} alpha\n{marker} beta")
    assert [b["type"] for b in blocks] == ["bulletListItem", "bulletListItem"]
    assert [text_of(b) for b in blocks] == ["alpha", "beta"]


def test_numbered_lists():
    blocks = markdown_to_blocks("1. first\n2. second")
    assert [b["type"] for b in blocks] == ["numberedListItem", "numberedListItem"]
    assert [text_of(b) for b in blocks] == ["first", "second"]


def test_task_lists_become_check_list_items_with_their_state():
    blocks = markdown_to_blocks("- [ ] todo\n- [x] done")
    assert [b["type"] for b in blocks] == ["checkListItem", "checkListItem"]
    assert [b["props"]["checked"] for b in blocks] == [False, True]
    assert [text_of(b) for b in blocks] == ["todo", "done"]


def test_nested_list_items_become_children():
    blocks = markdown_to_blocks("- outer\n  - inner\n- second")
    assert len(blocks) == 2
    assert text_of(blocks[0]) == "outer"
    assert len(blocks[0]["children"]) == 1
    assert text_of(blocks[0]["children"][0]) == "inner"
    assert text_of(blocks[1]) == "second"


def test_list_items_keep_their_inline_marks():
    assert styles_in(markdown_to_blocks("- **bold** item")[0])[0] == {"bold": True}


# ─── code blocks ─────────────────────────────────────────────────────────────


def test_fenced_code_with_a_language():
    block = only("```python\nprint('hi')\n```")
    assert block["type"] == "codeBlock"
    assert block["props"]["language"] == "python"
    assert text_of(block) == "print('hi')"


def test_fenced_code_without_a_language_defaults_to_text():
    # What BlockNote's own parser sets for an unlabelled fence.
    block = only("```\nplain\n```")
    assert block["type"] == "codeBlock"
    assert block["props"]["language"] == "text"


def test_fenced_code_preserves_blank_lines_and_indentation():
    block = only("```\ndef f():\n\n    return 1\n```")
    assert text_of(block) == "def f():\n\n    return 1"


def test_tilde_fences_work_too():
    assert only("~~~js\nlet a = 1\n~~~")["props"]["language"] == "js"


# ─── quotes ──────────────────────────────────────────────────────────────────


def test_blockquote():
    block = only("> a remembered thing")
    assert block["type"] == "quote"
    assert text_of(block) == "a remembered thing"


def test_a_multi_line_blockquote_is_one_quote_block():
    assert text_of(only("> one\n> two")) == "one two"


# ─── tables ──────────────────────────────────────────────────────────────────


def test_table_shape_matches_what_the_segmenter_reads():
    block = only("| Name | Role |\n| --- | --- |\n| Ada | Engineer |")
    assert block["type"] == "table"
    content = block["content"]
    assert content["type"] == "tableContent"
    assert content["headerRows"] == 1
    assert len(content["columnWidths"]) == 2
    rows = content["rows"]
    assert len(rows) == 2
    assert [_inline_text(c["content"]) for c in rows[0]["cells"]] == ["Name", "Role"]
    assert [_inline_text(c["content"]) for c in rows[1]["cells"]] == ["Ada", "Engineer"]


def test_table_cells_keep_their_inline_marks():
    block = only("| a |\n| --- |\n| **bold** |")
    cell = block["content"]["rows"][1]["cells"][0]
    assert cell["content"][0]["styles"] == {"bold": True}


def test_a_pipe_line_without_a_separator_row_is_not_a_table():
    assert only("a | b | c")["type"] == "paragraph"


# ─── images ──────────────────────────────────────────────────────────────────


def test_an_image_on_its_own_line_becomes_an_image_block():
    block = only("![a gecko](/media/u1/g.png)")
    assert block["type"] == "image"
    assert block["props"]["url"] == "/media/u1/g.png"
    # Alt text goes to `name`, matching BlockNote's parser; `caption` stays the
    # user's to write.
    assert block["props"]["name"] == "a gecko"
    assert block["props"]["caption"] == ""


def test_an_image_inside_a_sentence_is_dropped_exactly_as_blocknote_drops_it():
    # `image` is a block, so there is no inline form. Matching BlockNote here matters
    # more than salvaging the alt text: the same Markdown must produce the same note
    # whether the browser or the worker converted it.
    block = only("before ![alt](/x.png) after")
    assert block["type"] == "paragraph"
    assert "alt" not in text_of(block)


# ─── thematic breaks ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("rule", ["---", "***", "___", "- - -"])
def test_a_thematic_break_becomes_a_divider_block(rule):
    # `divider` is in BlockNote's defaultBlockSpecs, so the rule survives the trip.
    blocks = markdown_to_blocks(f"above\n\n{rule}\n\nbelow")
    assert [b["type"] for b in blocks] == ["paragraph", "divider", "paragraph"]
    assert [text_of(b) for b in (blocks[0], blocks[2])] == ["above", "below"]


# ─── fallback ────────────────────────────────────────────────────────────────


def test_empty_input_yields_one_empty_paragraph_not_an_empty_document():
    # Mirrors mdToBlocks in planExecutor.ts: never hand back an empty document.
    blocks = markdown_to_blocks("")
    assert len(blocks) == 1
    assert blocks[0]["type"] == "paragraph"
    assert text_of(blocks[0]) == ""


def test_whitespace_only_input_keeps_the_raw_text_in_a_paragraph():
    blocks = markdown_to_blocks("   ")
    assert len(blocks) == 1
    assert blocks[0]["type"] == "paragraph"
    assert blocks[0]["content"][0]["text"] == "   "


def test_none_is_treated_as_empty():
    assert markdown_to_blocks(None)[0]["type"] == "paragraph"


def test_windows_line_endings_are_handled():
    blocks = markdown_to_blocks("# Title\r\n\r\nBody.")
    assert [b["type"] for b in blocks] == ["heading", "paragraph"]
    assert text_of(blocks[1]) == "Body."


# ─── round-trip against the readers that already ship ────────────────────────

CORPUS = [
    "# Title\n\nA paragraph with **bold**, *italic* and `code`.",
    "Intro line.\n\n- one\n- two\n  - nested\n\nOutro line.",
    "## Section\n\n> A quotation worth keeping.\n\n1. first\n2. second",
    "Text with [a link](https://example.com/page) inside it.",
    "- [ ] unchecked\n- [x] checked",
    "### Deep heading\n\nTrailing prose after it.",
]


@pytest.mark.parametrize("md", CORPUS)
def test_segmenter_can_read_back_every_word_the_converter_wrote(md):
    """The video renderer narrates notes through `_inline_text`. Anything it cannot
    read is a section that renders silent."""
    blocks = markdown_to_blocks(md)
    recovered = " ".join(_inline_text(b.get("content")) for b in _flatten(blocks))
    for word in _words(md):
        assert word in recovered


# `extract_full_text` reads only `type == "text"` nodes, so link labels never reach
# it — a pre-existing limitation of that reader, called out in segmenter.py's
# `_inline_text` docstring ("fine for a word count, wrong for narration"). The
# corpus for it therefore excludes links, and the drop is pinned by its own test
# below so a later fix to the reader shows up as a failure here rather than silently.
CORPUS_WITHOUT_LINKS = [md for md in CORPUS if "](" not in md]


@pytest.mark.parametrize("md", CORPUS_WITHOUT_LINKS)
def test_note_word_count_sees_the_converted_text(md):
    """`extract_full_text` backs note metrics and search previews."""
    import json

    recovered = extract_full_text(json.dumps(markdown_to_blocks(md)))
    for word in _words(md):
        assert word in recovered


def test_extract_full_text_drops_link_labels_which_is_the_readers_behaviour_not_ours():
    import json

    blocks = markdown_to_blocks("Prose around [a labelled link](https://example.com).")
    # The converter emitted the label — the segmenter, which descends into links, sees it.
    assert "a labelled link" in _inline_text(blocks[0]["content"])
    # extract_full_text does not descend, so the label is absent from its output.
    assert "labelled" not in extract_full_text(json.dumps(blocks))


def test_table_text_reads_back_a_converted_table():
    block = only("| Name | Role |\n| --- | --- |\n| Ada | Engineer |")
    assert _table_text(block) == "Name, Role\nAda, Engineer"


def test_a_full_document_round_trips_its_prose():
    md = (
        "# Report\n\n"
        "Opening paragraph with **emphasis**.\n\n"
        "## Findings\n\n"
        "- first finding\n"
        "- second finding\n\n"
        "| Metric | Value |\n| --- | --- |\n| Latency | 42ms |\n\n"
        "> A closing thought.\n"
    )
    blocks = markdown_to_blocks(md)
    types = [b["type"] for b in blocks]
    assert types == [
        "heading", "paragraph", "heading",
        "bulletListItem", "bulletListItem",
        "table", "quote",
    ]
    prose = " ".join(
        _table_text(b) if b["type"] == "table" else _inline_text(b.get("content"))
        for b in blocks
    )
    for word in ["Report", "emphasis", "Findings", "finding", "Latency", "42ms", "closing"]:
        assert word in prose


# ─── local helpers ───────────────────────────────────────────────────────────


def _flatten(blocks):
    for block in blocks:
        yield block
        yield from _flatten(block.get("children") or [])


def _words(md: str):
    """Words that must survive conversion — markup characters stripped."""
    stripped = re.sub(r"[#*_`>\[\]()|~-]|\d+\.", " ", md)
    return [w for w in norm(stripped).split(" ") if len(w) > 2 and "http" not in w]
