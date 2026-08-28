"""Segmentation tests: BlockNote document in, shot list out.

Pure functions only — no database, no network, no ffmpeg, matching the style of
test_import_url.py. Video audio detection is injected rather than probed.
"""

import json
import os
import tempfile

from app.video.options import RenderOptions
from app.video.segmenter import resolve_media_path, segment


def _media(*names):
    """A media dir containing `names` for user 'u1', as real (empty) files."""
    root = tempfile.mkdtemp()
    os.makedirs(os.path.join(root, "u1"), exist_ok=True)
    for name in names:
        with open(os.path.join(root, "u1", name), "wb") as f:
            f.write(b"x")
    return root


def _text(value):
    return [{"type": "text", "text": value}]


def _run(blocks, *, media_root, options=None, loud=(), title="", author=""):
    return segment(
        json.dumps(blocks),
        user_id="u1",
        media_dir=media_root,
        options=options or RenderOptions(title_card=False),
        note_title=title,
        author=author,
        has_audio=lambda path: os.path.basename(path) in loud,
    )


def test_text_before_any_media_gets_its_own_fallback_shot():
    root = _media("a.png")
    plan = _run([
        {"id": "1", "type": "paragraph", "content": _text("Opening words.")},
        {"id": "2", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "3", "type": "paragraph", "content": _text("Under the picture.")},
    ], media_root=root)

    assert [s.kind for s in plan.shots] == ["still", "still"]
    assert plan.shots[0].background is None
    assert plan.shots[0].narration == "Opening words."
    assert plan.shots[1].background.endswith("a.png")
    assert plan.shots[1].narration == "Under the picture."


def test_silent_video_becomes_one_looping_shot():
    root = _media("clip.mp4")
    plan = _run([
        {"id": "1", "type": "videoFile", "props": {"url": "/media/u1/clip.mp4"}},
        {"id": "2", "type": "paragraph", "content": _text("Spoken over the clip.")},
    ], media_root=root)

    assert [s.kind for s in plan.shots] == ["video_muted"]
    assert plan.shots[0].narration == "Spoken over the clip."


def test_video_with_audio_splits_into_the_clip_then_a_muted_continuation():
    root = _media("loud.mp4")
    plan = _run([
        {"id": "1", "type": "videoFile", "props": {"url": "/media/u1/loud.mp4"}},
        {"id": "2", "type": "paragraph", "content": _text("Read after the clip.")},
    ], media_root=root, loud={"loud.mp4"})

    assert [s.kind for s in plan.shots] == ["video_sound", "video_muted"]
    # The clip plays with its own audio and the narration waits for it...
    assert plan.shots[0].narration == ""
    # ...then the text runs over the same clip, looped silently.
    assert plan.shots[1].narration == "Read after the clip."
    assert plan.shots[0].background == plan.shots[1].background


# ── BlockNote's own "video" block, not just this app's "videoFile" one ──────
#
# Confirmed as a real bug: a plain drag-and-drop or paste of an .mp4 produces
# BlockNote's *built-in* "video" block (same `props.url` shape as "image"),
# which `_classify` didn't recognise at all — not skipped with a warning, just
# invisible, so the clip silently never made it into the render. "videoFile"
# is only ever inserted by this app's own code: the camera recorder, and a
# finished article-to-video render being attached back to its note.

def test_a_plain_dropped_or_pasted_video_is_not_skipped():
    root = _media("clip.mp4")
    plan = _run([
        {"id": "1", "type": "video", "props": {"url": "/media/u1/clip.mp4"}},
        {"id": "2", "type": "paragraph", "content": _text("Spoken over the clip.")},
    ], media_root=root)

    assert [s.kind for s in plan.shots] == ["video_muted"]
    assert plan.shots[0].background.endswith("clip.mp4")
    assert plan.shots[0].narration == "Spoken over the clip."
    assert plan.warnings == []


