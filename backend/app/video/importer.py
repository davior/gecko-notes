"""A note (BlockNote JSON) -> a VideoSpec.

This is the walk every render starts from: `segmenter.segment()` is
`compile_spec(import_note(...))`. It reads a note the way the segmenter always
has — every image or video a boundary, the text below it that section's
narration — but records more than shots: the text under a picture is kept as one
beat per block rather than one joined string, a quote or code block is an
overlay on its own beat rather than a shot of its own, and every segment and
beat remembers which blocks it came from.

The walk is the original segmenter's, step for step, quirks included, and
tests/test_video_spec.py holds it to a verbatim copy of that original
(tests/segment_reference.py). Anything the import decides — whether headings
become chapter screens, whether quotes are drawn — is settled here, from
`RenderOptions`, and the spec only records the outcome.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from app.video.compiler import compile_spec, narration_text
from app.video.options import RenderOptions
from app.video.pause_markup import strip_pause_markup
from app.video.segmenter import (
    Segmentation, ShotKind, _as_sentence, _block_narration, _classify, _flatten, _inline_text,
    _media_kind, _media_url, _split_attribution, resolve_media_path,
)
from app.video.spec import (
    AnchorRef, AudioTrack, Background, Beat, Card, CardText, Cards, Chrome, CodeOverlay,
    CodeStyle, Motion, Narration, NotesAsset, Output, OverlayText, Pauses, QuoteOverlay,
    QuoteStyle, Segment, SegmentSource, Span, SpecSource, Style, Transition, VideoSpec,
    Visual, Voice, Waveform, Watermark,
)


@dataclass
class ImportResult:
    spec: VideoSpec
    # Media the note references that could not be used, in document order.
    warnings: List[str] = field(default_factory=list)


@dataclass
class _Part:
    """One future shot, while the walk is still deciding what it holds."""

    kind: ShotKind
    media: Optional[Tuple[str, str]] = None   # (url, "image" | "video")
    media_label: Optional[str] = None         # a readable name, when the file has one
    path: Optional[str] = None                # resolved, for the cleanup passes
    label: str = ""
    beats: List[Beat] = field(default_factory=list)
    chapter: Optional[str] = None
    card: Optional[Card] = None
    role: Optional[str] = None
    overlay: Optional[Any] = None             # QuoteOverlay | CodeOverlay, not yet anchored
    block_ids: List[str] = field(default_factory=list)

    def narration(self, heading_pause_ms: int) -> str:
        return narration_text(self.beats, card=self.kind == "card",
                              heading_pause_ms=heading_pause_ms)

    def panel(self) -> bool:
        """Whether the compiled shot will carry quote_text or code_text."""
        if isinstance(self.overlay, CodeOverlay):
            return True
        if isinstance(self.overlay, QuoteOverlay):
            return bool(strip_pause_markup(self.overlay.text))
        return False


def import_note(
    content: str,
    *,
    user_id: str,
    media_dir: str,
    options: RenderOptions,
    note_title: str = "",
    author: str = "",
    has_audio: Optional[Callable[[str], Any]] = None,
    note_id: Optional[str] = None,
    imported_at: Optional[str] = None,
    selection: bool = False,
) -> ImportResult:
    """Same arguments as `segment()`, plus provenance: the note's id, when it was
    read, and whether `content` is only a selection of it."""
    warnings: List[str] = []
    parts, order = _walk(content, user_id=user_id, media_dir=media_dir, options=options,
                         note_title=note_title, author=author, has_audio=has_audio,
                         warnings=warnings)
    assets = _Assets()
    segments = _group(parts, assets, order)
    spec = VideoSpec(
        title=note_title,
        source=(SpecSource(note_id=note_id, imported_at=imported_at, selection=selection)
                if note_id or imported_at else None),
        output=Output(
            aspect=options.aspect, resolution=options.resolution, quality=options.quality,
            fps=options.fps, subtitles=options.subtitles, chapters=options.embed_chapters,
            thumbnail=options.thumbnail,
        ),
        voice=Voice(
            voice=options.voice, speed=options.speed,
            pauses=Pauses(paragraph_ms=options.paragraph_pause_ms,
                          heading_ms=options.heading_pause_ms,
                          segment_end_ms=options.shot_end_pause_ms),
        ),
        style=_style(options, assets),
        chrome=_chrome(options, assets),
        segments=segments,
        audio_tracks=_music(options, segments, assets),
        assets=assets.registry,
    )
    return ImportResult(spec=spec, warnings=warnings)


def segment_via_spec(
    content: str,
    *,
    user_id: str,
    media_dir: str,
    options: RenderOptions,
    note_title: str = "",
    author: str = "",
    has_audio: Optional[Callable[[str], Any]] = None,
) -> Segmentation:
    """What `segment()` returns: the note imported as a spec and compiled back to shots,
    with the import's warnings ahead of the compile's."""
    imported = import_note(content, user_id=user_id, media_dir=media_dir, options=options,
                           note_title=note_title, author=author, has_audio=has_audio)
    compiled = compile_spec(imported.spec, user_id=user_id, media_dir=media_dir)
    return Segmentation(shots=compiled.segmentation.shots,
                        warnings=imported.warnings + compiled.segmentation.warnings)


# ── the walk ──────────────────────────

def _walk(content, *, user_id, media_dir, options, note_title, author, has_audio,
          warnings) -> Tuple[List[_Part], Dict[str, int]]:
    parts: List[_Part] = []
    heading_ms = options.heading_pause_ms

    try:
        blocks = json.loads(content or "[]")
    except (ValueError, TypeError):
        blocks = []
    if not isinstance(blocks, list):
        blocks = []

    if options.title_card and (note_title or author):
        parts.append(_Part(
            kind="card",
            card=Card(variant="title", title=note_title or "Untitled", subtitle=author),
            chapter=note_title or None,
            label="title card",
        ))

    pending: List[Beat] = []
    # Blocks read in this section that leave no beat (a heading not read
    # aloud), recorded on whichever part the section's beats would go to.
    pending_blocks: List[str] = []
    open_part: Optional[_Part] = None
    pending_chapter: Optional[str] = None
    # How much had been said in the section when that heading came, so a
    # heading with nothing said after it is known to mark the next part.
    said_at_chapter = 0
    pending_card: Optional[_Part] = None

    def spoken() -> str:
        return narration_text(pending, card=False, heading_pause_ms=heading_ms)

    def flush(next_part: Optional[_Part]) -> Optional[str]:
        """Close the open section, and open `next_part`. Returns a chapter mark
        that was to start the next part when there is none to start: its
        heading wasn't read, and took no time where it stood."""
        nonlocal pending, pending_blocks, open_part, pending_chapter, pending_card
        text = spoken()
        carried_chapter: Optional[str] = None

        if open_part is None and text:
            open_part = _Part(kind="still", label="opening")
        holder = open_part if open_part is not None else next_part
        if holder is not None:
            holder.block_ids.extend(pending_blocks)
        pending_blocks = []
        if open_part is not None:
            open_part.beats = pending
            if pending_chapter and not open_part.chapter:
                open_part.chapter = pending_chapter
            elif (pending_chapter and not options.read_chapters
                    and len(pending) == said_at_chapter):
                # The section already has its mark, and this heading — not read,
                # with nothing said after it — takes no time here: its moment
                # is where the next part starts, so it marks that instead.
                carried_chapter = pending_chapter
            if pending_card is not None:
                parts.append(pending_card)
                pending_card = None
            parts.append(open_part)
        elif pending_card is not None:
            parts.append(pending_card)
            pending_card = None

        if pending_chapter and open_part is None:
            carried_chapter = pending_chapter
        pending = []
        pending_chapter = None
        open_part = next_part
        if carried_chapter and open_part is None:
            return carried_chapter
        if carried_chapter and not open_part.chapter:
            open_part.chapter = carried_chapter
        return None

    def carry(label: str, **extra: Any) -> _Part:
        """A part over whatever the interrupted section was showing."""
        kind: ShotKind = ("video_muted" if open_part is not None and open_part.kind.startswith("video")
                          else "still")
        if open_part is None:
            return _Part(kind=kind, label=label, **extra)
        return _Part(kind=kind, media=open_part.media, path=open_part.path, label=label, **extra)

    flat = _flatten(blocks)
    order = {b["id"]: i for i, b in enumerate(flat) if isinstance(b.get("id"), str)}
    for block in flat:
        kind = _classify(block, options)
        block_id = block.get("id") if isinstance(block.get("id"), str) else None

        if kind is None:
            btype = block.get("type")
            if btype == "heading":
                heading = _inline_text(block.get("content")).strip()
                # The mark is what is shown, in the chapter list and on screen,
                # so it is the heading without its [pause:…] markers — and a
                # heading that is nothing but markers marks no chapter at all.
                mark = strip_pause_markup(heading)
                if mark:
                    if options.chapter_screens:
                        flush(carry("after chapter card"))
                        beats = ([Beat(id="", kind="heading", text=_as_sentence(heading), block_id=block_id)]
                                 if options.read_chapters else [])
                        pending_card = _Part(
                            kind="card", card=Card(variant="chapter", title=mark),
                            chapter=mark, beats=beats, label="chapter card",
                            block_ids=[block_id] if block_id else [],
                        )
                        pending_chapter = None
                        continue
                    if pending_chapter is None:
                        pending_chapter = mark
                        said_at_chapter = len(pending)

            if btype == "quote" and options.quotes.enabled:
                quoted = _split_attribution(_inline_text(block.get("content")))
                if quoted[0]:
                    quote_part = carry("quote", overlay=QuoteOverlay(
                        id="", type="quote", text=quoted[0], attribution=quoted[1] or None))
                    after = carry("after quote")
                    if spoken() or pending_chapter is not None or pending_card is not None:
                        flush(quote_part)
                    else:
                        _take_over(open_part, quote_part)
                        open_part = quote_part
                    pending.append(Beat(id="", kind="quote", text=_as_sentence(quoted[0]), block_id=block_id))
                    flush(after)
                    continue

            if btype == "codeBlock":
                code = _inline_text(block.get("content"))
                if code.strip():
                    code_part = carry("code", overlay=CodeOverlay(id="", type="code", text=code))
                    after = carry("after code")
                    if spoken() or pending_chapter is not None or pending_card is not None:
                        flush(code_part)
                    else:
                        _take_over(open_part, code_part)
                        open_part = code_part
                    # Kept even when it isn't read, so the panel has a beat to
                    # hang on; `speak` decides whether it is heard.
                    pending.append(Beat(id="", kind="code", text=_as_sentence(code),
                                        speak=options.narrate_code, block_id=block_id))
                    flush(after)
                continue

            if btype == "heading" and not options.read_chapters:
                if block_id:
                    pending_blocks.append(block_id)
                continue

            text = _block_narration(block, options)
            if text.strip():
                pending.append(Beat(id="", kind="heading" if btype == "heading" else "prose",
                                    text=_as_sentence(text), block_id=block_id))
            continue

        url = _media_url(block, options)
        path = resolve_media_path(url, user_id, media_dir) if url else None
        ids = [block_id] if block_id else []
        if path is None:
            if url and not url.startswith("/media/"):
                warnings.append(f"Skipped remote media: {url[:120]}")
            elif url:
                warnings.append(f"Skipped missing media: {url[:120]}")
            flush(_Part(kind="still", label="fallback", block_ids=ids))
            continue

        if kind == "image":
            flush(_Part(kind="still", media=(url, "image"), path=path, block_ids=ids))
            continue

        sounded = bool(has_audio(path)) if callable(has_audio) else False
        if sounded:
            # A chapter whose heading wasn't read has no section of its own
            # before the clip, so the clip is where it starts.
            unplaced = flush(None)
            parts.append(_Part(kind="video_sound", media=(url, "video"), path=path,
                               chapter=unplaced, label="clip with audio", block_ids=ids))
            open_part = _Part(kind="video_muted", media=(url, "video"), path=path,
                              label="clip continued, muted")
        else:
            flush(_Part(kind="video_muted", media=(url, "video"), path=path, block_ids=ids))

    flush(None)

    kept: List[_Part] = []
    unplaced: Optional[str] = None
    for part in parts:
        if (part.kind == "still" and part.path is None and not part.narration(heading_ms)
                and not isinstance(part.overlay, CodeOverlay)):
            # Nothing to show or say, so no screen time — and a chapter mark it
            # carried starts whatever comes next instead. Marks that land on the
            # same moment keep the first, as two headings in a row do.
            unplaced = unplaced or part.chapter
            continue
        if unplaced:
            part.chapter = unplaced
        unplaced = None
        kept.append(part)
    parts = kept

    trimmed: List[_Part] = []
    for part in parts:
        previous = trimmed[-1] if trimmed else None
        if (previous is not None and previous.panel() and not part.panel()
                and not part.narration(heading_ms)
                and part.chapter is None
                and part.kind == previous.kind
                and part.path == previous.path):
            # Its blocks are still on screen, in the part it continued.
            previous.block_ids.extend(part.block_ids)
            continue
        trimmed.append(part)
    parts = trimmed

    if parts:
        intro = _bumper("intro", options, user_id, media_dir, warnings)
        outro = _bumper("outro", options, user_id, media_dir, warnings)
        if intro is not None:
            parts.insert(0, intro)
        if outro is not None:
            parts.append(outro)
    return parts, order


