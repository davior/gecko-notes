"""The VideoSpec round trip: `segment()` imports a note as a spec and compiles it
back to shots, and that must be exactly what the segmenter made of the note
before it went through a spec — the same shots, field for field, and the same
warnings — and must drive the renderer to the same ffmpeg commands.

The original walk is kept verbatim as the oracle (segment_reference.py). This is
Phase 0 of docs/gecko-video-creator.md: it proves the spec can describe
everything Notes already renders before anything is built on it. Nothing here
encodes video; ffmpeg is faked as in test_video_render_resume.
"""

import inspect
import json
import os
import random
import re
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlmodel import Session, SQLModel, create_engine

import test_video_segmenter as segmenter_cases
from segment_reference import segment as reference_segment
from test_video_render_resume import FakeFFmpeg

from app.models import Note
from app.routers import video as video_router
from app.schemas import VideoRenderRequest
from app.video import renderer
from app.video.compiler import IMPORT_ONLY_OPTIONS, UnsupportedSpec, compile_spec
from app.video.importer import import_note
from app.video.options import RenderOptions
from app.video.segmenter import segment
from app.video.spec import VideoSpec

DOC = Path(__file__).resolve().parents[2] / "docs" / "gecko-video-creator.md"


def _assert_same(content, **kwargs):
    want = reference_segment(content, **kwargs)
    got = segment(content, **kwargs)
    assert got.shots == want.shots
    assert got.warnings == want.warnings
    return got


def _round_trips_as_json(spec: VideoSpec) -> None:
    dumped = spec.model_dump_json(by_alias=True, exclude_none=True)
    assert VideoSpec.model_validate_json(dumped) == spec


# ── every case the segmenter's own tests already cover ──────────────────────

_SEGMENTER_CASES = sorted(
    name for name, fn in inspect.getmembers(segmenter_cases, inspect.isfunction)
    if name.startswith("test_")
)


def test_the_segmenter_suite_is_all_reused():
    # If that file grows a fixture argument, it would silently stop being run
    # below; this keeps the coverage honest.
    assert len(_SEGMENTER_CASES) >= 60
    for name in _SEGMENTER_CASES:
        assert not inspect.signature(getattr(segmenter_cases, name)).parameters, name


@pytest.mark.parametrize("name", _SEGMENTER_CASES)
def test_every_segmenter_case_compiles_back_to_the_same_shots(name, monkeypatch):
    calls = []

    def checked(content, **kwargs):
        calls.append(1)
        result = _assert_same(content, **kwargs)
        _round_trips_as_json(import_note(content, **kwargs).spec)
        return result

    monkeypatch.setattr(segmenter_cases, "segment", checked)
    case = getattr(segmenter_cases, name)
    case()
    if "_run(" in inspect.getsource(case) or "segment(" in inspect.getsource(case):
        assert calls, f"{name} never reached the patched segment()"


# ── a generated corpus, aimed at the walk's corners ─────────────────────────

_FILES = ("a.png", "b.png", "loud.mp4", "quiet.mp4", "intro.mp4", "outro.mp4", "song.mp3", "logo.png")


def _media_root(tmp_path):
    (tmp_path / "u1").mkdir(exist_ok=True)
    for name in _FILES:
        (tmp_path / "u1" / name).write_bytes(b"x")
    return str(tmp_path)


def _random_text(rng):
    words = ["salt", "road", "caravan", "dawn", "market", "well", "camel", "ruin"]
    text = " ".join(rng.choice(words) for _ in range(rng.randint(1, 6)))
    return rng.choice([
        text, text.capitalize() + ".", text + "...", text + " [pause]", "[pause:long]",
        text + " [pause:1.5s] " + text, "", "   ", text + "\n" + text, text + ":",
    ])


def _inline(rng, text):
    if rng.random() < 0.2:
        return [{"type": "link", "href": "https://example.com",
                 "content": [{"type": "text", "text": text}]}]
    return [{"type": "text", "text": text}]


