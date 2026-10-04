"""Intro and outro clips, driven through the real `render()`.

ffmpeg is faked the way test_video_render_resume.py fakes it: every command
"succeeds" by writing its output file, and the argv is kept so the tests can
read what each step was asked to do. Durations are probed from a table so the
timeline arithmetic — where the music starts and stops, where the poster frame
is taken — comes out at numbers worth asserting.
"""

import json
import os

from app.video import ffmpeg as F
from app.video.options import RenderOptions
from app.video.renderer import render

INTRO_SECONDS = 3.0
OUTRO_SECONDS = 4.0
STITCHED_SECONDS = 20.0


class FakeFFmpeg:
    def __init__(self, monkeypatch):
        self.calls = []
        self.chapters = ""
        monkeypatch.setattr(F, "ffmpeg_available", lambda: True)
        monkeypatch.setattr(F, "available_filters", lambda: frozenset(
            {"xfade", "concat", "zoompan", "subtitles", "showwaves", "sidechaincompress"}))
        monkeypatch.setattr(F, "probe_duration", self.probe_duration)
        monkeypatch.setattr(F, "probe_has_audio", lambda path: "intro" in path)
        monkeypatch.setattr(F, "run", self.run)

    @staticmethod
    def probe_duration(path):
        name = os.path.basename(path)
        if name.startswith("intro"):
            return INTRO_SECONDS
        if name.startswith("outro"):
            return OUTRO_SECONDS
        if name == "stitched.mp4":
            return STITCHED_SECONDS
        return 2.0

    def run(self, argv, *, cwd=None, timeout=0):
        self.calls.append(list(argv))
        if "chapters.ffmeta" in argv:
            with open(os.path.join(cwd or ".", "chapters.ffmeta"), encoding="utf-8") as f:
                self.chapters = f.read()
        open(os.path.join(cwd or ".", argv[-1]), "wb").write(b"out")

    def encode_of(self, clip):
        return next(c for c in self.calls if os.path.basename(c[-1]).startswith("shot_")
                    and any(a.endswith(clip) for a in c))

    def body_encodes(self):
        return [c for c in self.calls if os.path.basename(c[-1]).startswith("shot_")
                and not any(a.endswith(("intro.mp4", "outro.mp4")) for a in c)]

    def command_writing(self, name):
        return next(c for c in self.calls if os.path.basename(c[-1]) == name)


def _graph(argv):
    return argv[argv.index("-filter_complex") + 1]


def _setup(media):
    user_dir = media / "u1"
    user_dir.mkdir(exist_ok=True)
    for name in ("intro.mp4", "outro.mp4", "a.png", "bed.mp3"):
        (user_dir / name).write_bytes(b"x")
    text = lambda t: [{"type": "text", "text": t}]
    return json.dumps([
        {"id": "1", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "2", "type": "paragraph", "content": text("The article itself.")},
    ])


def _options(**overrides):
    return RenderOptions(**{
        "title_card": False,
        "intro": {"enabled": True, "url": "/media/u1/intro.mp4", "name": "My intro.mp4"},
        "outro": {"enabled": True, "url": "/media/u1/outro.mp4", "name": "My outro.mp4"},
        **overrides,
    })


def _render(media, options):
    return render(
        job_id="j1", user_id="u1", media_dir=str(media), note_content=_setup(media),
        note_title="Note", author="", options=options, preview=True,
        tts=lambda text: b"audio", progress=lambda *a: None,
        max_shots=50, max_narration_chars=100_000,
    )


def test_the_intro_opens_the_video_and_the_outro_closes_it(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, _options())

    playlist = ff.command_writing("stitched.mp4")
    assert "shots.txt" in playlist
    encodes = [c[-1] for c in ff.calls if os.path.basename(c[-1]).startswith("shot_")]
    assert encodes == ["shot_0000.mp4", "shot_0001.mp4", "shot_0002.mp4"]
    assert ff.encode_of("intro.mp4")[-1] == "shot_0000.mp4"
    assert ff.encode_of("outro.mp4")[-1] == "shot_0002.mp4"