def test_a_sounded_native_video_block_splits_the_same_way_videofile_does():
    root = _media("loud.mp4")
    plan = _run([
        {"id": "1", "type": "video", "props": {"url": "/media/u1/loud.mp4"}},
        {"id": "2", "type": "paragraph", "content": _text("Read after the clip.")},
    ], media_root=root, loud={"loud.mp4"})

    assert [s.kind for s in plan.shots] == ["video_sound", "video_muted"]
    assert plan.shots[1].narration == "Read after the clip."
    assert plan.shots[0].background == plan.shots[1].background


def test_a_native_video_block_with_no_url_yet_is_simply_not_media():
    """A block mid-upload, or otherwise props-less, must not crash the segmenter
    or be mistaken for a boundary it doesn't have a source for yet."""
    root = _media()
    plan = _run([
        {"id": "1", "type": "video", "props": {}},
        {"id": "2", "type": "paragraph", "content": _text("Text.")},
    ], media_root=root)

    assert [s.kind for s in plan.shots] == ["still"]
    assert plan.shots[0].narration == "Text."


def test_headings_become_chapter_marks_and_are_still_narrated():
    root = _media("a.png")
    plan = _run([
        {"id": "1", "type": "heading", "props": {"level": 1}, "content": _text("Chapter One")},
        {"id": "2", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "3", "type": "paragraph", "content": _text("Body.")},
    ], media_root=root)

    assert plan.shots[0].chapter == "Chapter One"
    # A heading has no terminal punctuation of its own; without one the voice
    # reads straight on into the next sentence.
    assert plan.shots[0].narration == "Chapter One."


def _with_chapter_screens():
    return RenderOptions(title_card=False, chapter_screens=True)


CHAPTERED_DOC = [
    {"id": "1", "type": "image", "props": {"url": "/media/u1/a.png"}},
    {"id": "2", "type": "paragraph", "content": _text("First section.")},
    {"id": "3", "type": "heading", "props": {"level": 2}, "content": _text("Next Up")},
    {"id": "4", "type": "paragraph", "content": _text("Second section.")},
]


def test_chapter_screens_insert_a_card_between_sections():
    root = _media("a.png")
    plan = _run(CHAPTERED_DOC, media_root=root, options=_with_chapter_screens())

    assert "card" in [s.kind for s in plan.shots]
    card = next(s for s in plan.shots if s.kind == "card")
    assert card.card_title == "Next Up"


def test_a_chapter_screen_reads_its_own_heading():
    """Otherwise the heading is shown in silence and then spoken over the next
    shot, once the words are no longer on screen."""
    root = _media("a.png")
    plan = _run(CHAPTERED_DOC, media_root=root, options=_with_chapter_screens())

    card = next(s for s in plan.shots if s.kind == "card")
    assert card.narration == "Next Up."


def test_a_chapter_screens_heading_is_not_read_again_in_the_next_section():
    root = _media("a.png")
    plan = _run(CHAPTERED_DOC, media_root=root, options=_with_chapter_screens())

    after = plan.shots[plan.shots.index(next(s for s in plan.shots if s.kind == "card")) + 1]
    assert after.narration == "Second section."


def test_a_chapter_screen_does_not_duplicate_its_chapter_mark():
    root = _media("a.png")
    plan = _run(CHAPTERED_DOC, media_root=root, options=_with_chapter_screens())

    marks = [s.chapter for s in plan.shots if s.chapter]
    assert marks == ["Next Up"]


def test_a_chapter_mark_never_labels_the_section_above_it():
    root = _media("a.png", "b.png")
    plan = _run([
        {"id": "1", "type": "heading", "props": {"level": 1}, "content": _text("One")},
        {"id": "2", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "3", "type": "paragraph", "content": _text("First section.")},
        {"id": "4", "type": "heading", "props": {"level": 2}, "content": _text("Two")},
        {"id": "5", "type": "image", "props": {"url": "/media/u1/b.png"}},
        {"id": "6", "type": "paragraph", "content": _text("Second section.")},
    ], media_root=root, options=_with_chapter_screens())

    # The body of chapter one must not be tagged with chapter two.
    first_body = next(s for s in plan.shots if s.narration == "First section.")
    assert first_body.chapter is None
    assert [s.chapter for s in plan.shots if s.chapter] == ["One", "Two"]