def _random_block(rng, depth=0):
    choice = rng.choice([
        "paragraph", "paragraph", "paragraph", "heading", "heading", "quote", "quote",
        "codeBlock", "bulletListItem", "table", "image", "image", "video", "videoFile",
        "file", "diagram", "childNote", "audioFile", "divider",
    ])
    block = {"id": f"blk{rng.randint(0, 10**6)}", "type": choice}
    if choice in ("paragraph", "heading", "bulletListItem", "codeBlock"):
        block["content"] = _inline(rng, _random_text(rng))
    elif choice == "quote":
        body = _random_text(rng)
        body = rng.choice([
            body, f"{body} — Ibn Somebody", f"{body}\n- the guide", f"{body} - an old saying",
            f"{body} – 1971.", "[pause]", f"{body} -- unnamed source of very many words here",
        ])
        block["content"] = _inline(rng, body)
    elif choice == "table":
        block["content"] = {"rows": [{"cells": [_inline(rng, _random_text(rng)) for _ in range(2)]}
                                     for _ in range(rng.randint(0, 2))]}
    elif choice in ("image", "video", "videoFile", "file"):
        block["props"] = {"url": rng.choice([
            "/media/u1/a.png", "/media/u1/b.png", "/media/u1/loud.mp4", "/media/u1/quiet.mp4",
            "/media/u1/a.png?v=2", "/media/u1/missing.png", "/media/u2/a.png",
            "https://example.com/x.png", "/media/u1/notes.pdf", "",
        ])}
    elif choice == "diagram":
        block["id"] = rng.choice(["d1", "d2"])
    if depth < 2 and rng.random() < 0.15:
        block["children"] = [_random_block(rng, depth + 1) for _ in range(rng.randint(1, 3))]
    return block


def _random_options(rng):
    bumper = lambda name: rng.choice([
        {}, {"enabled": True, "url": f"/media/u1/{name}", "name": f"My {name}"},
        {"enabled": True, "url": "/media/u1/missing.mp4"}, {"enabled": True, "url": "/media/u1/a.png"},
        {"enabled": False, "url": f"/media/u1/{name}"},
    ])
    return RenderOptions(
        title_card=rng.random() < 0.5,
        chapter_screens=rng.random() < 0.4,
        read_chapters=rng.random() < 0.7,
        narrate_code=rng.random() < 0.5,
        heading_pause_ms=rng.choice([0, 800]),
        quotes={"enabled": rng.random() < 0.7},
        intro=bumper("intro.mp4"),
        outro=bumper("outro.mp4"),
        music=rng.choice([{}, {"enabled": True, "url": "/media/u1/song.mp3"}]),
        diagram_images=rng.choice([{}, {"d1": "/media/u1/b.png"}, {"d1": "/media/u1/gone.png"}]),
    )


def test_a_generated_corpus_compiles_back_to_the_same_shots(tmp_path):
    root = _media_root(tmp_path)
    rng = random.Random(20261015)
    for _ in range(3000):
        blocks = [_random_block(rng) for _ in range(rng.randint(0, 12))]
        kwargs = dict(
            user_id="u1", media_dir=root, options=_random_options(rng),
            note_title=rng.choice(["", "The Salt Road", "Road [pause:2s]"]),
            author=rng.choice(["", "gecko"]),
            has_audio=lambda path: os.path.basename(path) == "loud.mp4",
        )
        content = json.dumps(blocks)
        try:
            _assert_same(content, **kwargs)
        except AssertionError:
            pytest.fail(f"round trip differs for:\n{json.dumps(blocks, indent=1)}\n{kwargs['options']}")
        _round_trips_as_json(import_note(content, **kwargs).spec)


def test_unreadable_content_imports_as_an_empty_video(tmp_path):
    root = _media_root(tmp_path)
    for content in ("", "not json", "{}", "[1, null, \"x\"]"):
        _assert_same(content, user_id="u1", media_dir=root, options=RenderOptions())
        spec = import_note(content, user_id="u1", media_dir=root, options=RenderOptions()).spec
        assert spec.segments == [] and spec.audio_tracks == []


# ── the options survive the trip ────────────────────────────────────────────

_DISABLEABLE = ("waveform", "watermark", "overlay_text", "music")


def _effective(options: RenderOptions) -> dict:
    """What the renderer can tell apart. A disabled feature's settings are
    inert, and the import-only fields are recorded as structure instead."""
    data = options.model_dump(exclude=set(IMPORT_ONLY_OPTIONS))
    data["quotes"].pop("enabled")
    if options.music.enabled and not options.music.url:
        data["music"]["enabled"] = False
    for name in _DISABLEABLE:
        if not data[name]["enabled"]:
            data[name] = getattr(RenderOptions(), name).model_dump()
    return data


