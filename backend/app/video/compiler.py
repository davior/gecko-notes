"""VideoSpec -> the shots and options today's renderer consumes.

The renderer still works on a flat list of `Shot`s and one `RenderOptions`;
this is the step that produces them from a spec, so the renderer itself needs no
change while the spec becomes the thing that describes a video. A segment is not
always one shot: a quote or a code block is an overlay on one beat of a scene,
and the renderer draws those as a shot of their own, so a scene is split there.

Anything a spec can say that this renderer cannot do — GAM assets, timed
overlays, per-segment motion or voice, more than one music track — is refused
with `UnsupportedSpec` rather than quietly rendered differently. Those arrive
with Gecko Video Creator's own renderer (docs/gecko-video-creator.md §10).
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.video.options import (
    BackgroundSpec, BumperSpec, CardTextSpec, CodeSpec, KenBurnsSpec, MusicSpec,
    OverlayTextSpec, QuoteSpec, RenderOptions, TransitionSpec, WatermarkSpec, WaveformSpec,
)
from app.video.segmenter import (
    Segmentation, Shot, ShotKind, _set_apart, resolve_media_path,
)
from app.video.spec import (
    Anchor, AnchorRef, Beat, CodeOverlay, NotesAsset, QuoteOverlay, Segment, VideoSpec,
)

# RenderOptions fields that decide what a note is *imported* as rather than how
# it renders: whether there is a title card, whether headings become chapter
# screens, and so on. A spec records the outcome — the cards, the beats, the
# bumper segments — so they cannot be read back out of one, and the renderer
# never looks at them. Compiled options leave them at their defaults.
IMPORT_ONLY_OPTIONS = frozenset({
    "title_card", "chapter_screens", "read_chapters", "narrate_code",
    "insert_into_note", "diagram_images", "intro", "outro",
})


class UnsupportedSpec(ValueError):
    """The spec asks for something the Notes renderer cannot draw."""


@dataclass
class Compiled:
    segmentation: Segmentation
    options: RenderOptions
    # Shot index -> the id of the segment it came from, for diagnostics.
    shot_segments: List[str] = field(default_factory=list)


def narration_text(beats: List[Beat], *, card: bool, heading_pause_ms: int) -> str:
    """What a run of beats sounds like as one shot's narration.

    A heading inside a section is set apart with blank lines, which
    `chunk_narration` turns into the heading pause; a card is a section
    boundary of its own and needs no marking.
    """
    pieces: List[str] = []
    for beat in beats:
        if not beat.speak or not beat.text:
            continue
        text = beat.text
        if beat.kind == "heading" and not card and heading_pause_ms > 0:
            text = _set_apart(text)
        pieces.append(text)
    return "\n".join(pieces).strip()


def compile_spec(spec: VideoSpec, *, user_id: str, media_dir: str) -> Compiled:
    _refuse_unsupported(spec)
    warnings: List[str] = []
    shots: List[Shot] = []
    owners: List[str] = []
    paths: Dict[str, Optional[str]] = {}

    def resolve(key: str) -> Optional[str]:
        if key not in paths:
            asset = spec.assets[key]
            paths[key] = resolve_media_path(asset.url, user_id, media_dir)
            if paths[key] is None:
                warnings.append(f"Skipped missing media: {asset.url[:120]}")
        return paths[key]

    heading_ms = spec.voice.pauses.heading_ms
    for segment in spec.segments:
        made = _segment_shots(segment, spec, resolve, heading_ms)
        if made and segment.transition_in is not None:
            # Validated above to be "none": no transition into this segment.
            made[0].cut_in = True
        for shot in made:
            shots.append(shot)
            owners.append(segment.id)

    return Compiled(
        segmentation=Segmentation(shots=shots, warnings=warnings),
        options=_options(spec),
        shot_segments=owners,
    )


def _segment_shots(segment: Segment, spec: VideoSpec, resolve, heading_ms: int) -> List[Shot]:
    path = resolve(segment.visual.asset) if segment.visual is not None else None

    if segment.kind == "card":
        return [Shot(
            kind="card",
            card_title=segment.card.title,
            card_subtitle=segment.card.subtitle,
            card_kind=segment.card.variant,
            chapter=segment.chapter,
            narration=narration_text(segment.beats, card=True, heading_pause_ms=heading_ms),
            label=segment.label,
        )]

    if segment.kind == "clip":
        if path is None:
            # Its file has gone since the import: skipped, as the warning says,
            # since a sounded clip is nothing without its own picture and sound.
            return []
        bumper = segment.role if segment.role in ("intro", "outro") else None
        return [Shot(kind="video_sound", background=path, chapter=segment.chapter,
                     bumper=bumper, label=segment.label)]

    kind: ShotKind = "still"
    if path is not None and spec.assets[segment.visual.asset].type == "video":
        kind = "video_muted"

    # Split the beats where an overlay is: each overlaid beat is a shot of its
    # own, and the beats between them run together as one.
    overlay_at = {_overlay_beat(segment, o): o for o in segment.overlays}
    runs: List[Tuple[Optional[object], List[Beat]]] = []
    for beat in segment.beats:
        overlay = overlay_at.get(beat.id)
        if overlay is not None:
            runs.append((overlay, [beat]))
        elif runs and runs[-1][0] is None:
            runs[-1][1].append(beat)
        else:
            runs.append((None, [beat]))
    if not runs:
        runs.append((None, []))

    shots: List[Shot] = []
    for index, (overlay, beats) in enumerate(runs):
        if index == 0:
            label = segment.label
        elif overlay is not None:
            label = overlay.type
        else:
            label = f"after {runs[index - 1][0].type}"
        shots.append(Shot(
            kind=kind, background=path,
            narration=narration_text(beats, card=False, heading_pause_ms=heading_ms),
            quote_text=overlay.text if isinstance(overlay, QuoteOverlay) else None,
            quote_attribution=overlay.attribution if isinstance(overlay, QuoteOverlay) else None,
            code_text=overlay.text if isinstance(overlay, CodeOverlay) else None,
            # Built in, like every other drawn field, so pause markers in a
            # hand-written chapter are stripped too.
            chapter=segment.chapter if index == 0 else None,
            label=label,
        ))
    return shots


def _overlay_beat(segment: Segment, overlay) -> str:
    """The one beat an overlay spans. Anything else is a timed overlay."""
    show = overlay.show
    start = show.from_ if show is not None else None
    end = show.to if show is not None else None
    for anchor in (start, end):
        if (isinstance(anchor, AnchorRef) and anchor.beat is not None
                and not any(b.id == anchor.beat for b in segment.beats)):
            raise UnsupportedSpec(f"overlay {overlay.id!r} in segment {segment.id!r} is anchored "
                                  f"to beat {anchor.beat!r}, which is no longer there")
    if (isinstance(start, AnchorRef) and isinstance(end, AnchorRef)
            and start.beat is not None and start.beat == end.beat
            and start.edge == "start" and end.edge == "end"
            and not start.offset and not end.offset
            and start.segment in (None, segment.id) and end.segment in (None, segment.id)
            and any(b.id == start.beat for b in segment.beats)):
        return start.beat
    raise UnsupportedSpec(
        f"overlay {overlay.id!r} in segment {segment.id!r} must span exactly one of its beats"
    )


def _options(spec: VideoSpec) -> RenderOptions:
    style, chrome, voice = spec.style, spec.chrome, spec.voice

    def url(key: Optional[str]) -> Optional[str]:
        return spec.assets[key].url if key is not None else None

    options = RenderOptions(
        aspect=spec.output.aspect,
        resolution=spec.output.resolution,
        quality=spec.output.quality,
        fps=spec.output.fps,
        subtitles=spec.output.subtitles,
        embed_chapters=spec.output.chapters,
        thumbnail=spec.output.thumbnail,
        fit=style.fit,
        fallback=BackgroundSpec(
            type=style.background.type, colors=list(style.background.colors),
            angle=style.background.angle, url=url(style.background.asset),
        ),
        title_card_text=CardTextSpec(**style.cards.title.model_dump()),
        chapter_card_text=CardTextSpec(**style.cards.chapter.model_dump()),
        transition=TransitionSpec(**style.transition.model_dump()),
        ken_burns=KenBurnsSpec(effect=style.motion.effect, amount=style.motion.amount,
                               include_cards=style.cards.motion),
        quotes=QuoteSpec(
            enabled=any(isinstance(o, QuoteOverlay) for s in spec.segments for o in s.overlays),
            **style.quote.model_dump(),
        ),
        code=CodeSpec(**style.code.model_dump()),
        min_shot_seconds=style.min_segment_seconds,
        card_seconds=style.cards.seconds,
        voice=voice.voice,
        speed=voice.speed,
        paragraph_pause_ms=voice.pauses.paragraph_ms,
        heading_pause_ms=voice.pauses.heading_ms,
        shot_end_pause_ms=voice.pauses.segment_end_ms,
    )
    if chrome.watermark is not None:
        fields = chrome.watermark.model_dump(exclude={"asset"})
        options.watermark = WatermarkSpec(enabled=True, url=url(chrome.watermark.asset), **fields)
    if chrome.overlay_text is not None:
        options.overlay_text = OverlayTextSpec(enabled=True, **chrome.overlay_text.model_dump())
    if chrome.waveform is not None:
        options.waveform = WaveformSpec(enabled=True, **chrome.waveform.model_dump())
    for track in spec.audio_tracks:
        options.music = MusicSpec(
            enabled=True, url=url(track.asset), volume=track.volume,
            duck=track.duck_under_narration is not False,
            fade_in=track.fade_in, fade_out=track.fade_out,
        )
    for segment in spec.segments:
        if segment.role in ("intro", "outro"):
            asset = spec.assets[segment.visual.asset]
            setattr(options, segment.role,
                    BumperSpec(enabled=True, url=asset.url, name=asset.label or ""))
    return options


# ── what the Notes renderer cannot do ───────────────────────────────────────

def _refuse_unsupported(spec: VideoSpec) -> None:
    problems: List[str] = []
    used = {s.visual.asset for s in spec.segments if s.visual is not None}
    used |= {t.asset for t in spec.audio_tracks}
    for key in (spec.style.background.asset,
                spec.chrome.watermark.asset if spec.chrome.watermark else None):
        if key is not None:
            used.add(key)
    for key in sorted(used):
        if not isinstance(spec.assets[key], NotesAsset):
            problems.append(f"asset {key!r} is not a file in the note's media "
                            f"({spec.assets[key].from_} assets need Gecko Video Creator)")
    for where, key in (("style.background", spec.style.background.asset),
                       ("chrome.watermark", spec.chrome.watermark.asset if spec.chrome.watermark else None)):
        if key is not None and spec.assets[key].type != "image":
            problems.append(f"{where}: must be an image")
    if spec.voice.provider is not None or spec.voice.expressivity is not None:
        problems.append("voice.provider and voice.expressivity come from the account here")
    if spec.credits is not None:
        problems.append("credits")

    for segment in spec.segments:
        where = f"segment {segment.id!r}"
        bumper = segment.role in ("intro", "outro")
        if segment.transition_in is not None and segment.transition_in.style != "none":
            # A straight cut into one segment is all the renderer does per join.
            problems.append(f"{where}: per-segment transition_in")
        if segment.duration is not None:
            problems.append(f"{where}: duration overrides")
        if segment.chrome is not None and segment.chrome != (not bumper):
            problems.append(f"{where}: chrome is on for every segment but an intro or outro")
        if segment.role == "title" and segment.kind != "card":
            problems.append(f"{where}: only a card can be the title")
        if bumper and segment.kind != "clip":
            problems.append(f"{where}: an intro or outro must be a clip")
        if segment.narration is not None and segment.narration.voice is not None:
            problems.append(f"{where}: per-segment voice")
        for beat in segment.beats:
            if beat.hold is not None or beat.pause_after_ms is not None:
                problems.append(f"{where}: beat {beat.id!r} hold / pause_after_ms")
        visual = segment.visual
        if visual is not None:
            if visual.fit is not None or visual.motion is not None:
                problems.append(f"{where}: per-segment fit or motion")
            if visual.trim is not None:
                problems.append(f"{where}: trimmed clips")
            if not visual.loop:
                problems.append(f"{where}: a video that holds its last frame")
            if visual.audio != ("play" if segment.kind == "clip" else "mute"):
                problems.append(f"{where}: a clip plays its sound, a scene's video is muted")
        if segment.kind == "card" and visual is not None:
            problems.append(f"{where}: a card draws its own background")
        if segment.kind == "clip" and (segment.beats or segment.overlays):
            problems.append(f"{where}: a clip carries no narration or overlays")
        if segment.kind == "clip" and visual is not None and spec.assets[visual.asset].type != "video":
            problems.append(f"{where}: a clip must be a video")
        if segment.kind == "scene" and visual is not None and spec.assets[visual.asset].type == "audio":
            problems.append(f"{where}: a scene's picture can't be an audio file")
        if segment.kind == "card" and segment.overlays:
            problems.append(f"{where}: overlays on a card")
        anchored = []
        for overlay in segment.overlays:
            if not isinstance(overlay, (QuoteOverlay, CodeOverlay)):
                problems.append(f"{where}: {overlay.type} overlays")
            elif overlay.fade is not None:
                problems.append(f"{where}: overlay fades")
            else:
                try:
                    anchored.append(_overlay_beat(segment, overlay))
                except UnsupportedSpec as exc:
                    problems.append(str(exc))
        if len(anchored) != len(set(anchored)):
            problems.append(f"{where}: two overlays on one beat")

    # The renderer finds the intro and outro by position, to keep the music and
    # its drawing off them, so that is the only place either can be.
    roles = [s.role for s in spec.segments]
    if "intro" in roles[1:] or roles.count("intro") > 1:
        problems.append("an intro can only be the first segment")
    if "outro" in roles[:-1] or roles.count("outro") > 1:
        problems.append("an outro can only be the last segment")

    ids = {s.id for s in spec.segments}
    content = [s.id for s in spec.segments if s.role not in ("intro", "outro")]
    if len(spec.audio_tracks) > 1:
        problems.append("more than one audio track")
    for track in spec.audio_tracks:
        where = f"audio track {track.id!r}"
        if track.kind != "music":
            problems.append(f"{where}: only a music bed")
        if track.trim is not None or track.loop is False:
            problems.append(f"{where}: trim / loop off")
        if spec.assets[track.asset].type != "audio":
            problems.append(f"{where}: must be an audio file")
        for anchor in (track.start, track.end):
            if isinstance(anchor, AnchorRef) and anchor.segment not in ids:
                problems.append(f"{where}: anchored to segment {anchor.segment!r}, "
                                f"which is no longer there")
        if not content or not (_at(track.start, spec, content[0], "start")
                               and track.end is not None
                               and _at(track.end, spec, content[-1], "end")):
            problems.append(f"{where}: the music bed runs from the first section "
                            f"to the last, around any intro and outro")
    if problems:
        raise UnsupportedSpec("Not supported by the Notes renderer: " + "; ".join(problems))


def _at(anchor: Anchor, spec: VideoSpec, segment_id: str, edge: str) -> bool:
    """Whether `anchor` is exactly the `edge` of segment `segment_id`."""
    if isinstance(anchor, str):
        ids = [s.id for s in spec.segments]
        index = 0 if anchor == "video_start" else len(ids) - 1
        wanted = "start" if anchor == "video_start" else "end"
        return bool(ids) and ids[index] == segment_id and wanted == edge
    return (anchor.segment == segment_id and anchor.beat is None
            and anchor.edge == edge and not anchor.offset)