def test_without_chapter_screens_the_heading_stays_in_its_section():
    root = _media("a.png")
    plan = _run(CHAPTERED_DOC, media_root=root,
                options=RenderOptions(title_card=False, chapter_screens=False))

    assert all(s.kind != "card" for s in plan.shots)
    spoken = " ".join(s.narration for s in plan.shots)
    assert "Next Up." in spoken
    assert [s.chapter for s in plan.shots if s.chapter] == ["Next Up"]


def test_cards_declare_which_kind_they_are():
    """Title and chapter screens are sized independently, so the renderer has to
    be able to tell them apart."""
    root = _media("a.png")
    plan = _run([
        {"id": "1", "type": "heading", "props": {"level": 1}, "content": _text("A Section")},
        {"id": "2", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "3", "type": "paragraph", "content": _text("Body.")},
    ], media_root=root,
       options=RenderOptions(title_card=True, chapter_screens=True),
       title="The Note", author="gecko")

    kinds = [s.card_kind for s in plan.shots if s.kind == "card"]
    assert kinds == ["title", "chapter"]


def test_title_card_is_first_when_enabled():
    root = _media()
    plan = _run(
        [{"id": "1", "type": "paragraph", "content": _text("Words.")}],
        media_root=root, options=RenderOptions(title_card=True),
        title="My Article", author="gecko",
    )
    assert plan.shots[0].kind == "card"
    assert plan.shots[0].card_title == "My Article"
    assert plan.shots[0].card_subtitle == "gecko"


def test_navigation_blocks_are_never_narrated():
    root = _media()
    plan = _run([
        {"id": "1", "type": "paragraph", "content": _text("Kept.")},
        {"id": "2", "type": "childNote", "props": {"childNoteId": "x"}},
        {"id": "3", "type": "noteReference", "props": {"noteId": "y"}},
        {"id": "4", "type": "audioFile", "props": {"url": "/media/u1/z.mp3"}},
        {"id": "5", "type": "codeBlock", "content": _text("print('hi')")},
    ], media_root=root)

    assert plan.shots[0].narration == "Kept."


def _code(value):
    return {"type": "codeBlock", "content": _text(value)}


def test_a_code_block_always_gets_its_own_shot_regardless_of_narration():
    """Unlike the old fold-into-the-prose behaviour, a code block is drawn on
    screen unconditionally — narrate_code only ever gates whether it's read."""
    root = _media()
    shots = _run([_para("Before."), _code("print(1)"), _para("After.")],
                 media_root=root).shots
    assert [s.narration for s in shots] == ["Before.", "", "After."]
    assert [s.code_text for s in shots] == [None, "print(1)", None]


def test_a_code_blocks_narration_is_gated_by_narrate_code():
    root = _media()
    blocks = [_para("Before."), _code("print(1)"), _para("After.")]
    off = _run(blocks, media_root=root).shots
    assert off[1].code_text == "print(1)" and off[1].narration == ""

    on = _run(blocks, media_root=root, options=RenderOptions(title_card=False, narrate_code=True)).shots
    assert on[1].code_text == "print(1)" and "print(1)" in on[1].narration


def test_a_code_block_keeps_the_picture_of_the_section_it_interrupts():
    root = _media("photo.png")
    shots = _run([
        {"type": "image", "props": {"url": "/media/u1/photo.png"}},
        _para("Some prose."),
        _code("print(1)"),
        _para("More prose."),
    ], media_root=root).shots
    photo = os.path.join(root, "u1", "photo.png")
    assert [s.background for s in shots] == [photo, photo, photo]
    assert [s.kind for s in shots] == ["still", "still", "still"]


