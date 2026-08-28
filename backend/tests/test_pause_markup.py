from app.video.pause_markup import (
    DEFAULT_PAUSE_MS,
    NAMED_PAUSE_MS,
    parse_pause_markup,
)

SNIPPET = (
    "You began watching the TV news.\n\n"
    "1, 2, 3\n\n"
    "Then you took a side. [pause:xlong] And that's when you found your heart."
)


def test_the_snippet_from_the_spec_has_no_markers_left():
    chunks = parse_pause_markup(SNIPPET)
    for chunk in chunks:
        assert "[pause:" not in chunk.text


def test_the_snippet_from_the_spec_produces_the_expected_chunks_and_pauses():
    chunks = parse_pause_markup(SNIPPET)
    assert [(c.text, c.pause_after_ms) for c in chunks] == [
        ("You began watching the TV news.", DEFAULT_PAUSE_MS["\n\n"]),
        ("1, 2, 3", DEFAULT_PAUSE_MS["\n\n"]),
        ("Then you took a side.", NAMED_PAUSE_MS["xlong"]),
        ("And that's when you found your heart.", 0),
    ]


def test_the_snippet_reconstructs_to_the_original_prose_minus_markers_and_blank_lines():
    chunks = parse_pause_markup(SNIPPET)
    assert " ".join(c.text for c in chunks) == (
        "You began watching the TV news. 1, 2, 3 Then you took a side. "
        "And that's when you found your heart."
    )


def test_explicit_marker_overrides_rather_than_stacks_with_the_implicit_pause():
    # If it stacked, "side." would carry 900 + 2000 = 2900ms instead of 2000ms.
    chunks = parse_pause_markup(SNIPPET)
    side_chunk = next(c for c in chunks if c.text == "Then you took a side.")
    assert side_chunk.pause_after_ms == NAMED_PAUSE_MS["xlong"]


def test_the_last_chunk_never_carries_a_trailing_pause():
    chunks = parse_pause_markup(SNIPPET)
    assert chunks[-1].pause_after_ms == 0


def test_two_blank_lines_pause_twice_as_long_as_one():
    one_blank = parse_pause_markup("First.\n\nSecond.")
    two_blank = parse_pause_markup("First.\n\n\nSecond.")
    assert one_blank[0].pause_after_ms == DEFAULT_PAUSE_MS["\n\n"]
    assert two_blank[0].pause_after_ms == 2 * DEFAULT_PAUSE_MS["\n\n"]


def test_a_bare_numeric_marker_splits_the_sentence_and_is_removed():
    chunks = parse_pause_markup("Then you took a side [pause:1200] really took a side.")
    assert [(c.text, c.pause_after_ms) for c in chunks] == [
        ("Then you took a side", 1200),
        ("really took a side.", 0),
    ]


def test_each_named_level_resolves_to_its_configured_ms_value():
    for level, ms in NAMED_PAUSE_MS.items():
        chunks = parse_pause_markup(f"Wait [pause:{level}] for it.")
        assert chunks[0].pause_after_ms == ms


def test_ellipsis_uses_its_own_longer_duration_not_the_period_duration():
    dotdotdot = parse_pause_markup("Wait for it... here it comes.")
    unicode_ellipsis = parse_pause_markup("Wait for it… here it comes.")
    assert dotdotdot[0].pause_after_ms == DEFAULT_PAUSE_MS["…"]
    assert unicode_ellipsis[0].pause_after_ms == DEFAULT_PAUSE_MS["…"]
    assert DEFAULT_PAUSE_MS["…"] != DEFAULT_PAUSE_MS["."]


def test_period_immediately_followed_by_a_blank_line_does_not_create_an_empty_chunk():
    # No words between the period and the blank line, so there is nothing to
    # split into a second chunk — the longer (paragraph) pause wins.
    chunks = parse_pause_markup("End of section.\n\nNext section.")
    assert [c.text for c in chunks] == ["End of section.", "Next section."]
    assert chunks[0].pause_after_ms == DEFAULT_PAUSE_MS["\n\n"]


def test_custom_pause_and_named_dicts_override_the_module_defaults():
    chunks = parse_pause_markup(
        "First. Second. [pause:custom] Third.",
        pause_ms={".": 111, "…": 222, "\n\n": 333},
        named_pause_ms={"custom": 4242},
    )
    assert chunks[0].pause_after_ms == 111
    assert chunks[1].pause_after_ms == 4242


def test_a_trailing_explicit_marker_still_yields_zero_pause_on_the_last_chunk():
    # pause_after_ms is only ever read *between* chunks (see synthesize_shot);
    # nothing follows the last chunk, so its value is always forced to 0 even
    # when an explicit marker sits at the very end of the text.
    chunks = parse_pause_markup("Final line. [pause:xlong]")
    assert chunks[-1].pause_after_ms == 0


def test_empty_text_produces_no_chunks():
    assert parse_pause_markup("") == []
    assert parse_pause_markup("   ") == []


# ── omitting a trigger from pause_ms disables it, rather than zeroing it ────
# This is what lets a caller (narration.build_narration_chunks) turn off the
# bare "." without forcing every sentence into its own TTS request.

def test_a_trigger_missing_from_pause_ms_is_not_a_boundary_at_all():
    chunks = parse_pause_markup(
        "First sentence. Second sentence.", pause_ms={"…": 1300, "\n\n": 1600},
    )
    assert len(chunks) == 1
    assert chunks[0].text == "First sentence. Second sentence."


def test_a_disabled_period_still_lets_ellipsis_and_markers_split():
    chunks = parse_pause_markup(
        "One. Two... Three [pause:medium] four.", pause_ms={"…": 1300, "\n\n": 1600},
    )
    assert [c.text for c in chunks] == ["One. Two...", "Three", "four."]
    assert chunks[0].pause_after_ms == 1300
    assert chunks[1].pause_after_ms == NAMED_PAUSE_MS["medium"]


def test_a_disabled_blank_line_collapses_to_a_space_not_nothing():
    """A period keeps its own character either way, but a blank line's
    newlines are otherwise dropped outright — without a substitute space,
    'text.\\n\\nHeading' would glue into 'text.Heading'."""
    chunks = parse_pause_markup("Ends here.\n\nStarts here.", pause_ms={"…": 1300})
    assert len(chunks) == 1
    assert chunks[0].text == "Ends here. Starts here."


def test_an_explicit_marker_overrides_even_a_disabled_trigger():
    chunks = parse_pause_markup(
        "Ends here. [pause:xlong] Starts here.", pause_ms={"…": 1300, "\n\n": 1600},
    )
    assert [c.text for c in chunks] == ["Ends here.", "Starts here."]
    assert chunks[0].pause_after_ms == NAMED_PAUSE_MS["xlong"]
