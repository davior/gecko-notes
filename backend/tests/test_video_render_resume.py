"""Render-level behaviour that depends on ffmpeg failing part-way through.

ffmpeg itself is faked: every command "succeeds" by writing its output file, and
individual tests make chosen commands fail. That is enough to drive the real
`render()` — segmenting, narration, the shot loop, the stitch and the cleanup —
and to assert what a failed render leaves behind and what a retry then does.
"""

import json
import os

import pytest

from app.video import ffmpeg as F
from app.video.options import RenderOptions
from app.video.renderer import render


class FakeFFmpeg:
    def __init__(self, monkeypatch, *, fail_when=None):
        self.calls = []
        self.fail_when = fail_when
        monkeypatch.setattr(F, "ffmpeg_available", lambda: True)
        monkeypatch.setattr(F, "available_filters",
                            lambda: frozenset({"xfade", "concat", "zoompan", "subtitles"}))
        monkeypatch.setattr(F, "probe_duration", lambda path: 2.0)
        monkeypatch.setattr(F, "probe_has_audio", lambda path: False)
        monkeypatch.setattr(F, "run", self.run)

    def run(self, argv, *, cwd=None, timeout=0):
        self.calls.append(list(argv))
        if self.fail_when and self.fail_when(argv):
            raise F.FFmpegError("ffmpeg failed (killed by signal 9 (most likely out of memory))")
        open(os.path.join(cwd or ".", argv[-1]), "wb").write(b"out")

    def encodes(self):
        return [c for c in self.calls if os.path.basename(c[-1]).startswith("shot_")
                and c[-1].endswith(".mp4")]

    def stitched(self, kind):
        return [c for c in self.calls if c[-1] == "stitched.mp4"
                and ("xfade" in " ".join(c)) == (kind == "xfade")]


def _stitch(argv):
    return argv[-1] == "stitched.mp4"


def _xfade(argv):
    return _stitch(argv) and "xfade" in " ".join(argv)


def _note(media):
    for name in ("a.png", "b.png"):
        (media / "u1").mkdir(exist_ok=True)
        if not (media / "u1" / name).exists():  # a retry sees the same files, same mtime
            (media / "u1" / name).write_bytes(b"x")
    text = lambda t: [{"type": "text", "text": t}]
    return json.dumps([
        {"id": "1", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "2", "type": "paragraph", "content": text("First picture, first words.")},
        {"id": "3", "type": "image", "props": {"url": "/media/u1/b.png"}},
        {"id": "4", "type": "paragraph", "content": text("Second picture, second words.")},
    ])


def _render(media, *, job_id, options):
    return render(
        job_id=job_id, user_id="u1", media_dir=str(media), note_content=_note(media),
        note_title="Note", author="", options=options, preview=True,
        tts=lambda text: b"audio", progress=lambda *a: None,
        max_shots=50, max_narration_chars=100_000,
    )


def _options(style):
    return RenderOptions(title_card=False, transition={"style": style, "duration": 0.5})


def test_a_failed_crossfade_stitch_falls_back_to_cuts(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch, fail_when=_xfade)
    result = _render(tmp_path, job_id="j1", options=_options("circleopen"))

    assert ff.stitched("xfade"), "the blend should have been attempted first"
    assert ff.stitched("concat"), "and then replaced by a plain join"
    assert any("straight cuts" in w for w in result.warnings)
    assert os.path.isfile(tmp_path / "u1" / result.video_filename)


def test_a_failed_render_keeps_its_encoded_segments_and_a_retry_reuses_them(tmp_path, monkeypatch):
    # The stitch dies for good: neither the blend nor the cuts fallback works.
    ff = FakeFFmpeg(monkeypatch, fail_when=_stitch)
    with pytest.raises(F.FFmpegError):
        _render(tmp_path, job_id="j1", options=_options("circleopen"))
    first_encodes = len(ff.encodes())
    assert first_encodes == 2
    assert not (tmp_path / "_video_work" / "j1").exists(), "scratch is still cleaned up"
    assert len(os.listdir(tmp_path / "_video_cache" / "u1")) == 2

    # A retry is a new job, and here a different transition — the segments are
    # the same, so none of them should be encoded again.
    ff = FakeFFmpeg(monkeypatch)
    result = _render(tmp_path, job_id="j2", options=_options("none"))
    assert ff.encodes() == []
    assert ff.stitched("concat")
    assert os.path.isfile(tmp_path / "u1" / result.video_filename)
    # ...and once they are inside a finished video, the cached copies go.
    assert os.listdir(tmp_path / "_video_cache" / "u1") == []


def test_a_change_that_reaches_the_segments_is_not_served_from_the_cache(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch, fail_when=_stitch)
    with pytest.raises(F.FFmpegError):
        _render(tmp_path, job_id="j1", options=_options("none"))

    # A dip is drawn inside each shot, so its filtergraph — and its encode —
    # differs from a plain cut. Reusing the old one would be wrong.
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, job_id="j2", options=_options("fade"))
    assert len(ff.encodes()) == 2


def test_a_plain_fallback_warning_is_repeated_when_the_segment_is_reused(tmp_path, monkeypatch):
    def fail_drift(argv):
        # The first attempt at every shot fails; the plainer retry has no zoompan.
        return argv[-1].startswith("shot_") and "zoompan" in " ".join(argv)

    options = RenderOptions(title_card=False, ken_burns={"effect": "zoom_in"},
                            transition={"style": "none"})
    ff = FakeFFmpeg(monkeypatch, fail_when=lambda a: fail_drift(a) or _stitch(a))
    with pytest.raises(F.FFmpegError):
        _render(tmp_path, job_id="j1", options=options)

    ff = FakeFFmpeg(monkeypatch)
    result = _render(tmp_path, job_id="j2", options=options)
    assert ff.encodes() == []
    assert sum("without motion or a waveform" in w for w in result.warnings) == 2