def test_a_code_block_over_a_sounded_clip_carries_it_muted():
    root = _media("clip.mp4")
    shots = _run([
        {"type": "videoFile", "props": {"url": "/media/u1/clip.mp4"}},
        _code("print(1)"),
    ], media_root=root, loud={"clip.mp4"}).shots
    assert [s.kind for s in shots] == ["video_sound", "video_muted"]
    assert shots[1].code_text == "print(1)"


def test_a_code_block_before_any_media_falls_back_like_any_other_opening_text():
    root = _media()
    shots = _run([_code("print(1)")], media_root=root).shots
    assert len(shots) == 1
    assert shots[0].background is None and shots[0].code_text == "print(1)"


def test_consecutive_code_blocks_each_get_their_own_shot():
    root = _media()
    shots = _run([_code("first()"), _code("second()")], media_root=root).shots
    assert [s.code_text for s in shots] == ["first()", "second()"]


def test_an_empty_code_block_is_ignored():
    root = _media()
    shots = _run([_para("Before."), _code("   "), _para("After.")], media_root=root).shots
    assert len(shots) == 1
    assert shots[0].code_text is None


def test_a_code_block_straight_after_an_image_gets_no_blank_shot_in_front_of_it():
    root = _media("photo.png")
    shots = _run([
        {"type": "image", "props": {"url": "/media/u1/photo.png"}},
        _code("print(1)"),
    ], media_root=root).shots
    assert len(shots) == 1
    assert shots[0].code_text == "print(1)"


def test_link_text_is_narrated():
    root = _media()
    plan = _run([{
        "id": "1", "type": "paragraph",
        "content": [
            {"type": "text", "text": "See "},
            {"type": "link", "href": "https://example.com", "content": _text("the docs")},
            {"type": "text", "text": " for more."},
        ],
    }], media_root=root)
    assert plan.shots[0].narration == "See the docs for more."


def test_media_with_no_text_under_it_still_gets_a_shot():
    root = _media("a.png")
    plan = _run([{"id": "1", "type": "image", "props": {"url": "/media/u1/a.png"}}], media_root=root)
    assert [s.kind for s in plan.shots] == ["still"]
    assert plan.shots[0].narration == ""


def test_remote_and_missing_media_fall_back_and_are_reported():
    root = _media()
    plan = _run([
        {"id": "1", "type": "image", "props": {"url": "https://example.com/x.png"}},
        {"id": "2", "type": "paragraph", "content": _text("After the remote image.")},
        {"id": "3", "type": "image", "props": {"url": "/media/u1/gone.png"}},
        {"id": "4", "type": "paragraph", "content": _text("After the missing one.")},
    ], media_root=root)

    assert all(s.background is None for s in plan.shots)
    assert len(plan.warnings) == 2
    assert any("remote" in w for w in plan.warnings)
    assert any("missing" in w for w in plan.warnings)


def test_diagram_is_a_background_only_once_the_client_has_rasterised_it():
    root = _media("d.png")
    blocks = [
        {"id": "diag-1", "type": "diagram", "props": {"source": "graph TD; a-->b"}},
        {"id": "2", "type": "paragraph", "content": _text("About the diagram.")},
    ]
    without = _run(blocks, media_root=root)
    assert without.shots[0].background is None

    withpng = _run(blocks, media_root=root,
                   options=RenderOptions(title_card=False,
                                         diagram_images={"diag-1": "/media/u1/d.png"}))
    assert withpng.shots[0].background.endswith("d.png")


def test_nested_children_are_walked_in_document_order():
    root = _media("a.png")
    plan = _run([{
        "id": "1", "type": "bulletListItem", "content": _text("Parent."),
        "children": [
            {"id": "2", "type": "bulletListItem", "content": _text("Child.")},
            {"id": "3", "type": "image", "props": {"url": "/media/u1/a.png"}},
            {"id": "4", "type": "bulletListItem", "content": _text("After the image.")},
        ],
    }], media_root=root)

    assert plan.shots[0].narration == "Parent.\nChild."
    assert plan.shots[1].background.endswith("a.png")
    assert plan.shots[1].narration == "After the image."