def _random_render_options(rng):
    return RenderOptions(
        aspect=rng.choice(["16:9", "9:16", "1:1"]), resolution=rng.choice(["720p", "1080p", "4k"]),
        quality=rng.choice(["preview", "standard", "high"]), fps=rng.choice([12, 24, 30, 60, 999]),
        fit=rng.choice(["blur", "pad", "crop"]),
        fallback=rng.choice([{}, {"type": "solid", "colors": ["#123456"]},
                             {"type": "image", "url": "/media/u1/a.png", "angle": 45},
                             {"type": "gradient", "url": "/media/u1/b.png"}]),
        waveform={"enabled": rng.random() < 0.5, "mode": rng.choice(["line", "point"]),
                  "height_pct": rng.randint(5, 60), "scrim": rng.random()},
        watermark={"enabled": rng.random() < 0.5, "url": rng.choice([None, "/media/u1/logo.png"]),
                   "text": rng.choice(["", "geckopico"]), "position": "top-left",
                   "scale_pct": rng.uniform(0, 40), "margin_pct": rng.randint(0, 9)},
        overlay_text={"enabled": rng.random() < 0.5, "mode": rng.choice(["fixed", "title", "title_chapter"]),
                      "text": "hello", "shadow": rng.random() < 0.5, "size_pct": rng.uniform(0, 25)},
        title_card_text={"title_pct": rng.uniform(0, 30)}, chapter_card_text={"subtitle_pct": 4.0},
        transition={"style": rng.choice(["none", "fade", "dissolve"]), "duration": rng.uniform(0, 4)},
        ken_burns={"effect": rng.choice(["none", "alternate", "pan_up"]), "amount": rng.uniform(0, 1),
                   "include_cards": rng.random() < 0.5},
        music=rng.choice([{}, {"enabled": True, "url": "/media/u1/song.mp3", "volume": 0.3,
                               "duck": False, "fade_in": 0.0, "fade_out": 20},
                          {"enabled": True}, {"enabled": False, "url": "/media/u1/song.mp3"}]),
        quotes={"enabled": rng.random() < 0.5, "position": "top", "accent": "#000000", "size_pct": 99},
        code={"position": "bottom", "scrim": 0.1},
        subtitles=rng.choice(["off", "sidecar", "soft", "burn"]),
        embed_chapters=rng.random() < 0.5, thumbnail=rng.random() < 0.5,
        voice=rng.choice([None, "flux-haley-en"]), speed=rng.uniform(0, 3),
        paragraph_pause_ms=rng.randint(0, 4000), heading_pause_ms=rng.randint(0, 6000),
        shot_end_pause_ms=rng.randint(0, 4000), min_shot_seconds=rng.uniform(0, 40),
        card_seconds=rng.uniform(0, 40),
    )


def test_render_options_survive_the_round_trip(tmp_path):
    root = _media_root(tmp_path)
    note = json.dumps([{"id": "1", "type": "image", "props": {"url": "/media/u1/a.png"}},
                       {"id": "2", "type": "paragraph", "content": [{"type": "text", "text": "Words."}]}])
    rng = random.Random(7)
    for _ in range(300):
        options = _random_render_options(rng)
        spec = import_note(note, user_id="u1", media_dir=root, options=options).spec
        compiled = compile_spec(spec, user_id="u1", media_dir=root).options
        assert _effective(compiled) == _effective(options)
        _round_trips_as_json(spec)


def test_bumpers_and_quotes_come_back_as_the_options_that_made_them(tmp_path):
    root = _media_root(tmp_path)
    options = RenderOptions(intro={"enabled": True, "url": "/media/u1/intro.mp4", "name": "Sting"},
                            quotes={"enabled": True})
    note = json.dumps([{"id": "1", "type": "quote",
                        "content": [{"type": "text", "text": "Worth its weight — A Trader"}]}])
    spec = import_note(note, user_id="u1", media_dir=root, options=options).spec
    compiled = compile_spec(spec, user_id="u1", media_dir=root).options
    assert compiled.intro == options.intro
    assert compiled.quotes.enabled
    assert spec.assets[spec.segments[0].visual.asset].label == "Sting"


# ── the renderer can't tell the difference ──────────────────────────────────