def test_a_bumper_plays_with_its_own_sound_or_with_silence(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, _options())

    # The intro has an audio track and keeps it; the outro has none and gets
    # silence in its place, exactly like a sounded clip in the note itself.
    assert "[0:a]" in _graph(ff.encode_of("intro.mp4"))
    assert "anullsrc" in " ".join(ff.encode_of("outro.mp4"))


def test_nothing_of_the_render_is_drawn_over_a_bumper(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, _options(
        watermark={"enabled": True, "text": "by me"},
        overlay_text={"enabled": True, "mode": "fixed", "text": "Channel"},
        waveform={"enabled": True},
    ))

    for clip in ("intro.mp4", "outro.mp4"):
        argv = ff.encode_of(clip)
        assert not any(a.endswith(".png") for a in argv), f"{clip} got an overlay input"
        assert "showwaves" not in _graph(argv)
    # ...while the article in between still gets all three.
    (body,) = ff.body_encodes()
    assert any(a.endswith(".png") and "overlay" in a for a in body)
    assert "showwaves" in _graph(body)


def test_the_title_chapter_overlay_never_follows_a_bumpers_chapter(tmp_path, monkeypatch):
    """An intro's "Intro" mark must not become the chapter line under the title."""
    ff = FakeFFmpeg(monkeypatch)
    drawn = []
    from app.video import compose
    real = compose.overlay_layer

    def spy(*args, chapter_line=None, **kwargs):
        drawn.append(chapter_line)
        return real(*args, chapter_line=chapter_line, **kwargs)

    monkeypatch.setattr(compose, "overlay_layer", spy)
    _render(tmp_path, _options(overlay_text={"enabled": True, "mode": "title_chapter"}))

    assert "Intro" not in drawn and "Outro" not in drawn
    assert ff.body_encodes()


def test_the_music_bed_scores_only_the_article(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, _options(
        music={"enabled": True, "url": "/media/u1/bed.mp3", "fade_in": 0, "fade_out": 0},
    ))

    graph = _graph(ff.command_writing("scored.mp4"))
    # It comes in when the intro ends and is cut where the outro begins.
    window = STITCHED_SECONDS - INTRO_SECONDS - OUTRO_SECONDS
    delay = int(INTRO_SECONDS * 1000)
    assert f"atrim=end={window:.3f},adelay={delay}|{delay},apad" in graph


def test_without_bumpers_the_music_bed_is_unchanged(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, RenderOptions(
        title_card=False, music={"enabled": True, "url": "/media/u1/bed.mp3"},
    ))

    graph = _graph(ff.command_writing("scored.mp4"))
    assert "atrim" not in graph and "adelay" not in graph


def test_a_crossfade_starts_the_music_as_the_intro_blends_away(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, _options(
        transition={"style": "dissolve", "duration": 0.5},
        music={"enabled": True, "url": "/media/u1/bed.mp3", "fade_in": 0, "fade_out": 0},
    ))

    assert ff.command_writing("stitched.mp4")[-1] == "stitched.mp4"
    graph = _graph(ff.command_writing("scored.mp4"))
    assert "adelay=2500|2500" in graph


def test_the_intro_and_outro_are_marked_as_chapters(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    _render(tmp_path, _options())

    titles = [line.split("=", 1)[1] for line in ff.chapters.splitlines()
              if line.startswith("title=")]
    assert titles[0] == "Intro" and titles[-1] == "Outro"


def test_the_poster_frame_is_taken_from_the_article_not_the_intro(tmp_path, monkeypatch):
    ff = FakeFFmpeg(monkeypatch)
    result = _render(tmp_path, _options())

    poster = ff.command_writing(result.thumbnail_filename)
    seek = float(poster[poster.index("-ss") + 1])
    assert seek == INTRO_SECONDS + 1.0