def _take_over(section: Optional[_Part], part: _Part) -> None:
    """A quote or code block replacing a section that had nothing to say keeps
    that section's picture, so it keeps the blocks the picture came from too,
    and the chapter mark the section was to start."""
    if section is not None:
        part.block_ids = section.block_ids + part.block_ids
        part.chapter = part.chapter or section.chapter


def _bumper(which, options, user_id, media_dir, warnings) -> Optional[_Part]:
    bumper = options.intro if which == "intro" else options.outro
    if not bumper.enabled or not bumper.url:
        return None
    path = resolve_media_path(bumper.url, user_id, media_dir)
    if path is None or _media_kind(bumper.url) != "video":
        warnings.append(f"The {which} was skipped: that clip could not be read.")
        return None
    return _Part(kind="video_sound", media=(bumper.url, "video"), path=path,
                 media_label=bumper.name or None, chapter=which.capitalize(),
                 role=which, label=which)


# ── parts -> segments ───────────────────────────────────────────────────────

class _Assets:
    """The spec's asset registry: one key per distinct (url, type), in first use order."""

    def __init__(self) -> None:
        self.registry: Dict[str, NotesAsset] = {}
        self._keys: Dict[Tuple[str, str], str] = {}

    def key(self, url: Optional[str], media_type: str, label: Optional[str] = None) -> Optional[str]:
        if not url:
            return None
        found = self._keys.get((url, media_type))
        if found is None:
            found = f"a{len(self._keys) + 1}"
            self._keys[(url, media_type)] = found
            self.registry[found] = NotesAsset(from_="notes", url=url, type=media_type, label=label or None)
        return found