def _render_commands(monkeypatch, media, content, options, *, via_spec):
    ff = FakeFFmpeg(monkeypatch)
    monkeypatch.setattr(renderer.F, "probe_has_audio", lambda path: path.endswith("loud.mp4"))
    if via_spec:
        imported = import_note(content, user_id="u1", media_dir=media, options=options,
                               note_title="Salt", author="gecko",
                               has_audio=lambda path: path.endswith("loud.mp4"))
        compiled = compile_spec(imported.spec, user_id="u1", media_dir=media)
        plan = compiled.segmentation
        plan.warnings[:0] = imported.warnings
        monkeypatch.setattr(renderer, "segment", lambda *a, **k: plan)
        options = compiled.options
    else:
        # The original walk, with the options as given: how Notes rendered
        # before segment() went through a spec.
        monkeypatch.setattr(renderer, "segment", reference_segment)
    result = renderer.render(
        job_id="j", user_id="u1", media_dir=media, note_content=content,
        note_title="Salt", author="gecko", options=options, preview=True,
        tts=lambda text: b"audio", progress=lambda *a: None,
        max_shots=200, max_narration_chars=100_000,
    )
    monkeypatch.undo()
    # Output names are random per render; everything else must match exactly.
    hexes = {result.video_filename.split(".")[0]}
    return [[re.sub("|".join(hexes), "OUT", arg) for arg in call] for call in ff.calls], result.warnings


_RENDER_NOTE = json.dumps([
    {"id": "1", "type": "paragraph", "content": [{"type": "text", "text": "Before any picture."}]},
    {"id": "2", "type": "heading", "content": [{"type": "text", "text": "The road [pause]"}]},
    {"id": "3", "type": "image", "props": {"url": "/media/u1/a.png"}},
    {"id": "4", "type": "paragraph", "content": [{"type": "text", "text": "Under the map."}]},
    {"id": "4a", "type": "heading", "content": [{"type": "text", "text": "The market"}]},
    {"id": "4b", "type": "paragraph", "content": [{"type": "text", "text": "Stalls of salt."}]},
    {"id": "5", "type": "quote", "content": [{"type": "text", "text": "Salt was gold — A Trader"}]},
    {"id": "6", "type": "paragraph", "content": [{"type": "text", "text": "After the quote."}]},
    {"id": "7", "type": "videoFile", "props": {"url": "/media/u1/loud.mp4"}},
    {"id": "8", "type": "paragraph", "content": [{"type": "text", "text": "Over the clip, muted."}]},
    {"id": "9", "type": "codeBlock", "content": [{"type": "text", "text": "print('salt')"}]},
    {"id": "10", "type": "heading", "content": [{"type": "text", "text": "Ruins"}]},
    {"id": "11", "type": "image", "props": {"url": "/media/u1/missing.png"}},
    {"id": "12", "type": "paragraph", "content": [{"type": "text", "text": "Nothing left."}]},
])


@pytest.mark.parametrize("overrides", [
    {},
    {"chapter_screens": True, "read_chapters": False, "narrate_code": True},
    # Ken Burns is left to the options round trip above: a drifting still is
    # prescaled to ~24 megapixels with Pillow, which costs seconds per shot here.
    {"transition": {"style": "dissolve", "duration": 0.5},
     "waveform": {"enabled": True}, "subtitles": "burn"},
    {"intro": {"enabled": True, "url": "/media/u1/intro.mp4"},
     "outro": {"enabled": True, "url": "/media/u1/outro.mp4"},
     "music": {"enabled": True, "url": "/media/u1/song.mp3"},
     "watermark": {"enabled": True, "url": "/media/u1/logo.png"},
     "overlay_text": {"enabled": True, "mode": "title_chapter"},
     "fallback": {"type": "image", "url": "/media/u1/b.png"}},
    {"watermark": {"enabled": False, "url": "/media/u1/logo.png", "text": "hidden"},
     "music": {"enabled": False, "url": "/media/u1/song.mp3"}, "transition": {"style": "fade"}},
])
def test_the_renderer_issues_the_same_ffmpeg_commands_either_way(tmp_path, monkeypatch, overrides):
    media = _media_root(tmp_path)
    options = RenderOptions(quotes={"enabled": True}, **overrides)
    want = _render_commands(monkeypatch, media, _RENDER_NOTE, options, via_spec=False)
    got = _render_commands(monkeypatch, media, _RENDER_NOTE, options, via_spec=True)
    assert got == want
    assert len(want[0]) > 5


