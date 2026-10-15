"""The VideoSpec: a video described as data rather than inferred from a note.

`segmenter` works a video out of a note's block layout every time it renders —
an image starts a shot, the text under it is read over it, a quote becomes its
own shot — and nothing of that structure exists between renders. This module is
that structure made explicit: ordered segments, the narration beats inside them,
overlays anchored to beats, audio tracks anchored to segments, and a registry of
the assets they all point at. It is the document Gecko Video Creator edits; see
docs/gecko-video-creator.md §5 for the design and the reasoning behind it.

Phase 0 of that plan: `importer` turns a note into one of these, `compiler`
turns one back into the shots and options today's renderer consumes, and
tests/test_video_spec.py proves the round trip changes nothing.

Pure data. Nothing here touches the filesystem, the database or a provider.
Limits are not repeated here: a spec reaches the renderer through
`RenderOptions`, whose validators clamp exactly as they always have.
"""

from typing import Annotated, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.video.options import (
    Aspect, CardTextSpec, CodeSpec, Fit, KenBurnsEffect, OverlayTextMode, Position,
    Quality, QuotePosition, Resolution, SubtitleMode, TransitionSpec, WaveMode,
    WavePosition,
)

SPEC_VERSION = "0.1"


class _Model(BaseModel):
    # A spec is edited by hand and by an AI, so a misspelt field is an error
    # rather than something silently ignored. `from` and `in` are Python
    # keywords, hence the aliases below: accepted either way, always written
    # as the spec spells them.
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)


# ── assets ──────────────────────────────────────────────────────────────────

MediaType = Literal["image", "video", "audio"]


class NotesAsset(_Model):
    """A file in a note's own /media/<user_id>/ directory."""

    from_: Literal["notes"] = Field(alias="from")
    url: str
    # How the note used it, which is not always what the extension says: a
    # `videoFile` block is a video whatever its URL ends in.
    type: MediaType
    label: Optional[str] = None


class GamAsset(_Model):
    """An asset or clip in Gecko Asset Manager."""

    from_: Literal["gam"] = Field(alias="from")
    id: str
    type: Optional[MediaType] = None
    label: Optional[str] = None


class GeneratedAsset(_Model):
    """A placeholder for media still to be generated (through GAM)."""

    from_: Literal["generate"] = Field(alias="from")
    type: Literal["image", "video", "music", "sfx"]
    prompt: str
    model: Optional[str] = None
    base_assets: List[str] = Field(default_factory=list)
    status: Literal["pending", "running", "ready", "failed"] = "pending"
    result: Optional[GamAsset] = None
    label: Optional[str] = None


class SearchAsset(_Model):
    """A placeholder for footage still to be found in GAM."""

    from_: Literal["search"] = Field(alias="from")
    query: str
    type: Optional[MediaType] = None
    status: Literal["unresolved", "resolved"] = "unresolved"
    result: Optional[GamAsset] = None
    label: Optional[str] = None


AssetRef = Annotated[
    Union[NotesAsset, GamAsset, GeneratedAsset, SearchAsset],
    Field(discriminator="from_"),
]


# ── project-wide settings ───────────────────────────────────────────────────

class Output(_Model):
    aspect: Aspect = "16:9"
    resolution: Resolution = "1080p"
    quality: Quality = "standard"
    fps: int = 30
    subtitles: SubtitleMode = "sidecar"
    chapters: bool = True               # embed chapter marks in the file
    thumbnail: bool = True


class Pauses(_Model):
    paragraph_ms: int = 350
    heading_ms: int = 800
    segment_end_ms: int = 600


class Voice(_Model):
    # None means "whatever the account is set to", which is what Notes renders
    # with today; naming one pins it for the whole video.
    provider: Optional[Literal["auto", "deepgram", "fal"]] = None
    voice: Optional[str] = None
    speed: float = 1.0
    expressivity: Optional[int] = None  # Deepgram Flux only, -2…2
    pauses: Pauses = Field(default_factory=Pauses)


class VoiceOverride(_Model):
    """Per-segment voice. Every field left unset inherits from `Voice`."""

    provider: Optional[Literal["auto", "deepgram", "fal"]] = None
    voice: Optional[str] = None
    speed: Optional[float] = None
    expressivity: Optional[int] = None


class Transition(TransitionSpec):
    # The option model's fields and clamps, but strict about unknown keys.
    model_config = ConfigDict(extra="forbid")


class CardText(CardTextSpec):
    model_config = ConfigDict(extra="forbid")


class CodeStyle(CodeSpec):
    model_config = ConfigDict(extra="forbid")


