"""Command-building, chunking and subtitle-timing tests.

The ffmpeg builders are pure functions returning argv lists, so the filtergraphs
they produce can be asserted without ffmpeg being installed. Filter availability
is stubbed rather than probed, since it's a property of the host, not the code.
"""

import pytest

from app.video import ffmpeg as F
from app.video.narration import (
    Cue, _srt_timestamp, chunk_text, shift_cues, split_for_subtitles, write_srt,
)
from app.video.options import RenderOptions, encoder_tier, frame_size


@pytest.fixture(autouse=True)
def _all_filters_present(monkeypatch):
    """Pretend the host ffmpeg has everything, so tests exercise the full graph."""
    monkeypatch.setattr(F, "_filter_cache", frozenset({
        "showwaves", "gblur", "subtitles", "drawbox", "overlay", "asplit", "apad",
    }))


def _graph(argv):
    return argv[argv.index("-filter_complex") + 1]


# ── frame sizes and encoder tiers ────────────────────────────────────────────

@pytest.mark.parametrize("aspect,resolution,expected", [
    ("16:9", "720p", (1280, 720)),
    ("16:9", "1080p", (1920, 1080)),
    ("16:9", "4k", (3840, 2160)),
    ("9:16", "1080p", (1080, 1920)),
    ("1:1", "720p", (720, 720)),
])
def test_frame_size_table(aspect, resolution, expected):
    assert frame_size(aspect, resolution) == expected


def test_every_frame_size_is_even_as_yuv420p_requires():
    for aspect in ("16:9", "9:16", "1:1"):
        for resolution in ("720p", "1080p", "4k"):
            for preview in (False, True):
                w, h = frame_size(aspect, resolution, preview)
                assert w % 2 == 0 and h % 2 == 0


def test_unknown_aspect_and_resolution_fall_back():
    assert frame_size("banana", "1080p") == (1920, 1080)
    assert frame_size("16:9", "banana") == (1920, 1080)


def test_preview_overrides_the_chosen_quality():
    assert frame_size("16:9", "4k", preview=True) == (854, 480)
    assert encoder_tier("high", preview=True) == ("ultrafast", 30)
    assert encoder_tier("high") == ("slow", 18)


# ── uniform encoding, which is what makes `concat -c copy` valid ─────────────

def test_every_shot_kind_encodes_identically():
    options = RenderOptions()
    graphs = [
        F.build_shot_command(kind="still", background="a.png", audio="n.wav", duration=3,
                             output="0.mp4", options=options, preview=False),
        F.build_shot_command(kind="video_muted", background="c.mp4", audio="n.wav", duration=3,
                             output="1.mp4", options=options, preview=False),
        F.build_shot_command(kind="video_sound", background="c.mp4", audio=None, duration=3,
                             output="2.mp4", options=options, preview=False,
                             background_has_audio=True),
    ]
    encode = F.encode_args(options, False)
    for argv in graphs:
        assert argv[-len(encode) - 1:-1] == encode


def test_concat_copies_rather_than_re_encoding():
    argv = F.build_concat_command("shots.txt", "out.mp4")
    assert "-c" in argv and argv[argv.index("-c") + 1] == "copy"
    assert "+faststart" in argv
    assert "libx264" not in argv


# ── per-shot commands ────────────────────────────────────────────────────────

def test_muted_video_loops_and_is_cut_by_the_narration():
    argv = F.build_shot_command(kind="video_muted", background="c.mp4", audio="n.wav",
                                duration=7.25, output="s.mp4", options=RenderOptions(),
                                preview=False)
    # Loop while the narration runs...
    assert argv[argv.index("-stream_loop") + 1] == "-1"
    # ...and cut the instant it ends, never waiting for the clip.
    assert argv[argv.index("-t") + 1] == "7.250"


def test_still_shot_holds_one_frame_for_the_narration():
    argv = F.build_shot_command(kind="still", background="bg.png", audio="n.wav", duration=4,
                                output="s.mp4", options=RenderOptions(), preview=False)
    assert "-loop" in argv and argv[argv.index("-loop") + 1] == "1"


def test_sounded_clip_uses_its_own_audio():
    argv = F.build_shot_command(kind="video_sound", background="c.mp4", audio=None, duration=2,
                                output="s.mp4", options=RenderOptions(), preview=False,
                                background_has_audio=True)
    assert "anullsrc" not in " ".join(argv)
    assert "[0:a]" in _graph(argv)


def test_sounded_clip_without_an_audio_track_gets_silence():
    """The concat demuxer needs every part to carry an audio stream."""
    argv = F.build_shot_command(kind="video_sound", background="c.mp4", audio=None, duration=2,
                                output="s.mp4", options=RenderOptions(), preview=False,
                                background_has_audio=False)
    assert "anullsrc=channel_layout=stereo:sample_rate=48000" in argv
    assert "[1:a]" in _graph(argv)


# ── filtergraph shape ────────────────────────────────────────────────────────