def test_table_cells_are_read_row_by_row():
    root = _media()
    plan = _run([{
        "id": "1", "type": "table",
        "content": {"type": "tableContent", "rows": [
            {"cells": [{"content": _text("Name")}, {"content": _text("Role")}]},
            {"cells": [{"content": _text("Ada")}, {"content": _text("Engineer")}]},
        ]},
    }], media_root=root)
    assert plan.shots[0].narration == "Name, Role\nAda, Engineer."


def test_narration_chars_counts_every_shot():
    root = _media("a.png")
    plan = _run([
        {"id": "1", "type": "paragraph", "content": _text("One.")},
        {"id": "2", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "3", "type": "paragraph", "content": _text("Two.")},
    ], media_root=root)
    assert plan.narration_chars == len("One.") + len("Two.")


def test_malformed_content_yields_no_shots_rather_than_raising():
    root = _media()
    assert _run([], media_root=root).shots == []
    for bad in ("", "not json", "{}", "null"):
        plan = segment(bad, user_id="u1", media_dir=root,
                       options=RenderOptions(title_card=False))
        assert plan.shots == []


# ── path safety ───────────────────────────────────────────────────────────────

def test_resolve_media_path_accepts_only_this_users_own_files():
    root = _media("a.png")
    os.makedirs(os.path.join(root, "u2"), exist_ok=True)
    with open(os.path.join(root, "u2", "other.png"), "wb") as f:
        f.write(b"x")

    assert resolve_media_path("/media/u1/a.png", "u1", root).endswith("a.png")
    # Another user's media, traversal, absolute and remote URLs are all refused.
    assert resolve_media_path("/media/u2/other.png", "u1", root) is None
    assert resolve_media_path("/media/u1/../u2/other.png", "u1", root) is None
    assert resolve_media_path("/media/u1/a.png/../../u2/other.png", "u1", root) is None
    assert resolve_media_path("https://example.com/a.png", "u1", root) is None
    assert resolve_media_path("/etc/passwd", "u1", root) is None
    assert resolve_media_path("/media/u1/nope.png", "u1", root) is None
    assert resolve_media_path("", "u1", root) is None
    assert resolve_media_path(None, "u1", root) is None


# ── on-screen quotes ─────────────────────────────────────────────────────────

def _quotes(**kwargs):
    return RenderOptions(title_card=False, quotes={"enabled": True, **kwargs})


def _para(value):
    return {"type": "paragraph", "content": _text(value)}


def _quote(value):
    return {"type": "quote", "content": _text(value)}


def test_a_quote_is_left_in_the_prose_until_the_option_is_turned_on():
    """Off, this must behave exactly as it did before quotes existed."""
    root = _media()
    shots = _run([_para("Before."), _quote("A quotation."), _para("After.")],
                 media_root=root).shots
    assert len(shots) == 1
    assert shots[0].narration == "Before.\nA quotation.\nAfter."
    assert shots[0].quote_text is None


def test_a_quote_gets_its_own_shot_so_the_words_are_up_while_they_are_read():
    root = _media()
    shots = _run([_para("Before."), _quote("A quotation."), _para("After.")],
                 media_root=root, options=_quotes()).shots
    assert [s.narration for s in shots] == ["Before.", "A quotation.", "After."]
    assert [s.quote_text for s in shots] == [None, "A quotation.", None]


def test_a_quote_keeps_the_picture_of_the_section_it_interrupts():
    """Cutting to a different background for one sentence reads as a mistake."""
    root = _media("photo.png")
    shots = _run([
        {"type": "image", "props": {"url": "/media/u1/photo.png"}},
        _para("Some prose."),
        _quote("A quotation."),
        _para("More prose."),
    ], media_root=root, options=_quotes()).shots
    photo = os.path.join(root, "u1", "photo.png")
    assert [s.background for s in shots] == [photo, photo, photo]
    assert [s.kind for s in shots] == ["still", "still", "still"]