class Background(_Model):
    """Shown behind a segment that has no visual of its own."""

    type: Literal["gradient", "solid", "image"] = "gradient"
    colors: List[str] = Field(default_factory=lambda: ["#1e293b", "#0f172a"])
    angle: int = 135
    asset: Optional[str] = None         # used when type == "image"


class Motion(_Model):
    effect: KenBurnsEffect = "none"     # "alternate" only makes sense project-wide
    amount: float = 0.12


class Cards(_Model):
    seconds: float = 3.5
    motion: bool = False                # Ken Burns on cards (zoom only)
    title: CardText = Field(default_factory=CardText)
    chapter: CardText = Field(default_factory=CardText)


class QuoteStyle(_Model):
    position: QuotePosition = "center"
    size_pct: float = 4.2
    color: str = "#ffffff"
    accent: str = "#818cf8"
    scrim: float = 0.55


class Style(_Model):
    background: Background = Field(default_factory=Background)
    fit: Fit = "blur"
    motion: Motion = Field(default_factory=Motion)
    transition: Transition = Field(default_factory=Transition)
    min_segment_seconds: float = 2.5
    cards: Cards = Field(default_factory=Cards)
    quote: QuoteStyle = Field(default_factory=QuoteStyle)
    code: CodeStyle = Field(default_factory=CodeStyle)


class Watermark(_Model):
    asset: Optional[str] = None
    text: str = ""                      # empty: "by {title}"
    position: Position = "bottom-right"
    opacity: float = 0.85
    scale_pct: float = 6.0
    caption_pct: float = 2.3
    margin_pct: int = 4


class OverlayText(_Model):
    mode: OverlayTextMode = "fixed"
    text: str = ""
    position: Position = "bottom-left"
    color: str = "#ffffff"
    size_pct: float = 3.0
    margin_pct: int = 5
    shadow: bool = True


class Waveform(_Model):
    mode: WaveMode = "line"
    color: str = "#00ff41"
    opacity: float = 0.7
    position: WavePosition = "bottom"
    height_pct: int = 22
    scrim: float = 0.45


class Chrome(_Model):
    """Drawn over every segment that doesn't opt out. Present means on."""

    watermark: Optional[Watermark] = None
    overlay_text: Optional[OverlayText] = None
    waveform: Optional[Waveform] = None


# ── time ────────────────────────────────────────────────────────────────────

class AnchorRef(_Model):
    """A moment defined by the structure rather than by a number of seconds."""

    segment: Optional[str] = None       # inside a segment's overlay: that segment
    beat: Optional[str] = None
    edge: Literal["start", "end"]
    offset: float = 0.0                 # seconds; negative is before the edge


Anchor = Union[Literal["video_start", "video_end"], AnchorRef]


class Span(_Model):
    from_: Anchor = Field(alias="from")
    to: Anchor


class Trim(_Model):
    in_: float = Field(alias="in")
    out: Optional[float] = None


# ── segments ────────────────────────────────────────────────────────────────

class Visual(_Model):
    asset: str
    fit: Optional[Fit] = None
    motion: Optional[Motion] = None
    trim: Optional[Trim] = None
    audio: Literal["mute", "play"] = "mute"
    loop: bool = True


class Beat(_Model):
    """One spoken unit — usually one block of the note."""

    id: str
    text: str                           # [pause:…] markup is kept and honoured
    kind: Literal["prose", "heading", "quote", "code"] = "prose"
    # False: the beat takes up time without being read — a code block that
    # isn't narrated, or an empty `text` that just holds the picture.
    speak: bool = True
    hold: Optional[float] = None
    pause_after_ms: Optional[int] = None
    # The note block it was read from, so a re-sync can match it up again.
    block_id: Optional[str] = None


class Narration(_Model):
    beats: List[Beat] = Field(default_factory=list)
    voice: Optional[VoiceOverride] = None


class _OverlayBase(_Model):
    id: str
    show: Optional[Span] = None         # default: the whole segment
    fade: Optional[float] = None


class QuoteOverlay(_OverlayBase):
    type: Literal["quote"]
    text: str
    attribution: Optional[str] = None


class CodeOverlay(_OverlayBase):
    type: Literal["code"]
    text: str
    language: Optional[str] = None


class TextOverlay(_OverlayBase):
    type: Literal["text"]
    text: str
    position: Position = "center"
    size_pct: Optional[float] = None
    color: Optional[str] = None


class LowerThirdOverlay(_OverlayBase):
    type: Literal["lower_third"]
    title: str
    subtitle: Optional[str] = None


class ImageOverlay(_OverlayBase):
    type: Literal["image"]
    asset: str
    position: Position = "center"
    scale_pct: Optional[float] = None
    opacity: Optional[float] = None


Overlay = Annotated[
    Union[QuoteOverlay, CodeOverlay, TextOverlay, LowerThirdOverlay, ImageOverlay],
    Field(discriminator="type"),
]