@pytest.mark.parametrize("fit,marker", [
    ("blur", "gblur"),
    ("pad", "pad=1920:1080"),
    ("crop", "crop=1920:1080"),
])
def test_fit_modes(fit, marker):
    argv = F.build_shot_command(kind="still", background="bg.png", audio="n.wav", duration=3,
                                output="s.mp4", options=RenderOptions(fit=fit), preview=False)
    assert marker in _graph(argv)


def test_blurred_fill_contains_the_image_over_a_filled_background():
    graph = F.fit_chain("0:v", "fit", 1080, 1920, "blur")
    assert "force_original_aspect_ratio=increase" in graph   # the blurred fill
    assert "force_original_aspect_ratio=decrease" in graph   # the contained image
    assert "gblur" in graph


def test_every_video_chain_ends_normalised():
    """A stray SAR or pixel format is what silently breaks a `-c copy` concat."""
    for kind, audio, has_audio in (
        ("still", "n.wav", False), ("video_muted", "n.wav", False), ("video_sound", None, True),
    ):
        graph = _graph(F.build_shot_command(
            kind=kind, background="x", audio=audio, duration=3, output="o.mp4",
            options=RenderOptions(), preview=False, background_has_audio=has_audio))
        assert "setsar=1,format=yuv420p[v]" in graph


def test_waveform_splits_the_audio_it_shares_with_the_muxed_track():
    """An input pad can only be consumed once in a filtergraph."""
    options = RenderOptions()
    options.waveform.enabled = True
    graph = _graph(F.build_shot_command(kind="still", background="bg.png", audio="n.wav",
                                        duration=3, output="s.mp4", options=options, preview=False))
    assert "[1:a]asplit=2[a_wave][a_main]" in graph
    assert graph.count("[1:a]") == 1


def test_waveform_rate_matches_the_output_frame_rate():
    """A mismatch makes the wave drift against the picture."""
    options = RenderOptions(fps=24)
    options.waveform.enabled = True
    graph = _graph(F.build_shot_command(kind="still", background="bg.png", audio="n.wav",
                                        duration=3, output="s.mp4", options=options, preview=False))
    assert "rate=24" in graph