def test_a_quote_over_a_sounded_clip_carries_it_muted():
    """Carrying the shot as-is would replay the clip's own audio under the quote."""
    root = _media("clip.mp4")
    shots = _run([
        {"type": "videoFile", "props": {"url": "/media/u1/clip.mp4"}},
        _quote("A quotation."),
    ], media_root=root, options=_quotes(), loud={"clip.mp4"}).shots
    assert [s.kind for s in shots] == ["video_sound", "video_muted"]
    assert shots[1].quote_text == "A quotation."


def test_a_quote_before_any_media_falls_back_like_any_other_opening_text():
    root = _media()
    shots = _run([_quote("Opening quotation.")], media_root=root, options=_quotes()).shots
    assert len(shots) == 1
    assert shots[0].background is None and shots[0].quote_text == "Opening quotation."


def test_a_trailing_dash_becomes_the_attribution_and_leaves_the_quotation():
    root = _media()
    shots = _run([_quote("The best way out is always through. — Robert Frost")],
                 media_root=root, options=_quotes()).shots
    assert shots[0].quote_text == "The best way out is always through."
    assert shots[0].quote_attribution == "Robert Frost"
    # The attribution is shown, not spoken — reading it aloud sounds like a footnote.
    assert shots[0].narration == "The best way out is always through."


def test_a_mid_sentence_dash_is_punctuation_not_an_attribution():
    root = _media()
    shots = _run([_quote("A thought — interrupted mid-sentence — is still one sentence.")],
                 media_root=root, options=_quotes()).shots
    assert shots[0].quote_attribution is None
    assert shots[0].quote_text.endswith("is still one sentence.")


def test_consecutive_quotes_each_get_their_own_shot():
    root = _media()
    shots = _run([_quote("First."), _quote("Second.")],
                 media_root=root, options=_quotes()).shots
    assert [s.quote_text for s in shots] == ["First.", "Second."]


def test_an_empty_quote_block_is_ignored():
    root = _media()
    shots = _run([_para("Before."), _quote("   "), _para("After.")],
                 media_root=root, options=_quotes()).shots
    assert len(shots) == 1 and shots[0].quote_text is None


def test_a_quote_does_not_steal_the_chapter_mark_of_the_heading_above_it():
    root = _media()
    shots = _run([
        {"type": "heading", "content": _text("A Section")},
        _para("Some prose."),
        _quote("A quotation."),
    ], media_root=root, options=_quotes()).shots
    assert shots[0].chapter == "A Section"
    assert [s.chapter for s in shots[1:]] == [None] * (len(shots) - 1)


def test_a_quote_straight_after_an_image_gets_no_blank_shot_in_front_of_it():
    """The section had nothing of its own to say, so a shot holding the same
    picture in silence for min_shot_seconds would just be dead air."""
    root = _media("photo.png")
    shots = _run([
        {"type": "image", "props": {"url": "/media/u1/photo.png"}},
        _quote("A quotation."),
    ], media_root=root, options=_quotes()).shots
    assert len(shots) == 1
    assert shots[0].quote_text == "A quotation."


def test_a_short_lowercase_source_is_still_read_as_an_attribution():
    root = _media()
    shots = _run([_quote("Simplicity is the ultimate sophistication -- da Vinci")],
                 media_root=root, options=_quotes()).shots
    assert shots[0].quote_attribution == "da Vinci"


def test_a_dash_line_in_a_multi_line_quote_is_always_the_attribution():
    """A line that opens with a dash is unambiguous, however long it runs."""
    root = _media()
    shots = _run([_quote("A quotation.\n— the collected letters of somebody or other")],
                 media_root=root, options=_quotes()).shots
    assert shots[0].quote_attribution == "the collected letters of somebody or other"