def test_a_heading_partway_through_a_section_is_joined_by_a_straight_cut(tmp_path, monkeypatch):
    """Over the same picture a dip to black and back would show nothing changing."""
    media = _media_root(tmp_path)
    options = RenderOptions(quotes={"enabled": True}, transition={"style": "fade"})
    calls, _warnings = _render_commands(monkeypatch, media, _RENDER_NOTE, options, via_spec=True)
    graphs = [call[call.index("-filter_complex") + 1] for call in calls
              if call[-1].startswith("shot_")]
    no_in = [i for i, graph in enumerate(graphs) if "fade=t=in" not in graph]
    no_out = [i for i, graph in enumerate(graphs) if "fade=t=out" not in graph]
    assert len(no_in) == 1 and no_out == [no_in[0] - 1]


def test_music_switched_on_with_no_track_is_not_part_of_the_video(tmp_path, monkeypatch):
    # The one thing the trip deliberately drops. A spec's music is a track, and
    # a track names its file, so "music on, nothing chosen" has no spec form:
    # the video is identical, and only the renderer's note that it skipped the
    # music goes. Notes itself still renders from the original options.
    media = _media_root(tmp_path)
    options = RenderOptions(music={"enabled": True})
    want_calls, want_warnings = _render_commands(monkeypatch, media, _RENDER_NOTE, options, via_spec=False)
    got_calls, got_warnings = _render_commands(monkeypatch, media, _RENDER_NOTE, options, via_spec=True)
    assert got_calls == want_calls
    assert want_warnings == got_warnings + ["Background music was skipped: that track could not be read."]


# ── what a spec says, and what the Notes renderer refuses ───────────────────

def test_the_worked_example_in_the_design_doc_is_a_valid_spec():
    example = re.findall(r"```json\n(.*?)```", DOC.read_text(), re.S)[0]
    spec = VideoSpec.model_validate_json(example)
    assert [s.kind for s in spec.segments] == ["card", "clip", "scene", "scene", "scene", "scene", "clip"]
    _round_trips_as_json(spec)
    with pytest.raises(UnsupportedSpec, match="Gecko Video Creator"):
        compile_spec(spec, user_id="u1", media_dir="/nowhere")


def test_a_quote_is_an_overlay_on_its_own_beat_not_a_segment(tmp_path):
    root = _media_root(tmp_path)
    note = json.dumps([
        {"id": "img", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "p1", "type": "paragraph", "content": [{"type": "text", "text": "Before"}]},
        {"id": "q1", "type": "quote", "content": [{"type": "text", "text": "Salt is gold — A Trader"}]},
        {"id": "p2", "type": "paragraph", "content": [{"type": "text", "text": "After"}]},
    ])
    spec = import_note(note, user_id="u1", media_dir=root, note_id="n1",
                       options=RenderOptions(title_card=False, quotes={"enabled": True})).spec
    assert spec.source.note_id == "n1"
    [scene] = spec.segments
    assert [(b.id, b.kind, b.text) for b in scene.beats] == [
        ("b1", "prose", "Before."), ("b2", "quote", "Salt is gold."), ("b3", "prose", "After."),
    ]
    [quote] = scene.overlays
    assert (quote.type, quote.text, quote.attribution) == ("quote", "Salt is gold", "A Trader")
    assert (quote.show.from_.beat, quote.show.to.beat) == ("b2", "b2")
    assert scene.source.block_ids == ["img", "p1", "q1", "p2"]
    assert [b.block_id for b in scene.beats] == ["p1", "q1", "p2"]


def test_a_section_taken_over_by_a_quote_or_code_keeps_its_blocks(tmp_path):
    # The quote or code block replaces a section that had nothing to say, but
    # it is drawn over that section's picture, so the picture's block is still
    # where the segment came from. Re-sync relies on every block being found.
    root = _media_root(tmp_path)
    text = lambda t: [{"type": "text", "text": t}]
    note = json.dumps([
        {"id": "img-a", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "p1", "type": "paragraph", "content": text("Under a.")},
        {"id": "img-b", "type": "image", "props": {"url": "/media/u1/b.png"}},
        {"id": "q1", "type": "quote", "content": text("Salt is gold")},
        {"id": "p2", "type": "paragraph", "content": text("After.")},
        {"id": "img-c", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "c1", "type": "codeBlock", "content": text("print(1)")},
        {"id": "img-d", "type": "image", "props": {"url": "/media/u1/a.png"}},
    ])
    spec = import_note(note, user_id="u1", media_dir=root,
                       options=RenderOptions(title_card=False, quotes={"enabled": True})).spec
    assert [s.source.block_ids for s in spec.segments] == [
        ["img-a", "p1"], ["img-b", "q1", "p2"], ["img-c", "c1", "img-d"],
    ]