class Card(_Model):
    variant: Literal["title", "chapter"]
    title: str
    subtitle: Optional[str] = None


class Duration(_Model):
    min: Optional[float] = None
    fixed: Optional[float] = None


class SegmentSource(_Model):
    """The note blocks a segment was imported from, for re-syncing later."""

    block_ids: List[str] = Field(default_factory=list)


class Segment(_Model):
    id: str
    # scene: a visual with narration over it. card: a title or chapter screen.
    # clip: a video played with its own sound and no narration.
    kind: Literal["scene", "card", "clip"]
    role: Optional[Literal["title", "intro", "outro"]] = None
    label: str = ""
    chapter: Optional[str] = None       # a chapter mark at this segment's start
    visual: Optional[Visual] = None
    card: Optional[Card] = None
    narration: Optional[Narration] = None
    overlays: List[Overlay] = Field(default_factory=list)
    transition_in: Optional[Transition] = None
    duration: Optional[Duration] = None
    # None: the default, which is on except for an intro or outro.
    chrome: Optional[bool] = None
    source: Optional[SegmentSource] = None

    @property
    def beats(self) -> List[Beat]:
        return self.narration.beats if self.narration is not None else []


class AudioTrack(_Model):
    id: str
    kind: Literal["music", "sfx", "voiceover"] = "music"
    asset: str
    start: Anchor
    end: Optional[Anchor] = None        # None: play once, to its natural end
    trim: Optional[Trim] = None
    loop: Optional[bool] = None         # default: on for music
    volume: float = 0.18
    duck_under_narration: Optional[bool] = None
    fade_in: float = 0.0
    fade_out: float = 0.0


class Credits(_Model):
    auto: bool = True
    card: bool = True
    description: bool = True
    extra: List[str] = Field(default_factory=list)


class SpecSource(_Model):
    note_id: Optional[str] = None
    note_version_id: Optional[str] = None
    imported_at: Optional[str] = None   # ISO 8601; re-sync compares the note against it
    selection: bool = False             # only part of the note was imported


class VideoSpec(_Model):
    spec_version: Literal["0.1"] = SPEC_VERSION
    id: Optional[str] = None
    title: str = ""
    source: Optional[SpecSource] = None
    output: Output = Field(default_factory=Output)
    voice: Voice = Field(default_factory=Voice)
    style: Style = Field(default_factory=Style)
    chrome: Chrome = Field(default_factory=Chrome)
    assets: Dict[str, AssetRef] = Field(default_factory=dict)
    segments: List[Segment] = Field(default_factory=list)
    audio_tracks: List[AudioTrack] = Field(default_factory=list)
    credits: Optional[Credits] = None

    @model_validator(mode="after")
    def _well_formed(self) -> "VideoSpec":
        """The structural rules (§5.7). Anchors are deliberately not checked
        here: an edit may leave one pointing at a removed segment (§5.7), and
        what that means is the renderer's call — the Notes compiler refuses
        such a spec and says which anchor is orphaned."""
        problems: List[str] = []

        def unique(ids: List[str], what: str) -> None:
            seen = set()
            for value in ids:
                if value in seen:
                    problems.append(f"duplicate {what} id {value!r}")
                seen.add(value)

        def known(key: Optional[str], where: str) -> None:
            if key is not None and key not in self.assets:
                problems.append(f"{where} refers to unknown asset {key!r}")

        unique([s.id for s in self.segments], "segment")
        unique([t.id for t in self.audio_tracks], "audio track")
        known(self.style.background.asset, "style.background")
        if self.chrome.watermark is not None:
            known(self.chrome.watermark.asset, "chrome.watermark")
        for key, asset in self.assets.items():
            for base in getattr(asset, "base_assets", []):
                known(base, f"asset {key!r}")
        for segment in self.segments:
            where = f"segment {segment.id!r}"
            unique([b.id for b in segment.beats], f"{where} beat")
            unique([o.id for o in segment.overlays], f"{where} overlay")
            if segment.visual is not None:
                known(segment.visual.asset, where)
            for overlay in segment.overlays:
                if isinstance(overlay, ImageOverlay):
                    known(overlay.asset, f"{where} overlay {overlay.id!r}")
            if segment.kind == "card" and segment.card is None:
                problems.append(f"{where} is a card with no card")
            if segment.kind != "card" and segment.card is not None:
                problems.append(f"{where} has a card but is a {segment.kind}")
            if segment.kind == "clip" and segment.visual is None:
                problems.append(f"{where} is a clip with no visual")
        for track in self.audio_tracks:
            known(track.asset, f"audio track {track.id!r}")
        if problems:
            raise ValueError("; ".join(problems))
        return self