def _joins(segment_parts: List[_Part], part: _Part) -> bool:
    """Whether `part` is the next shot of the scene `segment_parts` began.

    A quote or code shot interrupts a section over the same picture, and the
    section then resumes over it — that resumption is the only kind of plain
    shot that continues a scene. Anything carrying its own chapter mark starts
    a segment of its own, since a segment's chapter is marked at its start.
    """
    first, last = segment_parts[0], segment_parts[-1]
    if first.kind not in ("still", "video_muted") or part.kind != first.kind:
        return False
    if part.path != first.path or part.chapter is not None or part.role or part.card:
        return False
    if part.overlay is not None:
        return True
    return last.overlay is not None and part.label == f"after {last.overlay.type}"


def _group(parts: List[_Part], assets: _Assets, order: Dict[str, int]) -> List[Segment]:
    groups: List[List[_Part]] = []
    for part in parts:
        if groups and _joins(groups[-1], part):
            groups[-1].append(part)
        else:
            groups.append([part])

    segments: List[Segment] = []
    for index, group in enumerate(groups, start=1):
        first = group[0]
        segment_kind = {"card": "card", "video_sound": "clip"}.get(first.kind, "scene")
        visual = None
        if first.media is not None and first.path is not None:
            url, media_type = first.media
            visual = Visual(asset=assets.key(url, media_type, first.media_label),
                            audio="play" if segment_kind == "clip" else "mute")

        beats: List[Beat] = []
        overlays = []
        block_ids: List[str] = []
        for part in group:
            block_ids.extend(part.block_ids)
            block_ids.extend(b.block_id for b in part.beats if b.block_id)
            part_beats = list(part.beats)
            if not part_beats and part.overlay is None and len(group) > 1:
                # A section with nothing to say, interrupted at once by a quote
                # or code block, is still its own moment on screen.
                part_beats = [Beat(id="", text="", speak=False,
                                   block_id=part.block_ids[0] if part.block_ids else None)]
            for beat in part_beats:
                beats.append(beat.model_copy(update={"id": f"b{len(beats) + 1}"}))
            if part.overlay is not None:
                beat_id = beats[-1].id
                overlays.append(part.overlay.model_copy(update={
                    "id": f"o{len(overlays) + 1}",
                    "show": Span(from_=AnchorRef(beat=beat_id, edge="start"),
                                 to=AnchorRef(beat=beat_id, edge="end")),
                }))

        segments.append(Segment(
            id=f"s{index}",
            kind=segment_kind,
            role=first.role or ("title" if first.card is not None and first.card.variant == "title" else None),
            label=first.label,
            chapter=first.chapter,
            visual=visual,
            card=first.card,
            narration=Narration(beats=beats) if beats else None,
            overlays=overlays,
            chrome=False if first.role in ("intro", "outro") else None,
            source=(SegmentSource(block_ids=sorted(_dedupe(block_ids), key=order.__getitem__))
                    if block_ids else None),
        ))
    return segments