def _spec(**changes):
    base = {
        "assets": {"a1": {"from": "notes", "url": "/media/u1/a.png", "type": "image"},
                   "g1": {"from": "gam", "id": "abc"}},
        "segments": [{"id": "s1", "kind": "scene", "visual": {"asset": "a1"},
                      "narration": {"beats": [{"id": "b1", "text": "One."}, {"id": "b2", "text": "Two."}]}}],
    }
    base.update(changes)
    return VideoSpec.model_validate(base)


@pytest.mark.parametrize("change, message", [
    ({"segments": [{"id": "s1", "kind": "scene", "visual": {"asset": "g1"}}]}, "not a file in the note"),
    ({"segments": [{"id": "s1", "kind": "scene", "transition_in": {"style": "fade"}}]}, "transition_in"),
    ({"segments": [{"id": "s1", "kind": "scene", "visual": {"asset": "a1", "trim": {"in": 1}}}]}, "trimmed"),
    ({"segments": [{"id": "s1", "kind": "scene", "narration": {"beats": [{"id": "b1", "text": "x"}]},
                    "overlays": [{"id": "o1", "type": "lower_third", "title": "Guide"}]}]}, "lower_third"),
    ({"segments": [{"id": "s1", "kind": "scene", "narration": {"beats": [{"id": "b1", "text": "x"}]},
                    "overlays": [{"id": "o1", "type": "quote", "text": "x"}]}]}, "exactly one of its beats"),
    ({"voice": {"provider": "fal"}}, "voice.provider"),
    ({"audio_tracks": [{"id": "t1", "asset": "a1", "start": "video_start", "end": "video_end"}]},
     "audio file"),
    ({"assets": {"a1": {"from": "notes", "url": "/media/u1/a.mp3", "type": "audio"}}},
     "can't be an audio file"),
    ({"chrome": {"watermark": {"asset": "v1"}},
      "assets": {"a1": {"from": "notes", "url": "/media/u1/a.png", "type": "image"},
                 "v1": {"from": "notes", "url": "/media/u1/v.mp4", "type": "video"}}},
     "watermark: must be an image"),
    ({"assets": {"a1": {"from": "notes", "url": "/media/u1/a.png", "type": "image"},
                 "v1": {"from": "notes", "url": "/media/u1/v.mp4", "type": "video"}},
      "segments": [{"id": "s1", "kind": "scene", "visual": {"asset": "a1"}},
                   {"id": "s2", "kind": "clip", "role": "intro", "visual": {"asset": "v1", "audio": "play"}}]},
     "intro can only be the first"),
    ({"assets": {"a1": {"from": "notes", "url": "/media/u1/a.png", "type": "image"},
                 "m1": {"from": "notes", "url": "/media/u1/m.mp3", "type": "audio"}},
      "audio_tracks": [{"id": "t1", "asset": "m1", "start": {"segment": "gone", "edge": "start"},
                        "end": {"segment": "s1", "edge": "end"}}]},
     "segment 'gone', which is no longer there"),
    ({"segments": [{"id": "s1", "kind": "scene", "narration": {"beats": [{"id": "b1", "text": "x"}]},
                    "overlays": [{"id": "o1", "type": "quote", "text": "x",
                                  "show": {"from": {"beat": "b9", "edge": "start"},
                                           "to": {"beat": "b9", "edge": "end"}}}]}]},
     "beat 'b9', which is no longer there"),
])
def test_what_the_notes_renderer_cannot_draw_is_refused(change, message):
    with pytest.raises(UnsupportedSpec, match=message):
        compile_spec(_spec(**change), user_id="u1", media_dir="/nowhere")