# ── heading pauses ───────────────────────────────────────────────────────────

def _heading(value):
    return {"type": "heading", "content": _text(value)}


def test_a_heading_read_in_its_section_is_set_apart_by_blank_lines():
    """The blank line is what chunk_narration turns into an actual gap; without
    it the voice has only a full stop between the paragraph and the heading."""
    root = _media()
    shots = _run([
        _para("The first section ends here"),
        _heading("A New Chapter"),
        _para("And the next section begins"),
    ], media_root=root).shots
    assert shots[0].narration == (
        "The first section ends here.\n\nA New Chapter.\n\nAnd the next section begins."
    )


def test_ordinary_paragraphs_are_not_set_apart_from_each_other():
    root = _media()
    shots = _run([_para("One"), _para("Two")], media_root=root).shots
    assert shots[0].narration == "One.\nTwo."


def test_turning_the_heading_pause_off_leaves_the_narration_as_it_was():
    root = _media()
    options = RenderOptions(title_card=False, heading_pause_ms=0)
    shots = _run([_para("Before"), _heading("A Heading"), _para("After")],
                 media_root=root, options=options).shots
    assert shots[0].narration == "Before.\nA Heading.\nAfter."


def test_a_leading_or_trailing_break_is_trimmed_off_the_shot():
    """A pause before the first word or after the last would just pad the shot."""
    root = _media()
    shots = _run([_heading("Opening Heading"), _para("Body")], media_root=root).shots
    assert shots[0].narration.startswith("Opening Heading.")
    assert not shots[0].narration.endswith("\n")


def test_a_chapter_card_carries_its_heading_unmarked():
    """A card is its own shot, so the boundary is already there in the picture."""
    root = _media()
    options = RenderOptions(title_card=False, chapter_screens=True)
    shots = _run([_heading("A Chapter"), _para("Body")],
                 media_root=root, options=options).shots
    card = next(s for s in shots if s.kind == "card")
    assert card.narration == "A Chapter."


# ── a chapter screen must not lose the picture behind it ────────────────────
#
# Confirmed as a real bug: `flush(None)` discarded the open shot's background
# entirely, so the section after a chapter card fell back to the plain
# gradient instead of resuming the image that was on screen before the card.

def test_a_chapter_screen_does_not_lose_the_image_behind_it():
    root = _media("a.png")
    plan = _run(CHAPTERED_DOC, media_root=root, options=_with_chapter_screens())
    photo = os.path.join(root, "u1", "a.png")

    card_index = plan.shots.index(next(s for s in plan.shots if s.kind == "card"))
    before, after = plan.shots[card_index - 1], plan.shots[card_index + 1]
    assert before.background == photo
    assert after.background == photo
    assert after.narration == "Second section."


def test_a_chapter_screen_over_a_sounded_clip_resumes_muted():
    """Carrying the shot as-is would replay the clip's own audio under the
    section that follows the card — the same reasoning the quote handler
    above already uses for the same situation."""
    root = _media("clip.mp4")
    shots = _run([
        {"id": "1", "type": "videoFile", "props": {"url": "/media/u1/clip.mp4"}},
        {"id": "2", "type": "heading", "content": _text("A Chapter")},
        {"id": "3", "type": "paragraph", "content": _text("After the chapter.")},
    ], media_root=root, options=_with_chapter_screens(), loud={"clip.mp4"}).shots

    assert [s.kind for s in shots] == ["video_sound", "video_muted", "card", "video_muted"]
    clip = os.path.join(root, "u1", "clip.mp4")
    assert shots[3].background == clip
    assert shots[3].narration == "After the chapter."


def test_a_chapter_screen_before_any_media_still_falls_back_to_the_gradient():
    """Nothing to carry forward here — this must behave as it always has."""
    root = _media()
    shots = _run([
        {"id": "1", "type": "heading", "content": _text("Opening Chapter")},
        {"id": "2", "type": "paragraph", "content": _text("Body text.")},
    ], media_root=root, options=_with_chapter_screens()).shots

    body = next(s for s in shots if s.narration == "Body text.")
    assert body.background is None