def _dedupe(values: List[str]) -> List[str]:
    seen, out = set(), []
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


# ── settings ────────────────────────────────────────────────────────────────

def _style(options: RenderOptions, assets: _Assets) -> Style:
    fallback = options.fallback
    return Style(
        background=Background(
            type=fallback.type, colors=list(fallback.colors), angle=fallback.angle,
            asset=assets.key(fallback.url, "image"),
        ),
        fit=options.fit,
        motion=Motion(effect=options.ken_burns.effect, amount=options.ken_burns.amount),
        transition=Transition(**options.transition.model_dump()),
        min_segment_seconds=options.min_shot_seconds,
        cards=Cards(
            seconds=options.card_seconds, motion=options.ken_burns.include_cards,
            title=CardText(**options.title_card_text.model_dump()),
            chapter=CardText(**options.chapter_card_text.model_dump()),
        ),
        quote=QuoteStyle(**options.quotes.model_dump(exclude={"enabled"})),
        code=CodeStyle(**options.code.model_dump()),
    )


def _chrome(options: RenderOptions, assets: _Assets) -> Chrome:
    chrome = Chrome()
    if options.watermark.enabled:
        chrome.watermark = Watermark(
            asset=assets.key(options.watermark.url, "image"),
            **options.watermark.model_dump(exclude={"enabled", "url"}),
        )
    if options.overlay_text.enabled:
        chrome.overlay_text = OverlayText(**options.overlay_text.model_dump(exclude={"enabled"}))
    if options.waveform.enabled:
        chrome.waveform = Waveform(**options.waveform.model_dump(exclude={"enabled"}))
    return chrome


def _music(options: RenderOptions, segments: List[Segment], assets: _Assets) -> List[AudioTrack]:
    """Today's one bed: under everything but the intro and outro."""
    music = options.music
    content = [s for s in segments if s.role not in ("intro", "outro")]
    if not music.enabled or not music.url or not content:
        return []
    return [AudioTrack(
        id="m1", kind="music", asset=assets.key(music.url, "audio"),
        start=AnchorRef(segment=content[0].id, edge="start"),
        end=AnchorRef(segment=content[-1].id, edge="end"),
        loop=True, volume=music.volume, duck_under_narration=music.duck,
        fade_in=music.fade_in, fade_out=music.fade_out,
    )]