@pytest.mark.parametrize("change, message", [
    ({"segments": [{"id": "s1", "kind": "scene"}, {"id": "s1", "kind": "scene"}]}, "duplicate segment"),
    ({"segments": [{"id": "s1", "kind": "scene", "visual": {"asset": "nope"}}]}, "unknown asset"),
    ({"segments": [{"id": "s1", "kind": "card"}]}, "card with no card"),
    ({"segments": [{"id": "s1", "kind": "clip"}]}, "clip with no visual"),
    ({"segments": [{"id": "s1", "kind": "scene", "colour": "red"}]}, "Extra inputs"),
    # A misspelt key inside a nested setting is refused too, not quietly
    # dropped in favour of the default.
    ({"style": {"transition": {"styl": "dissolve"}}}, "Extra inputs"),
    ({"style": {"cards": {"title": {"title_size": 9}}}}, "Extra inputs"),
    ({"style": {"code": {"positon": "top"}}}, "Extra inputs"),
    ({"segments": [{"id": "s1", "kind": "scene", "transition_in": {"duraton": 2}}]}, "Extra inputs"),
    # The tag is what says which kind of asset or overlay this is.
    ({"assets": {"a1": {"url": "/media/u1/a.png", "type": "image"}}}, "discriminator"),
])
def test_a_malformed_spec_is_rejected(change, message):
    with pytest.raises(ValidationError, match=message):
        _spec(**change)


def test_a_spec_dumps_in_its_own_spelling_and_compact_dumps_load_back(tmp_path):
    root = _media_root(tmp_path)
    note = json.dumps([
        {"id": "img", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "q1", "type": "quote", "content": [{"type": "text", "text": "Salt is gold"}]},
    ])
    spec = import_note(note, user_id="u1", media_dir=root,
                       options=RenderOptions(quotes={"enabled": True})).spec
    assert '"from":"notes"' in spec.model_dump_json() and "from_" not in spec.model_dump_json()
    for compact in (dict(exclude_defaults=True), dict(exclude_unset=True), dict(exclude_none=True)):
        assert VideoSpec.model_validate(spec.model_dump(**compact)) == spec, compact
    schema = VideoSpec.model_json_schema()["$defs"]
    assert "from" in schema["NotesAsset"]["required"] and "type" in schema["QuoteOverlay"]["required"]


def test_a_heading_that_is_not_read_still_belongs_to_its_section(tmp_path):
    root = _media_root(tmp_path)
    text = lambda t: [{"type": "text", "text": t}]
    note = json.dumps([
        {"id": "img", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "h1", "type": "heading", "content": text("The market")},
        {"id": "q1", "type": "quote", "content": text("Salt is gold")},
        {"id": "img2", "type": "image", "props": {"url": "/media/u1/b.png"}},
        {"id": "h2", "type": "heading", "content": text("Ruins")},
        {"id": "p1", "type": "paragraph", "content": text("Nothing left.")},
    ])
    spec = import_note(note, user_id="u1", media_dir=root, options=RenderOptions(
        title_card=False, read_chapters=False, quotes={"enabled": True})).spec
    first, second = spec.segments
    assert first.source.block_ids == ["img", "h1", "q1"]
    assert second.source.block_ids == ["img2", "h2", "p1"]
    # The picture held in silence before the quote says which picture it is.
    assert (first.beats[0].text, first.beats[0].speak, first.beats[0].block_id) == ("", False, "img")


def test_a_clip_whose_file_has_gone_is_skipped_not_left_without_a_picture(tmp_path):
    root = _media_root(tmp_path)
    note = json.dumps([
        {"id": "v", "type": "videoFile", "props": {"url": "/media/u1/loud.mp4"}},
        {"id": "p", "type": "paragraph", "content": [{"type": "text", "text": "After the clip."}]},
    ])
    spec = import_note(note, user_id="u1", media_dir=root, options=RenderOptions(title_card=False),
                       has_audio=lambda path: True).spec
    assert [s.kind for s in spec.segments] == ["clip", "scene"]
    os.remove(os.path.join(root, "u1", "loud.mp4"))
    plan = compile_spec(spec, user_id="u1", media_dir=root).segmentation
    assert [s.kind for s in plan.shots] == ["still"]
    assert plan.warnings == ["Skipped missing media: /media/u1/loud.mp4"]


def test_a_heading_partway_through_a_section_is_a_segment_that_cuts_in(tmp_path):
    root = _media_root(tmp_path)
    note = json.dumps([
        {"id": "img", "type": "image", "props": {"url": "/media/u1/a.png"}},
        {"id": "p1", "type": "paragraph", "content": [{"type": "text", "text": "Under the map."}]},
        {"id": "h", "type": "heading", "content": [{"type": "text", "text": "The market"}]},
        {"id": "p2", "type": "paragraph", "content": [{"type": "text", "text": "Stalls of salt."}]},
    ])
    spec = import_note(note, user_id="u1", media_dir=root,
                       options=RenderOptions(title_card=False, read_chapters=False)).spec
    first, second = spec.segments
    assert (second.kind, second.chapter, second.visual.asset) == ("scene", "The market", first.visual.asset)
    assert first.transition_in is None and second.transition_in.style == "none"
    # The heading isn't read, but it is where the second segment came from.
    assert first.source.block_ids == ["img", "p1"]
    assert second.source.block_ids == ["h", "p2"]
    shots = compile_spec(spec, user_id="u1", media_dir=root).segmentation.shots
    assert [s.cut_in for s in shots] == [False, True]


