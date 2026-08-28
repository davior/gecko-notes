"""Command-building, chunking and subtitle-timing tests.

The ffmpeg builders are pure functions returning argv lists, so the filtergraphs
they produce can be asserted without ffmpeg being installed. Filter availability
is stubbed rather than probed, since it's a property of the host, not the code.
"""

import json
import os
import tempfile

import pytest

from app.video import ffmpeg as F
from app.video.narration import (
    Cue, _srt_timestamp, build_narration_chunks, chunk_narration, chunk_text,
    shift_cues, split_for_subtitles, strip_emoji, write_srt,
)
from app.video.options import (
    MusicSpec, RenderOptions, encoder_tier, frame_size, kenburns_geometry,
    kenburns_leg_frames,
)
from app.video.renderer import build_timeline, estimate
from app.video.segmenter import Shot


@pytest.fixture(autouse=True)
def _all_filters_present(monkeypatch):
    """Pretend the host ffmpeg has everything, so tests exercise the full graph."""
    monkeypatch.setattr(F, "_filter_cache", frozenset({
        "showwaves", "gblur", "subtitles", "drawbox", "overlay", "asplit", "apad",
        "zoompan", "xfade", "concat", "sidechaincompress", "fade", "afade",
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


def test_strip_emoji_drops_pictographs_but_keeps_plain_text():
    assert strip_emoji("I drove my car \U0001F697 to work.") == "I drove my car  to work."
    assert strip_emoji("No emoji here, just #hashtag and 100% normal text.") == \
        "No emoji here, just #hashtag and 100% normal text."
    assert strip_emoji(":) plain smiley text stays") == ":) plain smiley text stays"


def test_strip_emoji_drops_modifiers_and_compound_sequences():
    # Skin-tone modifier, ZWJ family sequence, flag pair, keycap sequence.
    assert strip_emoji("Great \U0001F44D\U0001F3FD job") == "Great  job"
    assert strip_emoji("Family \U0001F468‍\U0001F469‍\U0001F467 photo") == "Family  photo"
    assert strip_emoji("Flags \U0001F1FA\U0001F1F8 here") == "Flags  here"
    assert strip_emoji("Step 1️⃣ done") == "Step 1 done"


def test_chunk_text_strips_emoji_so_narration_never_speaks_them():
    chunks = chunk_text("Great job! \U0001F44D Keep it up.")
    assert chunks == ["Great job! Keep it up."]


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
    assert RenderOptions(shot_end_pause_ms=-5).shot_end_pause_ms == 0
    assert RenderOptions(shot_end_pause_ms=99999).shot_end_pause_ms == 3000


def test_shot_end_pause_defaults_on():
    """Confirmed as a real bug and the reason this option exists: without a
    trailing pause, a shot's audio stops the instant speech does, often
    mid-decay on the voice's own trailing intonation, and the cut lands right
    on top of it — it reads as the sentence getting clipped, not finishing."""
    assert RenderOptions().shot_end_pause_ms > 0


# ── transitions ──────────────────────────────────────────────────────────────

def _shot(options, *, kind="still", duration=6.0, index=0):
    return F.build_shot_command(
        kind=kind, background="bg.png", audio="n.wav", duration=duration,
        output="s.mp4", options=options, preview=False, index=index,
    )


@pytest.mark.parametrize("style,colour", [("fade", "black"), ("fadewhite", "white")])
def test_a_dip_transition_fades_the_picture_and_only_the_sounds_tail(style, colour):
    graph = _graph(_shot(RenderOptions(transition={"style": style, "duration": 0.6})))
    assert f"fade=t=in:st=0:d=0.600:color={colour}" in graph
    assert f"fade=t=out:st=5.400:d=0.600:color={colour}" in graph
    # The tail is faded to match the picture dipping to colour there, landing in
    # the trailing hold after the last word rather than on speech.
    assert "afade=t=out:st=5.400:d=0.600" in graph
    # But not the head: narration starts at st=0 with no lead-in silence, so a
    # matching fade-in there would ramp up through the sentence's actual first
    # word instead of the picture's cosmetic fade from black.
    assert "afade=t=in" not in graph


def test_a_dip_never_takes_more_than_a_third_of_a_short_shot():
    """Two 0.6s dips on a 1.2s shot would never let the picture be fully seen."""
    assert F.dip_seconds("fade", 0.6, 1.2) == pytest.approx(0.4)
    assert F.dip_seconds("fade", 0.6, 30.0) == pytest.approx(0.6)


def test_a_dip_too_short_to_see_is_dropped_entirely():
    assert F.dip_seconds("fade", 0.6, 0.09) == 0.0
    graph = _graph(_shot(RenderOptions(transition={"style": "fade"}), duration=0.09))
    assert "fade=t=in" not in graph


def test_a_crossfade_style_draws_no_per_shot_fade():
    """A blend happens between shots, so drawing one inside a shot as well would
    dip to black and then dissolve out of it."""
    graph = _graph(_shot(RenderOptions(transition={"style": "dissolve"})))
    assert "fade=t=in" not in graph and "afade=" not in graph


def test_no_transition_leaves_the_graph_as_it_was():
    graph = _graph(_shot(RenderOptions()))
    assert "fade=" not in graph
    assert graph.endswith("aresample=48000,aformat=channel_layouts=stereo,apad[a]")


# ── the crossfade stitch ─────────────────────────────────────────────────────

ALL = frozenset({"xfade", "concat"})


def test_crossfade_offsets_accumulate_across_the_whole_video():
    """Each join eats `overlap` seconds, so shot k starts that much earlier than
    the running total — get this wrong and every chapter after the first drifts."""
    argv = F.build_xfade_command(
        ["a.mp4", "b.mp4", "c.mp4"], [5.0, 4.0, 6.0], "out.mp4",
        options=RenderOptions(), preview=False, style="dissolve", overlap=0.6,
    )
    graph = _graph(argv)
    assert "[0:v][1:v]xfade=transition=dissolve:duration=0.600:offset=4.400[vx1]" in graph
    assert "[vx1][2:v]xfade=transition=dissolve:duration=0.600:offset=7.800[vx2]" in graph
    # The audio cuts cleanly at the same offset the picture starts blending at,
    # rather than crossfading — an acrossfade would mix the outgoing shot's
    # trailing hold with the next shot's opening words fading in underneath it.
    assert "acrossfade" not in graph
    assert "[0:a]atrim=end=4.400,asetpts=PTS-STARTPTS[at1]" in graph
    assert "[at1][1:a]concat=n=2:v=0:a=1[ax1]" in graph
    assert "[ax1]atrim=end=7.800,asetpts=PTS-STARTPTS[at2]" in graph
    assert "[at2][2:a]concat=n=2:v=0:a=1[ax2]" in graph
    assert argv[argv.index("-map") + 1] == "[v]"
    assert argv[argv.index("-movflags") + 1] == "+faststart" and argv[-1] == "out.mp4"


def test_every_shot_is_its_own_input_to_the_crossfade():
    argv = F.build_xfade_command(
        ["a.mp4", "b.mp4", "c.mp4"], [5.0, 4.0, 6.0], "out.mp4",
        options=RenderOptions(), preview=False, style="wipeleft", overlap=0.5,
    )
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "-i"] == ["a.mp4", "b.mp4", "c.mp4"]
    assert "transition=wipeleft" in _graph(argv)


def test_a_crossfade_shortens_the_video_by_one_overlap_per_join():
    assert F.crossfade_total([5.0, 4.0, 6.0], 0.6) == pytest.approx(13.8)
    assert F.crossfade_total([5.0, 4.0, 6.0], 0.0) == pytest.approx(15.0)
    assert F.crossfade_total([], 0.6) == 0.0


def test_an_overlap_can_never_exceed_half_the_shortest_shot():
    """Overlapping more than a short shot's own length would blend it away."""
    assert F.crossfade_overlap("dissolve", [10.0, 1.0, 8.0], 0.6, filters=ALL) == pytest.approx(0.5)
    assert F.crossfade_overlap("dissolve", [10.0, 8.0], 0.6, filters=ALL) == pytest.approx(0.6)


def test_shots_too_short_to_overlap_fall_back_to_a_plain_concat():
    assert F.crossfade_overlap("dissolve", [0.08, 5.0], 0.6, filters=ALL) is None


def test_a_dip_or_no_transition_never_takes_the_crossfade_path():
    assert F.crossfade_overlap("fade", [5.0, 5.0], 0.6, filters=ALL) is None
    assert F.crossfade_overlap("none", [5.0, 5.0], 0.6, filters=ALL) is None


def test_a_single_shot_has_nothing_to_crossfade_into():
    assert F.crossfade_overlap("dissolve", [5.0], 0.6, filters=ALL) is None


def test_too_many_shots_fall_back_rather_than_build_a_vast_filtergraph():
    many = [5.0] * (F.XFADE_MAX_SHOTS + 1)
    assert F.crossfade_overlap("dissolve", many, 0.6, filters=ALL) is None
    assert F.crossfade_overlap("dissolve", [5.0] * F.XFADE_MAX_SHOTS, 0.6, filters=ALL) is not None


def test_a_host_without_xfade_falls_back_instead_of_failing_the_render():
    assert F.crossfade_overlap("dissolve", [5.0, 5.0], 0.6, filters=frozenset({"overlay"})) is None
    assert F.crossfade_overlap("dissolve", [5.0, 5.0], 0.6, filters=frozenset({"xfade"})) is None


# ── Ken Burns ────────────────────────────────────────────────────────────────

def _kb(effect="zoom_in", **kwargs):
    return RenderOptions(ken_burns={"effect": effect, **kwargs})


def test_a_drifting_still_reads_far_above_the_frame_and_writes_above_it_too():
    """zoompan truncates its crop origin to whole pixels of the frame it is
    handed, so a slow drift steps unless it is given many more of them. Reading
    big is most of the fix; writing big and scaling back down is the rest."""
    read_w, read_h, write_w, write_h = kenburns_geometry(1920, 1080)
    assert read_w >= 1920 * 3                  # a real supersample, not a token one
    assert (write_w, write_h) == (3840, 2160)  # written at 2x, then scaled back

    graph = _graph(_shot(_kb()))
    assert f"scale={read_w}:{read_h}" in graph
    assert f"s={write_w}x{write_h}" in graph
    assert "scale=1920:1080" in graph


FRAME_SIZES_TO_CHECK = ((854, 480), (1280, 720), (1920, 1080), (3840, 2160),
                        (1080, 1920), (2160, 3840))


def _pixels_per_frame(width, height, *, seconds, amount=0.12, fps=30):
    """How far the crop origin travels per frame, in the pixels zoompan rounds
    to, along the axis the eye actually follows."""
    read_w, read_h, _w, _h = kenburns_geometry(width, height)
    return amount * max(read_w, read_h) / 2 / (seconds * fps)


def test_a_normal_shot_drifts_by_more_than_a_pixel_a_frame():
    """The failure this guards is visible, not theoretical: below about a pixel
    a frame the origin truncates to the same value twice running and the picture
    stalls, then jumps. Before the supersample, 1080p sat at 1.28 and 720p at
    0.85 — which is exactly what "chunky" looked like."""
    for width, height in FRAME_SIZES_TO_CHECK:
        assert _pixels_per_frame(width, height, seconds=6.0) > 1.5, (width, height)


def test_a_long_slow_drift_is_carried_by_the_downscale_not_by_reading_bigger():
    """A 12% zoom over 30s is a genuinely sub-pixel motion — the same travel over
    five times the frames — and no affordable read size fixes it. Writing above
    the frame and scaling back down is what keeps it smooth, because the step
    that survives lands at half size and gets averaged across the downscale."""
    for width, height in FRAME_SIZES_TO_CHECK:
        _r, _rh, write_w, write_h = kenburns_geometry(width, height)
        if (write_w, write_h) == (width, height):
            continue                             # 4K writes at frame size
        assert write_w >= width * 2 or write_h >= height * 2, (width, height)


def test_reading_is_never_smaller_than_writing():
    """That would have zoompan upscaling just to fill its own output."""
    for size in ((854, 480), (1280, 720), (1920, 1080), (3840, 2160), (2160, 3840)):
        read_w, read_h, write_w, write_h = kenburns_geometry(*size)
        assert read_w >= write_w and read_h >= write_h


def test_a_portrait_frame_is_budgeted_by_pixels_not_by_width():
    """Scaling a 9:16 frame by a width rule would build an enormous buffer."""
    read_w, read_h, _w, _h = kenburns_geometry(1080, 1920)
    assert read_w * read_h <= 24_000_000 * 1.02


def test_ken_burns_travel_is_written_against_the_frame_count_not_a_step():
    """An incremental `zoom+step` drifts with the frame rate; `on/N` does not."""
    graph = _graph(_shot(_kb(), duration=6.0))          # 6s at 30fps = 180 frames
    assert "z=1+0.1200*on/180" in graph
    # Two frames past the shot, so `-t` cuts before zoompan restarts its ramp.
    assert "d=182" in graph


def test_zoom_out_starts_wide_and_closes_in_on_one():
    graph = _graph(_shot(_kb("zoom_out"), duration=6.0))
    assert "z=1.1200-0.1200*on/180" in graph


@pytest.mark.parametrize("effect,axis", [
    ("pan_right", "x=(iw-iw/zoom)*on/180"),
    ("pan_left", "x=(iw-iw/zoom)*(1-on/180)"),
    ("pan_down", "y=(ih-ih/zoom)*on/180"),
    ("pan_up", "y=(ih-ih/zoom)*(1-on/180)"),
])
def test_a_pan_holds_the_zoom_and_sweeps_one_axis(effect, axis):
    graph = _graph(_shot(_kb(effect), duration=6.0))
    assert "z=1.1200:" in graph
    assert axis in graph


def test_no_ken_burns_expression_needs_escaping():
    """A comma or colon in an expression would be read as a filtergraph
    separator, so every expression here is deliberately free of both."""
    chain = F.kenburns_chain("in", "out", width=1920, height=1080, fps=30,
                             duration=6.0, effect="pan_right", amount=0.2)
    zoompan = chain[chain.index("zoompan=") + len("zoompan="):]
    # Only the zoompan call itself — the trailing scale is a separate filter.
    zoompan = zoompan.split(",")[0]
    for option in zoompan.split(":"):
        assert "," not in option


def test_a_cycling_zoom_in_and_out_use_the_same_wave():
    """Past kenburns_leg_frames a single sweep would crawl, so the travel
    rubber-bands A to B to A instead — the same triangle wave drives both
    directions, only the sign each one applies it with differs."""
    leg = kenburns_leg_frames(0.12, 1920)
    period = 2 * leg
    wave = f"(1-abs((on-{period}*floor(on/{period}))/{leg}-1))"
    assert f"z=1+0.1200*{wave}" in _graph(_shot(_kb("zoom_in"), duration=200.0))
    assert f"z=1.1200-0.1200*{wave}" in _graph(_shot(_kb("zoom_out"), duration=200.0))


def test_a_cycling_pan_still_only_sweeps_one_axis_and_holds_the_zoom():
    leg = kenburns_leg_frames(0.12, 1920)
    period = 2 * leg
    wave = f"(1-abs((on-{period}*floor(on/{period}))/{leg}-1))"
    right = _graph(_shot(_kb("pan_right"), duration=200.0))
    left = _graph(_shot(_kb("pan_left"), duration=200.0))
    assert "z=1.1200:" in right and "z=1.1200:" in left
    assert f"x=(iw-iw/zoom)*{wave}" in right
    assert f"x=(iw-iw/zoom)*(1-{wave})" in left


def test_no_ken_burns_expression_needs_escaping_when_cycling():
    """Same invariant as above, for the cycling branch: the wave is built from
    floor/abs and arithmetic only — never ffmpeg's comma-separated mod() — so
    nothing here needs escaping either."""
    chain = F.kenburns_chain("in", "out", width=1920, height=1080, fps=30,
                             duration=600.0, effect="pan_right", amount=0.2)
    zoompan = chain[chain.index("zoompan=") + len("zoompan="):].split(",")[0]
    for option in zoompan.split(":"):
        assert "," not in option


def test_the_zoom_never_travels_further_than_what_was_read():
    """Past that the zoom magnifies pixels rather than revealing them."""
    read_w, _h, _ww, _wh = kenburns_geometry(3840, 2160)
    headroom = read_w / 3840 - 1.0
    chain = F.kenburns_chain("in", "out", width=3840, height=2160, fps=30,
                             duration=4.0, effect="zoom_in", amount=5.0)
    assert f"z=1+{headroom:.4f}*on/120" in chain


def test_a_video_background_is_never_given_ken_burns():
    """The footage already moves; drifting it as well would fight the content."""
    options = _kb()
    assert F.kenburns_effect_for("video_muted", 0, options) is None
    assert F.kenburns_effect_for("video_sound", 0, options) is None
    assert "zoompan" not in _graph(_shot(options, kind="video_muted"))


def test_cards_hold_still_unless_they_are_opted_in():
    assert F.kenburns_effect_for("card", 0, _kb()) is None
    assert F.kenburns_effect_for("card", 0, _kb(include_cards=True)) == "zoom_in"


def test_an_included_card_zooms_from_the_centre_and_never_pans():
    """A card's text is drawn into the picture, so a pan would walk it out of frame."""
    options = _kb("pan_right", include_cards=True)
    assert F.kenburns_effect_for("card", 0, options) == "zoom_in"
    graph = _graph(_shot(options, kind="card"))
    assert "x=iw/2-(iw/zoom/2)" in graph


def test_alternate_rotates_deterministically_so_a_rerender_matches():
    options = _kb("alternate")
    picks = [F.kenburns_effect_for("still", i, options) for i in range(5)]
    assert picks == ["zoom_in", "pan_right", "zoom_out", "pan_left", "zoom_in"]


def test_a_host_without_zoompan_renders_the_shot_still(monkeypatch):
    monkeypatch.setattr(F, "_filter_cache", frozenset({"overlay"}))
    assert "zoompan" not in _graph(_shot(_kb()))


def test_ken_burns_sits_under_the_overlay_so_the_watermark_stays_pinned():
    argv = F.build_shot_command(
        kind="still", background="bg.png", audio="n.wav", duration=6.0,
        output="s.mp4", options=_kb(), preview=False, overlay_png="ov.png", index=0,
    )
    graph = _graph(argv)
    assert graph.index("zoompan") < graph.index("overlay=0:0")


# ── background music ─────────────────────────────────────────────────────────

def _music(**kwargs):
    return MusicSpec(enabled=True, url="/media/u/bed.mp3", **kwargs)


def test_scoring_a_render_never_re_encodes_the_picture():
    """The bed only touches the audio, so the video stream is passed through."""
    argv = F.build_music_command("in.mp4", "bed.mp3", "out.mp4",
                                 duration=40.0, spec=_music(), duck=False)
    assert argv[argv.index("-c:v") + 1] == "copy"
    assert argv[argv.index("-c:a") + 1] == "aac"
    assert argv[argv.index("-map") + 1] == "0:v"


def test_a_short_bed_loops_and_a_long_one_is_cut_to_the_video():
    argv = F.build_music_command("in.mp4", "bed.mp3", "out.mp4",
                                 duration=40.0, spec=_music(), duck=False)
    assert argv[argv.index("-stream_loop") + 1] == "-1"
    assert argv[argv.index("-stream_loop") + 2] == "-i"      # loops the bed, not the video
    assert argv[argv.index("-t") + 1] == "40.000"
    assert "duration=first" in _graph(argv)


def test_the_mix_does_not_let_amix_halve_the_narration():
    """amix normalises by input count by default, which buries the voice."""
    assert "normalize=0" in _graph(
        F.build_music_command("in.mp4", "b.mp3", "o.mp4",
                              duration=40.0, spec=_music(), duck=False))


def test_ducking_compresses_the_bed_against_the_narration():
    graph = _graph(F.build_music_command("in.mp4", "b.mp3", "o.mp4",
                                         duration=40.0, spec=_music(), duck=True))
    # The narration has to be split: it is both the key and part of the mix.
    assert "[0:a]asplit=2[nar][key]" in graph
    assert "[m][key]sidechaincompress=" in graph
    assert "[nar][bed]amix=inputs=2:normalize=0:duration=first[a]" in graph


def test_without_ducking_the_bed_is_mixed_flat():
    graph = _graph(F.build_music_command("in.mp4", "b.mp3", "o.mp4",
                                         duration=40.0, spec=_music(), duck=False))
    assert "sidechaincompress" not in graph
    assert "[0:a][m]amix=inputs=2:normalize=0:duration=first[a]" in graph


def test_the_bed_fades_in_at_the_start_and_out_at_the_end():
    graph = _graph(F.build_music_command(
        "in.mp4", "b.mp3", "o.mp4", duration=40.0,
        spec=_music(fade_in=2.0, fade_out=3.0), duck=False))
    assert "afade=t=in:st=0:d=2.000" in graph
    assert "afade=t=out:st=37.000:d=3.000" in graph


def test_a_video_shorter_than_the_fade_out_still_builds_a_valid_graph():
    graph = _graph(F.build_music_command(
        "in.mp4", "b.mp3", "o.mp4", duration=1.0,
        spec=_music(fade_out=5.0), duck=False))
    assert "afade=t=out:st=0.000:d=5.000" in graph


# ── the finished video's timeline ────────────────────────────────────────────

def _timeline(durations, chapters=None, overlap=0.0, cues=None):
    shots = [Shot(kind="still", chapter=(chapters or {}).get(i))
             for i in range(len(durations))]
    per_shot = cues or [[] for _ in durations]
    return build_timeline(shots, durations, per_shot, overlap)


def test_without_a_transition_the_timeline_is_just_the_shots_end_to_end():
    marks, _cues, total = _timeline([5.0, 4.0, 6.0], {0: "One", 2: "Two"})
    assert total == pytest.approx(15.0)
    assert marks == [(0.0, 9.0, "One"), (9.0, 15.0, "Two")]


def test_an_unmarked_shot_extends_the_chapter_that_is_open():
    marks, _cues, _total = _timeline([5.0, 4.0, 6.0], {0: "Only"})
    assert marks == [(0.0, 15.0, "Only")]


def test_a_crossfade_pulls_every_later_shot_earlier_by_one_overlap():
    """Each join eats `overlap`, so a chapter mark that ignored it would drift
    further out of place with every section."""
    marks, _cues, total = _timeline([5.0, 4.0, 6.0], {0: "One", 2: "Two"}, overlap=0.6)
    assert total == pytest.approx(13.8)          # 15 - 0.6 * 2
    # Shot 1 starts at 4.4 and runs 4.0, so shot 2 starts at 7.8 — and that is
    # exactly where the first chapter has to end.
    assert marks[0] == (pytest.approx(0.0), pytest.approx(7.8), "One")
    assert marks[1] == (pytest.approx(7.8), pytest.approx(13.8), "Two")


def test_chapter_marks_never_overlap_each_other():
    marks, _cues, total = _timeline([5.0, 4.0, 6.0], {0: "a", 1: "b", 2: "c"}, overlap=0.6)
    for earlier, later in zip(marks, marks[1:]):
        assert earlier[1] == pytest.approx(later[0])
    assert marks[-1][1] == pytest.approx(total)


def test_subtitle_cues_are_shifted_onto_the_overlapped_timeline():
    """Cues are shot-local until they land here; getting the shift wrong is how
    subtitles slide out of sync a few minutes into a long video."""
    per_shot = [[Cue(0.0, 1.0, "first")], [Cue(0.0, 1.0, "second")]]
    _marks, cues, _total = _timeline([5.0, 4.0], overlap=0.6, cues=per_shot)
    assert cues[0].start == pytest.approx(0.0)
    assert cues[1].start == pytest.approx(4.4)   # the second shot starts early


def test_a_video_with_no_chapters_still_reports_its_length():
    marks, cues, total = _timeline([3.0])
    assert marks == [] and cues == [] and total == pytest.approx(3.0)


# ── pauses around headings ───────────────────────────────────────────────────

def _narration(text, paragraph=350, heading=800):
    return chunk_narration(text, paragraph_pause_ms=paragraph, heading_pause_ms=heading)


def test_a_heading_is_held_on_both_sides():
    """A full stop is all a voice has between a paragraph and the heading after
    it, so the two run together in one breath unless real silence is inserted."""
    chunks = _narration("Ends here.\n\nA New Chapter.\n\nBegins now.")
    assert [c.text for c in chunks] == ["Ends here.", "A New Chapter.", "Begins now."]
    assert [c.pause_after_ms for c in chunks] == [800, 800, 0]


def test_prose_without_a_heading_still_travels_as_one_request():
    """Splitting where no pause is wanted would buy nothing and cost a TTS call."""
    chunks = _narration("Just prose. More of the same prose.")
    assert len(chunks) == 1
    assert chunks[0].pause_after_ms == 0


def test_an_ordinary_block_join_is_not_a_break():
    """Blocks are joined with a single newline; only a blank line marks a pause,
    so marking has to be deliberate rather than accidental."""
    chunks = _narration("One paragraph.\nAnother paragraph.")
    assert len(chunks) == 1


def test_turning_the_pause_off_restores_the_old_single_chunk():
    chunks = _narration("Ends here.\n\nA New Chapter.\n\nBegins now.", heading=0)
    assert len(chunks) == 1
    assert chunks[0].pause_after_ms == 0


def test_back_to_back_headings_are_held_once_not_twice():
    chunks = _narration("Body.\n\nFirst Heading.\n\n\nSecond Heading.\n\nMore body.")
    assert [c.text for c in chunks] == [
        "Body.", "First Heading.", "Second Heading.", "More body.",
    ]
    assert [c.pause_after_ms for c in chunks] == [800, 800, 800, 0]


def test_a_long_section_keeps_the_shorter_pause_between_its_own_chunks():
    """Only the gap at a heading is the long one; splitting an oversized section
    is a mechanical necessity, not a place anyone wants a beat."""
    section = " ".join(f"Sentence number {i}." for i in range(400))
    chunks = _narration(f"{section}\n\nA Heading.")
    assert len(chunks) > 2
    assert chunks[-2].pause_after_ms == 800     # the last chunk before the heading
    assert chunks[0].pause_after_ms == 350      # inside the section
    assert chunks[-1].pause_after_ms == 0


def test_nothing_is_held_after_the_final_chunk():
    """A trailing pause would just pad the end of the shot."""
    for text in ("Alone.", "A.\n\nB.", "A.\n\nB.\n\nC."):
        assert _narration(text)[-1].pause_after_ms == 0


def test_blank_narration_produces_no_chunks():
    assert _narration("") == []
    assert _narration("\n\n   \n\n") == []


# ── build_narration_chunks: heading pauses + pause markup, combined ─────────
# This is what synthesize_shot actually calls by default — chunk_narration
# above is only exercised directly any more by estimate()'s rough duration
# guess. The markup handling (ellipsis, [pause:...], blank lines) was wired
# in here after users found it had never been reachable at all: RenderOptions
# only ever fed chunk_narration, which has no notion of pause markup.

def _chunks(text, **kwargs):
    opts = RenderOptions(**kwargs)
    return build_narration_chunks(text, options=opts)


def test_a_plain_sentence_period_never_forces_a_split():
    """Unlike the read-aloud player, an ordinary paragraph keeps its natural
    one-breath prosody — only punctuation someone typed on purpose pauses."""
    chunks = _chunks("First sentence. Second sentence. Third sentence.")
    assert len(chunks) == 1
    assert chunks[0].text == "First sentence. Second sentence. Third sentence."


@pytest.mark.parametrize("ellipsis", ["...", "…"])
def test_an_ellipsis_pauses_regardless_of_spelling(ellipsis):
    chunks = _chunks(f"Wait for it{ellipsis} here it comes.")
    assert [c.text for c in chunks] == ["Wait for it" + ellipsis, "here it comes."]
    assert chunks[0].pause_after_ms > 0
    assert chunks[-1].pause_after_ms == 0


def test_an_explicit_pause_marker_is_honoured_and_stripped():
    chunks = _chunks("Then you took a side [pause:1200] really took a side.")
    assert [c.text for c in chunks] == ["Then you took a side", "really took a side."]
    assert chunks[0].pause_after_ms == 1200
    assert "[pause" not in "".join(c.text for c in chunks)


def test_a_heading_boundary_still_pauses_through_pause_markup():
    """The blank line _set_apart wraps a heading in is exactly the "\\n\\n"
    trigger pause_markup already understands — heading_pause_ms drives it."""
    chunks = _chunks("Ends here.\n\nA New Chapter.\n\nBegins now.", heading_pause_ms=2000)
    assert [c.text for c in chunks] == ["Ends here.", "A New Chapter.", "Begins now."]
    assert [c.pause_after_ms for c in chunks] == [2000, 2000, 0]


def test_heading_pause_off_disables_the_blank_line_without_gluing_words():
    """A regression guard: dropping the "\\n\\n" trigger entirely used to also
    drop its whitespace, gluing 'text.Heading' together with no space."""
    chunks = _chunks("Ends here.\n\nA New Chapter.", heading_pause_ms=0)
    assert len(chunks) == 1
    assert chunks[0].text == "Ends here. A New Chapter."


def test_a_long_stretch_with_no_markup_still_falls_back_to_length_splitting():
    """paragraph_pause_ms's one remaining job: a section pause_markup left as
    a single chunk that is still too long for one TTS request."""
    section = " ".join(f"Sentence number {i}." for i in range(400))
    chunks = _chunks(section, paragraph_pause_ms=3000, heading_pause_ms=0)
    assert len(chunks) > 1
    assert chunks[0].pause_after_ms == 3000
    assert chunks[-1].pause_after_ms == 0


def test_blank_narration_produces_no_chunks_via_markup_too():
    assert _chunks("") == []
    assert _chunks("   ") == []


# ── the per-shot timeout scales with the shot, instead of being flat ────────

def test_a_short_shot_gets_the_old_flat_floor():
    assert F.shot_timeout(3.0) == F.SHOT_TIMEOUT_SECONDS
    assert F.shot_timeout(0.0) == F.SHOT_TIMEOUT_SECONDS


def test_a_long_shot_gets_a_budget_scaled_to_its_own_length():
    """A flat cap is wrong because a shot is not a fixed amount of work — an
    eight-minute still and a three-second card used to get the same 900s."""
    assert F.shot_timeout(200.0) == 200.0 * F.SHOT_TIMEOUT_FACTOR


def test_the_exact_shot_that_failed_in_production_now_gets_room_to_finish():
    """Shot 34 from job 3d815257: a 502.678s still that hit the flat 900s cap
    and was killed with 40% of its own length still left to encode."""
    assert F.shot_timeout(502.678) > 900
    assert F.shot_timeout(502.678) >= 502.678 * 2  # comfortable headroom, not just enough


def test_the_timeout_still_has_a_ceiling():
    assert F.shot_timeout(10_000.0) == F.SHOT_TIMEOUT_CEILING


# ── a timeout becomes a readable error, not a severed argv ──────────────────

def test_a_timeout_is_reported_as_a_short_readable_message(monkeypatch):
    """subprocess.TimeoutExpired stringifies as the whole argv followed by the
    reason — over a thousand characters for a real shot command — and the
    worker truncates error_message to 500, which used to cut the reason off
    the end entirely. The message here has to be short enough, on its own, to
    survive that truncation with the reason still in it."""
    def _fake_run(argv, **kwargs):
        raise F.subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout", 900))
    monkeypatch.setattr(F.subprocess, "run", _fake_run)

    with pytest.raises(F.FFmpegError) as excinfo:
        F.run(["ffmpeg"] + ["-argument"] * 200, timeout=900)

    message = str(excinfo.value)
    assert len(message) < 500
    assert "900" in message


def test_the_original_timeout_is_chained_so_the_full_argv_still_reaches_the_log(monkeypatch):
    def _fake_run(argv, **kwargs):
        raise F.subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout", 900))
    monkeypatch.setattr(F.subprocess, "run", _fake_run)

    with pytest.raises(F.FFmpegError) as excinfo:
        F.run(["ffmpeg", "-i", "in.mp4", "out.mp4"], timeout=900)
    assert isinstance(excinfo.value.__cause__, F.subprocess.TimeoutExpired)


def test_a_non_zero_exit_is_still_reported_as_before(monkeypatch):
    """The timeout handling must not swallow the ordinary failure path."""
    class _Result:
        returncode = 1
        stderr = b"encoder error: unsupported pixel format"
    monkeypatch.setattr(F.subprocess, "run", lambda *a, **k: _Result())
    with pytest.raises(F.FFmpegError, match="unsupported pixel format"):
        F.run(["ffmpeg"])


# ── Ken Burns cycles instead of stalling on a shot too long for one sweep ───

def test_a_normal_length_shot_fits_inside_one_leg():
    """A 6s shot at 12% travel is nowhere near long enough to need cycling."""
    assert kenburns_leg_frames(0.12, 1920) > 6 * 30


def test_the_exact_shot_that_used_to_go_still_now_needs_many_legs():
    """502.678s at 12% travel on a 1920-wide (1080p) frame — the shot that used
    to render eight minutes of a static image because one sweep across it
    would crawl under a hundredth of a pixel a frame. It still can't sweep
    once across its own length, but it can sweep the leg below, many times."""
    leg = kenburns_leg_frames(0.12, 1920)
    assert leg > 0
    assert int(502.678 * 30) > leg


def test_raising_travel_lengthens_the_leg():
    """Travel is the discoverable lever: turning it up should let a sweep run
    longer before it needs to start cycling."""
    assert kenburns_leg_frames(0.40, 1920) > kenburns_leg_frames(0.12, 1920)


def test_a_degenerate_amount_or_width_still_returns_a_positive_leg():
    """A period of zero would divide by zero building the wave, so the leg is
    floored at one frame no matter how small amount or width is."""
    assert kenburns_leg_frames(0.0, 1920) == 1
    assert kenburns_leg_frames(0.12, 0) == 1


def test_kenburns_effect_for_no_longer_depends_on_shot_length():
    """Ken Burns used to be refused outright on a shot long enough that one
    sweep across it would be too slow to see; kenburns_chain cycles it
    instead now, so which effect a shot gets never depended on duration in
    the first place — the parameter was dropped, not just made optional."""
    options = RenderOptions(ken_burns={"effect": "zoom_in"})
    assert F.kenburns_effect_for("still", 0, options) == "zoom_in"


def test_a_long_shot_cycles_instead_of_stalling():
    """502.678s at 12% travel on a 1920-wide (1080p) frame — the shot that
    used to render eight minutes of a completely still image. It now gets a
    rubber-band cycle: A to B, then B to A, repeating in legs short enough to
    stay visible, instead of one sweep too slow to see or no motion at all."""
    options = RenderOptions(ken_burns={"effect": "zoom_in"})
    leg = kenburns_leg_frames(0.12, 1920)
    period = 2 * leg
    argv = F.build_shot_command(
        kind="still", background="bg.png", audio="n.wav", duration=502.678,
        output="s.mp4", options=options, preview=False, index=0,
    )
    graph = _graph(argv)
    assert f"z=1+0.1200*(1-abs((on-{period}*floor(on/{period}))/{leg}-1))" in graph
    # It pays the same supersample cost as any other drifting shot now — Ken
    # Burns is no longer refused, so the expense the old gate avoided is back
    # by design.
    read_w, read_h, _w, _h = kenburns_geometry(1920, 1080)
    assert f"scale={read_w}:{read_h}" in graph


def test_a_short_shot_still_gets_the_full_supersampled_drift():
    options = RenderOptions(ken_burns={"effect": "zoom_in"})
    argv = F.build_shot_command(
        kind="still", background="bg.png", audio="n.wav", duration=6.0,
        output="s.mp4", options=options, preview=False, index=0,
    )
    assert "zoompan" in _graph(argv)


# ── the end-of-shot pause is a real second and a half the estimate must count ─

def _note(*paragraphs):
    return json.dumps([
        {"id": str(i), "type": "paragraph", "content": [{"type": "text", "text": p}]}
        for i, p in enumerate(paragraphs)
    ])


def _estimate(*paragraphs, **options_kwargs):
    root = tempfile.mkdtemp()
    return estimate(
        user_id="u1", media_dir=root, note_content=_note(*paragraphs), note_title="", author="",
        options=RenderOptions(title_card=False, **options_kwargs),
    )


# Long enough that its spoken length alone clears min_shot_seconds, so the
# floor can't absorb part of the pause and mask what's being measured.
LONG_PARAGRAPH = "A paragraph with enough words in it to run well past the floor. " * 2


def test_a_longer_end_pause_makes_the_estimate_longer():
    """estimate() is a dry run with no ffmpeg and no TTS call, so this is the
    only place this option's effect on total length can be checked at all."""
    short = _estimate(LONG_PARAGRAPH, shot_end_pause_ms=0)
    long = _estimate(LONG_PARAGRAPH, shot_end_pause_ms=2000)
    assert long[2] - short[2] == pytest.approx(2.0, abs=0.05)


def test_the_end_pause_is_sped_up_along_with_the_narration():
    fast = _estimate(LONG_PARAGRAPH, shot_end_pause_ms=1000, speed=2.0)
    normal = _estimate(LONG_PARAGRAPH, shot_end_pause_ms=1000, speed=1.0)
    assert fast[2] < normal[2]


def test_a_shot_with_no_narration_gets_no_end_pause():
    """Nothing was said, so there is nothing for a cut to land on top of."""
    empty_document = _estimate(shot_end_pause_ms=2000)
    assert empty_document[2] == 0.0

    # A silent image (nothing follows it) is a shot that exists but has
    # nothing to say; the 2s end-pause must not be added on top of its floor.
    root = tempfile.mkdtemp()
    os.makedirs(os.path.join(root, "u1"), exist_ok=True)
    open(os.path.join(root, "u1", "photo.png"), "wb").write(b"x")
    doc = json.dumps([{"id": "1", "type": "image", "props": {"url": "/media/u1/photo.png"}}])
    silent_image = estimate(
        user_id="u1", media_dir=root, note_content=doc, note_title="", author="",
        options=RenderOptions(title_card=False, shot_end_pause_ms=2000),
    )
    assert silent_image[2] == RenderOptions().min_shot_seconds