def test_back_to_back_chapter_screens_both_hold_the_same_image():
    root = _media("a.png")
    shots = _run([
        {"id": "1", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "2", "type": "heading", "content": _text("First Heading")},
        {"id": "3", "type": "heading", "content": _text("Second Heading")},
        {"id": "4", "type": "paragraph", "content": _text("After both.")},
    ], media_root=root, options=_with_chapter_screens()).shots

    photo = os.path.join(root, "u1", "a.png")
    cards = [s for s in shots if s.kind == "card"]
    assert [c.card_title for c in cards] == ["First Heading", "Second Heading"]
    # Every "still" shot in this run sits on the one image — none of them ever
    # fell back to the gradient, including the beat held between the two cards.
    assert all(s.background == photo for s in shots if s.kind == "still")


def test_a_new_image_after_a_chapter_screen_still_takes_over_as_normal():
    root = _media("a.png", "b.png")
    shots = _run([
        {"id": "1", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "2", "type": "heading", "content": _text("A Chapter")},
        {"id": "3", "type": "image", "props": {"url": "/media/u1/b.png"}},
        {"id": "4", "type": "paragraph", "content": _text("On the new image.")},
    ], media_root=root, options=_with_chapter_screens()).shots

    b = os.path.join(root, "u1", "b.png")
    body = next(s for s in shots if s.narration == "On the new image.")
    assert body.background == b


# ── pause markers never reach the picture ─────────────────────────────────────
# `parse_pause_markup` strips markers on the way to a TTS request, but a heading
# and a quote are also *drawn*, and those fields never went through it — so
# "[pause:2s]" typed into a heading was rendered onto the video. Shot's
# __post_init__ is what closes that off; these guard it per drawn field.

def test_a_marker_in_a_chapter_heading_is_not_drawn_on_the_card():
    root = _media()
    blocks = [{"type": "heading", "content": _text("Chapter One [pause:2s]")}]
    result = _run(blocks, media_root=root,
                  options=RenderOptions(title_card=False, chapter_screens=True))
    cards = [s for s in result.shots if s.card_title]
    assert cards, "expected a chapter card"
    assert cards[0].card_title == "Chapter One"
    assert cards[0].chapter == "Chapter One"
    # The spoken copy keeps the marker on purpose: parse_pause_markup needs it
    # there to place the silence, and strips it on the way to the TTS request.
    assert "[pause:2s]" in cards[0].narration


def test_a_marker_in_a_quote_is_not_drawn_in_the_panel():
    root = _media()
    blocks = [_quote("Hold this thought [pause:long] — Someone")]
    result = _run(blocks, media_root=root, options=_quotes())
    quotes = [s for s in result.shots if s.quote_text]
    assert quotes, "expected a quote shot"
    assert quotes[0].quote_text == "Hold this thought"
    assert "[pause" not in (quotes[0].quote_attribution or "")


def test_a_marker_in_the_note_title_is_not_drawn_on_the_title_card():
    root = _media()
    result = _run([{"type": "paragraph", "content": _text("Body.")}], media_root=root,
                  options=RenderOptions(title_card=True), title="My Note [pause:1s]")
    titles = [s for s in result.shots if s.card_kind == "title"]
    assert titles, "expected a title card"
    assert titles[0].card_title == "My Note"


def test_markers_are_not_counted_as_narration_characters():
    """The figure the options dialog shows, and the one checked against
    max_narration_chars, is what will actually be spoken."""
    root = _media()
    plain = _run([{"type": "paragraph", "content": _text("Hello world.")}], media_root=root)
    marked = _run([{"type": "paragraph", "content": _text("Hello [pause:2s] world.")}],
                  media_root=root)
    assert marked.narration_chars == plain.narration_chars