def test_a_chapter_written_into_a_spec_is_drawn_without_its_markers(tmp_path):
    """The importer strips them; a spec written by hand, or by the AI, may not."""
    spec = _spec(segments=[{"id": "s1", "kind": "scene", "chapter": "Salt [pause:1s]",
                            "visual": {"asset": "a1"},
                            "narration": {"beats": [{"id": "b1", "text": "One."}]}}])
    plan = compile_spec(spec, user_id="u1", media_dir=_media_root(tmp_path)).segmentation
    assert [s.chapter for s in plan.shots] == ["Salt"]


# ── POST /api/video/spec ─────────────────────────────────────────────────────

_SPEC_NOTE = [
    {"id": "img", "type": "image", "props": {"url": "/media/u1/a.png"}},
    {"id": "p1", "type": "paragraph", "content": [{"type": "text", "text": "Under the map."}]},
    {"id": "q1", "type": "quote", "content": [{"type": "text", "text": "Salt is gold \u2014 A Trader"}]},
]


@pytest.fixture
def notes(tmp_path, monkeypatch):
    monkeypatch.setattr(video_router, "MEDIA_DIR", _media_root(tmp_path))
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        now = datetime.utcnow()
        for note_id, owner in (("mine", "u1"), ("theirs", "u2")):
            session.add(Note(id=note_id, title="Salt", content=json.dumps(_SPEC_NOTE),
                             category_id="cat-1", user_id=owner, created_at=now, modified_at=now))
        session.commit()
        yield session


def _spec_route(session, note_id="mine", **fields):
    payload = VideoRenderRequest(note_id=note_id, **fields)
    request = SimpleNamespace(state=SimpleNamespace(user_id="u1"))
    return video_router.video_spec(payload, request, session).data


def test_the_spec_route_returns_the_note_as_a_spec(notes):
    data = _spec_route(notes, options={"title_card": False, "quotes": {"enabled": True}})
    spec = VideoSpec.model_validate(data.spec)
    assert spec.source.note_id == "mine"
    assert spec.source.imported_at and not spec.source.selection
    assert spec.title == "Salt"
    [scene] = spec.segments
    assert [b.block_id for b in scene.beats] == ["p1", "q1"]
    assert scene.overlays[0].attribution == "A Trader"
    assert data.spec["assets"][scene.visual.asset]["from"] == "notes"
    assert data.warnings == []


def test_the_spec_route_shapes_the_spec_as_a_render_would(notes):
    selection = json.dumps(_SPEC_NOTE[2:])
    data = _spec_route(notes, options={"title_card": True}, selected_content=selection)
    spec = VideoSpec.model_validate(data.spec)
    assert spec.source.selection
    assert [s.kind for s in spec.segments] == ["card", "scene"]
    assert spec.segments[0].card.title == "Salt"
    # Quotes are off by default, so the quotation is read as plain prose.
    assert spec.segments[1].overlays == []


def test_the_spec_route_refuses_another_users_note_and_bad_options(notes):
    with pytest.raises(HTTPException) as missing:
        _spec_route(notes, note_id="theirs")
    assert missing.value.status_code == 404
    with pytest.raises(HTTPException) as invalid:
        _spec_route(notes, options={"aspect": "4:3"})
    assert invalid.value.status_code == 400


def test_the_spec_route_survives_half_of_a_deleted_emoji(notes):
    # JSON.stringify writes a lone surrogate as \ud83d; decoded, it is a valid
    # Python string but not valid UTF-8, so the response could not be encoded.
    note = notes.get(Note, "mine")
    note.content = json.dumps([
        {"id": "p", "type": "paragraph", "content": [{"type": "text", "text": "Hi \ud83d there \U0001f98e"}]},
    ])
    notes.add(note)
    notes.commit()
    data = _spec_route(notes, options={"title_card": False})
    encoded = json.dumps(data.model_dump(), ensure_ascii=False).encode("utf-8")
    assert "Hi \ufffd there \U0001f98e." in encoded.decode("utf-8")