@pytest.mark.parametrize("position,expected_y", [
    ("top", 0), ("center", (1080 - 236) // 2), ("bottom", 1080 - 236),
])
def test_waveform_position(position, expected_y):
    options = RenderOptions()
    options.waveform.enabled = True
    options.waveform.position = position
    graph = _graph(F.build_shot_command(kind="still", background="bg.png", audio="n.wav",
                                        duration=3, output="s.mp4", options=options, preview=False))
    assert f"overlay=0:{expected_y}" in graph


def test_waveform_is_dropped_when_the_host_ffmpeg_lacks_it(monkeypatch):
    monkeypatch.setattr(F, "_filter_cache", frozenset({"overlay"}))
    options = RenderOptions()
    options.waveform.enabled = True
    graph = _graph(F.build_shot_command(kind="still", background="bg.png", audio="n.wav",
                                        duration=3, output="s.mp4", options=options, preview=False))
    assert "showwaves" not in graph
    assert "setsar=1,format=yuv420p[v]" in graph  # still a valid graph


def test_overlay_and_subtitles_are_layered_in_order():
    graph = _graph(F.build_shot_command(
        kind="still", background="bg.png", audio="n.wav", duration=3, output="s.mp4",
        options=RenderOptions(), preview=False, overlay_png="ov.png", subtitle_file="s.srt"))
    assert graph.index("[2:v]overlay=0:0[ov]") < graph.index("subtitles=s.srt")


def test_colour_parsing_is_forgiving():
    assert F._hex_to_ffmpeg("#00FF41") == "0x00ff41"
    assert F._hex_to_ffmpeg("00ff41") == "0x00ff41"
    assert F._hex_to_ffmpeg("#abc") == "0xaabbcc"
    assert F._hex_to_ffmpeg("#00ff41ff") == "0x00ff41"
    assert F._hex_to_ffmpeg("nonsense") == "0xffffff"
    assert F._hex_to_ffmpeg("") == "0xffffff"


# ── muxing ───────────────────────────────────────────────────────────────────

def test_mux_attaches_chapters_and_soft_subtitles_without_re_encoding():
    argv = F.build_mux_command("in.mp4", "out.mp4", chapters_file="c.ff", subtitle_file="s.srt")
    assert argv[argv.index("-c") + 1] == "copy"
    assert argv[argv.index("-c:s") + 1] == "mov_text"
    assert "-map_chapters" in argv


def test_mux_with_nothing_to_attach_still_copies():
    argv = F.build_mux_command("in.mp4", "out.mp4")
    assert "-c:s" not in argv and "-map_chapters" not in argv


# ── narration joining ────────────────────────────────────────────────────────

def test_narration_decodes_to_pcm_so_the_join_has_no_gaps():
    argv = F.build_narration_command("list.txt", "n.wav")
    assert argv[argv.index("-c:a") + 1] == "pcm_s16le"


def test_speed_beyond_atempos_range_is_applied_in_stages():
    """atempo only accepts 0.5-2.0."""
    single = F.build_narration_command("l.txt", "n.wav", speed=1.5)
    assert "atempo=1.5000" in single[single.index("-filter:a") + 1]

    chained = F.build_narration_command("l.txt", "n.wav", speed=3.0)
    assert chained[chained.index("-filter:a") + 1].count("atempo") == 2

    assert "-filter:a" not in F.build_narration_command("l.txt", "n.wav", speed=1.0)


def test_narration_is_padded_to_the_minimum_shot_length():
    argv = F.build_narration_command("l.txt", "n.wav", min_seconds=2.5)
    assert "apad=whole_dur=2.500" in argv[argv.index("-filter:a") + 1]


def test_concat_list_quotes_each_entry():
    import tempfile
    path = tempfile.mktemp()
    F.write_concat_list(path, ["shot_000.mp4", "it's.mp4"])
    body = open(path).read()
    assert body.splitlines()[0] == "file 'shot_000.mp4'"
    assert "'\\''" in body.splitlines()[1]


# ── chunking ─────────────────────────────────────────────────────────────────

def test_short_text_is_one_chunk():
    assert chunk_text("Hello there. How are you?") == ["Hello there. How are you?"]


def test_empty_text_produces_nothing():
    assert chunk_text("") == []
    assert chunk_text("   \n  ") == []


def test_chunks_stay_under_the_providers_character_cap():
    text = " ".join(f"Sentence number {i} is right here." for i in range(400))
    chunks = chunk_text(text)
    assert len(chunks) > 1
    assert all(len(c) <= 1500 for c in chunks)
    # Nothing is dropped on the way through.
    assert "".join(chunks).replace(" ", "") == text.replace(" ", "")


def test_a_sentence_is_kept_whole_when_the_chunk_is_full():
    """A sentence that fits the cap starts a new chunk rather than being cut."""
    long_sentence = ("A " * 745).strip() + "."      # 1490 chars — fits on its own
    text = f"{long_sentence} Short one."             # together they exceed 1500
    chunks = chunk_text(text)
    assert len(chunks) == 2
    assert chunks[0] == long_sentence
    assert chunks[1] == "Short one."


def test_an_over_long_sentence_is_split_on_a_word_boundary():
    chunks = chunk_text("word " * 800)
    assert len(chunks) > 1
    assert all(not c.startswith(" ") and "  " not in c for c in chunks)
    assert all(len(c) <= 1500 for c in chunks)


def test_an_unbroken_run_is_split_by_length_as_a_last_resort():
    chunks = chunk_text("x" * 4000)
    assert len(chunks) == 3
    assert sum(len(c) for c in chunks) == 4000


# ── subtitles ────────────────────────────────────────────────────────────────

def test_subtitle_lines_stay_readable():
    """A whole TTS chunk is far too much text to show at once."""
    text = " ".join(f"This is sentence {i} of the narration." for i in range(30))
    lines = split_for_subtitles(text)
    assert lines
    assert all(len(l) <= 84 for l in lines)
    assert "".join(lines).replace(" ", "") == text.replace(" ", "")


def test_a_single_long_word_is_still_broken_up():
    lines = split_for_subtitles("supercalifragilistic " * 20)
    assert all(len(l) <= 84 for l in lines)


def test_srt_timestamps():
    assert _srt_timestamp(0) == "00:00:00,000"
    assert _srt_timestamp(3661.5) == "01:01:01,500"
    assert _srt_timestamp(-5) == "00:00:00,000"


def test_cues_are_shifted_onto_the_global_timeline():
    shifted = shift_cues([Cue(0.0, 1.0, "a"), Cue(1.0, 2.0, "b")], 10.5)
    assert [(c.start, c.end) for c in shifted] == [(10.5, 11.5), (11.5, 12.5)]


def test_write_srt_numbers_cues_and_skips_empty_ones():
    import tempfile
    path = tempfile.mktemp()
    assert write_srt(path, [Cue(0, 1, "first"), Cue(1, 2, "   "), Cue(2, 3, "second")])
    body = open(path).read()
    assert body.startswith("1\n00:00:00,000 --> 00:00:01,000\nfirst\n")
    assert "2\n00:00:02,000 --> 00:00:03,000\nsecond\n" in body
    assert body.count("-->") == 2


def test_write_srt_reports_when_there_was_nothing_to_write():
    import tempfile
    assert write_srt(tempfile.mktemp(), []) is False
    assert write_srt(tempfile.mktemp(), [Cue(1.0, 1.0, "zero length")]) is False


# ── options validation ───────────────────────────────────────────────────────

def test_out_of_range_options_are_clamped_rather_than_rejected():
    assert RenderOptions(fps=999).fps == 60
    assert RenderOptions(fps=1).fps == 12
    assert RenderOptions(speed=9).speed == 2.0
    assert RenderOptions(speed=0.01).speed == 0.5
    assert RenderOptions(paragraph_pause_ms=-5).paragraph_pause_ms == 0
    assert RenderOptions(min_shot_seconds=999).min_shot_seconds == 30.0
