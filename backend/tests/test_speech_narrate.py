"""The /speech/narrate export path: chunking, stitching, and the MP3 join.

Live playback can hold a pause with a timer, but a file cannot — so exported
and inserted audio used to arrive with every pause missing. These cover the two
halves of the fix: splitting the text the same way the player does (so the TTS
disk cache hits and nothing is billed twice), and laying real silence between
the pieces with ffmpeg.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from app.routers.settings import (
    _EXPORT_CHUNK_CHARS,
    _MIN_AUDIO_BYTES,
    _TTS_CACHE_DIR,
    _pack_export_chunks,
    _tts_cache_get,
    _tts_cache_put,
)
from app.video import ffmpeg as F
from app.video.narration import stitch_chunks_to_mp3, synthesize_shot
from app.video.options import RenderOptions
from app.video.pause_markup import DEFAULT_PAUSE_MS


# ── chunking ──────────────────────────────────────────────────────────────────

def test_markers_are_stripped_and_their_pauses_carried():
    chunks = _pack_export_chunks("One. Two [pause:2s] three... four.")
    assert [c.text for c in chunks] == ["One.", "Two", "three...", "four."]
    assert [c.pause_after_ms for c in chunks] == [
        DEFAULT_PAUSE_MS["."], 2000, DEFAULT_PAUSE_MS["…"], 0,
    ]


def test_emoji_are_dropped_before_synthesis():
    chunks = _pack_export_chunks("Drive the car 🚗 home.")
    assert "🚗" not in "".join(c.text for c in chunks)


def test_runs_of_spaces_collapse_but_blank_lines_survive():
    """Newlines are what the paragraph trigger is made of — collapsing them
    would silently disable every paragraph pause in an export."""
    chunks = _pack_export_chunks("One.\n\nTwo.")
    assert [c.pause_after_ms for c in chunks] == [1600, 0]


def test_an_over_long_segment_splits_on_a_word_boundary():
    long_sentence = "word " * 500 + "end."
    chunks = _pack_export_chunks(long_sentence)
    assert all(len(c.text) <= _EXPORT_CHUNK_CHARS for c in chunks)
    assert len(chunks) > 1
    # A split forced by length is not a place to pause; only the last piece
    # keeps the pause the sentence actually asked for.
    assert [c.pause_after_ms for c in chunks[:-1]] == [0] * (len(chunks) - 1)
    assert not any(c.text.endswith("wor") for c in chunks)


def test_empty_text_yields_no_chunks():
    assert _pack_export_chunks("") == []
    assert _pack_export_chunks("   ") == []


# ── the join ──────────────────────────────────────────────────────────────────

def test_the_join_command_re_encodes_to_mp3():
    argv = F.build_join_mp3_command("list.txt", "out.mp3")
    assert argv[:2] == ["ffmpeg", "-y"]
    assert "-f" in argv and "concat" in argv
    assert "libmp3lame" in argv, "an export is stored and re-fetched; it does not stay WAV"
    assert argv[-1] == "out.mp3"


def test_stitching_nothing_returns_nothing():
    assert stitch_chunks_to_mp3([]) == b""


needs_ffmpeg = pytest.mark.skipif(
    not F.ffmpeg_available(), reason="ffmpeg/ffprobe not installed",
)


def _tone(work_dir, index, seconds=1.0):
    """A one-second MP3 standing in for a synthesised chunk."""
    path = os.path.join(work_dir, f"tone{index}.mp3")
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
         "-i", f"sine=frequency={440 + index * 220}:duration={seconds}",
         "-c:a", "libmp3lame", path],
        check=True,
    )
    with open(path, "rb") as f:
        return f.read()


@needs_ffmpeg
def test_the_join_holds_each_chunks_pause_as_real_silence():
    work_dir = tempfile.mkdtemp()
    try:
        pieces = [(_tone(work_dir, 0), 2000), (_tone(work_dir, 1), 500), (_tone(work_dir, 2), 0)]
        joined = stitch_chunks_to_mp3(pieces)
        out = os.path.join(work_dir, "joined.mp3")
        with open(out, "wb") as f:
            f.write(joined)
        # 1s + 2.0s + 1s + 0.5s + 1s, plus the encoder's own trailing padding.
        assert F.probe_duration(out) == pytest.approx(5.5, abs=0.1)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@needs_ffmpeg
def test_the_last_chunks_pause_is_not_appended():
    """There is nothing after it to be separated from — a trailing gap would
    just be dead air at the end of every export."""
    work_dir = tempfile.mkdtemp()
    try:
        joined = stitch_chunks_to_mp3([(_tone(work_dir, 0), 1000), (_tone(work_dir, 1), 9999)])
        out = os.path.join(work_dir, "joined.mp3")
        with open(out, "wb") as f:
            f.write(joined)
        assert F.probe_duration(out) == pytest.approx(3.0, abs=0.1)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


@needs_ffmpeg
def test_the_join_comes_back_as_mp3_not_wav():
    work_dir = tempfile.mkdtemp()
    try:
        joined = stitch_chunks_to_mp3([(_tone(work_dir, 0), 500), (_tone(work_dir, 1), 0)])
        out = os.path.join(work_dir, "joined.mp3")
        with open(out, "wb") as f:
            f.write(joined)
        codec = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", out],
            capture_output=True,
        ).stdout.decode().strip()
        assert codec == "mp3"
        # Two seconds of 48 kHz stereo PCM would be ~380 KB.
        assert len(joined) < 100_000
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


# ── shared parity table ───────────────────────────────────────────────────────
# Also asserted, verbatim, by frontend/src/utils/speechChunks.test.ts.

_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "pause_cases.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", _FIXTURE["chunk"], ids=lambda c: c["name"])
def test_shared_chunk_cases(case):
    chunks = _pack_export_chunks(case["text"])
    assert [[c.text, c.pause_after_ms] for c in chunks] == case["expect"]


# ── the export path never asks the TTS engine to say nothing ──────────────────

@pytest.mark.parametrize("body", ["...", "..", ". . .", "---", "\U0001F697"])
def test_a_wordless_paragraph_is_not_exported_as_a_chunk(body):
    chunks = _pack_export_chunks(f"Before this.\n\n{body}\n\nAfter this.")
    assert [c.text for c in chunks] == ["Before this.", "After this."]
    assert chunks[0].pause_after_ms > 0


def test_nothing_sayable_exports_no_chunks():
    assert _pack_export_chunks("...\n\n---") == []


# ── a non-audio provider response is refused, not passed on ───────────────────

def test_the_audio_floor_is_below_any_real_speech():
    """An MP3 of one spoken word runs to several KB; an empty body or a short
    JSON error is what the floor is there to catch."""
    assert 0 < _MIN_AUDIO_BYTES < 1024


def test_a_short_body_is_not_served_from_the_cache():
    """An entry poisoned before the providers checked must read as a miss, or
    the same undecodable bytes come back on every future render of the note."""
    key = "0" * 64
    try:
        _tts_cache_put(key, b'{"err":"no speakable text"}')
        assert _tts_cache_get(key) is None
        _tts_cache_put(key, b"\xff\xfb" + b"\x00" * _MIN_AUDIO_BYTES)
        assert _tts_cache_get(key) is not None
    finally:
        try:
            (_TTS_CACHE_DIR / f"{key}.mp3").unlink()
        except OSError:
            pass


@needs_ffmpeg
def test_an_undecodable_chunk_names_itself_instead_of_pixel_formats():
    """The bare ffmpeg error talks about rawvideo and pixel formats, which sends
    anyone reading a failed job looking for a video bug in an audio path."""
    work_dir = tempfile.mkdtemp()
    try:
        with pytest.raises(F.FFmpegError) as excinfo:
            synthesize_shot(
                "Some narration here.", index=2, work_dir=work_dir,
                options=RenderOptions(title_card=False),
                tts=lambda text: b'{"err":"not audio"}',
            )
        message = str(excinfo.value)
        assert "could not decode as audio" in message
        assert "Some narration here." in message
        assert "pixel format" not in message
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
