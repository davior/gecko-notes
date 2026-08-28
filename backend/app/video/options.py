"""Render options and the frame-size / encoder tables.

Everything the user picks in the "Generate video" dialog lands here as a
`RenderOptions`, which is stored verbatim on the job row as JSON. Keeping it one
serialisable model (rather than columns) means a future presets feature can save
and replay a configuration without a schema change.
"""

from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field, field_validator

Aspect = Literal["16:9", "9:16", "1:1"]
Resolution = Literal["720p", "1080p", "4k"]
Quality = Literal["preview", "standard", "high"]
Fit = Literal["blur", "pad", "crop"]
Position = Literal["top-left", "top-right", "center", "bottom-left", "bottom-right"]
WavePosition = Literal["top", "center", "bottom"]
WaveMode = Literal["line", "p2p", "cline", "point"]
SubtitleMode = Literal["off", "sidecar", "soft", "burn"]
# "title" shows the note's title; "title_chapter" adds the current chapter
# underneath it, in a smaller size, and follows it as the video moves between
# chapters; "fixed" is free text the user types in.
OverlayTextMode = Literal["fixed", "title", "title_chapter"]

# A transition either dips through a colour — which each shot can draw inside its
# own filtergraph — or blends into its neighbour, which needs the two shots to
# overlap on the timeline. Only the second kind costs anything; see is_crossfade.
Transition = Literal[
    "none", "fade", "fadewhite",
    "dissolve", "slideleft", "slideright", "wipeleft", "wiperight",
    "circleopen", "smoothleft",
]
KenBurnsEffect = Literal[
    "none", "zoom_in", "zoom_out",
    "pan_left", "pan_right", "pan_up", "pan_down", "alternate",
]
QuotePosition = Literal["top", "center", "bottom"]

# Drawn per shot with `fade`/`afade`, so shot durations are unchanged and the
# stitch stays a `concat -c copy` remux.
DIP_TRANSITIONS = frozenset({"fade", "fadewhite"})

# ffmpeg's xfade name for each blending style. Anything absent from here that
# isn't a dip is treated as "none".
XFADE_NAMES: Dict[str, str] = {
    "dissolve": "dissolve",
    "slideleft": "slideleft",
    "slideright": "slideright",
    "wipeleft": "wipeleft",
    "wiperight": "wiperight",
    "circleopen": "circleopen",
    "smoothleft": "smoothleft",
}


def is_crossfade(style: str) -> bool:
    """True when this style needs the xfade stitch instead of `concat -c copy`.

    The whole pipeline rests on every shot being encoded identically so the join
    is a remux. A blend needs adjacent shots to overlap, which no per-shot filter
    can express, so it costs one re-encode of the joined stream. Keeping the test
    here means the renderer branches in exactly one place.
    """
    return style in XFADE_NAMES


def transition_colour(style: str) -> str:
    """The colour a dip transition passes through."""
    return "white" if style == "fadewhite" else "black"


# Ken Burns smoothness.
#
# `zoompan` truncates its crop origin to whole pixels of whatever frame it is
# handed. A slow drift moves that origin well under a pixel per frame, so it
# stalls on some frames and jumps on others — the picture steps instead of
# gliding, and a longer shot steps worse because the same travel is spread over
# more frames. Two things fix it, both of them about giving the motion more
# pixels to be precise in:
#
#   read   the picture is scaled well above the output frame before zoompan
#          sees it, so a third-of-a-pixel step becomes a two-or-three pixel one
#          where the truncation actually happens;
#   write  zoompan renders above the output size and is scaled back down, which
#          halves whatever step is left and averages it away.
#
# Both are bounded by a pixel budget rather than a width, so a 9:16 frame gets
# the same treatment as a 16:9 one instead of an enormous portrait buffer.
# 24 megapixels is a deliberate ceiling rather than the largest that would fit:
# the fit stage runs a split/scale/crop/blur chain at this size, so the buffers
# and the blur both grow with it, and past here the smoothness gained is smaller
# than the memory spent.
KENBURNS_READ_PIXELS = 24_000_000
KENBURNS_READ_MAX_SCALE = 8.0
KENBURNS_WRITE_PIXELS = 3840 * 2160
KENBURNS_WRITE_MAX_SCALE = 2.0

# Below this the drift is not slow, it is invisible: the picture holds still for
# several frames between each one-pixel move, and no amount of precision changes
# that. A 12% travel crosses it at about 25 seconds; an 8-minute section — one
# image carried across a heading and all its subsections — would need to spread
# the same travel across sixteen times the frames, well past where a single
# sweep could still be seen moving. Past this point `kenburns_chain` doesn't
# hold the picture still: it repeats the sweep back and forth, A to B then B to
# A, in legs this long, so a long shot still visibly drifts instead of crawling
# once at a speed nobody would notice. Expressed as a rate rather than a shot
# length so it follows the travel the user actually chose.
KENBURNS_MIN_TRAVEL_PX_PER_FRAME = 0.15


def kenburns_leg_frames(amount: float, width: int) -> int:
    """Longest a single A-to-B sweep may run and still be seen moving.

    Past this many frames `kenburns_chain` cycles the sweep — A to B, then B
    to A — in legs this long, rather than crawl once across a shot at a speed
    under KENBURNS_MIN_TRAVEL_PX_PER_FRAME.
    """
    return max(1, int(amount * width / 2 / KENBURNS_MIN_TRAVEL_PX_PER_FRAME))


def _budgeted_scale(width: int, height: int, budget: int, ceiling: float) -> float:
    """Largest scale at or below `ceiling` that keeps width*height under budget."""
    pixels = max(1, width * height)
    return max(1.0, min(ceiling, (budget / pixels) ** 0.5))


def kenburns_geometry(width: int, height: int) -> Tuple[int, int, int, int]:
    """(read_w, read_h, write_w, write_h) for a drifting shot at this frame size.

    The fit stage renders at the read size, zoompan crops from it and emits the
    write size, and the caller scales that back to the frame. All four are even,
    which every filter in the chain is happier with.
    """
    def _even(value: float) -> int:
        n = max(2, int(value))
        return n - n % 2

    read = _budgeted_scale(width, height, KENBURNS_READ_PIXELS, KENBURNS_READ_MAX_SCALE)
    write = _budgeted_scale(width, height, KENBURNS_WRITE_PIXELS, KENBURNS_WRITE_MAX_SCALE)
    # Reading below what is written would mean zoompan upscaling to fill its own
    # output, which is the softness this whole arrangement exists to avoid.
    read = max(read, write)
    return (_even(width * read), _even(height * read),
            _even(width * write), _even(height * write))

# Frame size per aspect x resolution. "preview" is not a resolution the user picks —
# it comes from the job's quality flag and deliberately renders small and fast so a
# full-quality pass afterwards reuses the cached narration for free.
FRAME_SIZES: Dict[str, Dict[str, Tuple[int, int]]] = {
    "16:9": {"preview": (854, 480), "720p": (1280, 720), "1080p": (1920, 1080), "4k": (3840, 2160)},
    "9:16": {"preview": (480, 854), "720p": (720, 1280), "1080p": (1080, 1920), "4k": (2160, 3840)},
    "1:1": {"preview": (480, 480), "720p": (720, 720), "1080p": (1080, 1080), "4k": (2160, 2160)},
}

# x264 preset/CRF per quality tier. Preview trades a lot of file size for speed.
ENCODER_TIERS: Dict[str, Tuple[str, int]] = {
    "preview": ("ultrafast", 30),
    "standard": ("medium", 21),
    "high": ("slow", 18),
}


def frame_size(aspect: str, resolution: str, preview: bool = False) -> Tuple[int, int]:
    """Even-numbered (width, height) for an aspect/resolution pair.

    libx264 with yuv420p requires even dimensions; every entry in FRAME_SIZES is
    already even, but the rounding here keeps that true if the table grows.
    """
    sizes = FRAME_SIZES.get(aspect) or FRAME_SIZES["16:9"]
    key = "preview" if preview else resolution
    width, height = sizes.get(key) or sizes["1080p"]
    return (width - width % 2, height - height % 2)


def encoder_tier(quality: str, preview: bool = False) -> Tuple[str, int]:
    """(x264 preset, CRF). A preview job always renders at the preview tier."""
    return ENCODER_TIERS["preview"] if preview else (ENCODER_TIERS.get(quality) or ENCODER_TIERS["standard"])


class BackgroundSpec(BaseModel):
    """Fallback background for shots with no image or video of their own."""

    type: Literal["gradient", "solid", "image"] = "gradient"
    # Two-stop linear gradient; only `colors[0]` is used for a solid.
    colors: List[str] = Field(default_factory=lambda: ["#1e293b", "#0f172a"])
    angle: int = 135
    # A /media/... URL, used when type == "image".
    url: Optional[str] = None

    @field_validator("colors")
    @classmethod
    def _at_least_one_colour(cls, v: List[str]) -> List[str]:
        return v or ["#1e293b", "#0f172a"]


class WaveformSpec(BaseModel):
    """Animated audio waveform drawn over the background."""

    enabled: bool = False
    mode: WaveMode = "line"
    color: str = "#00ff41"
    opacity: float = 0.7
    position: WavePosition = "bottom"
    # Band height as a percentage of the frame height.
    height_pct: int = 22
    # Darkened box behind the wave so it stays legible over a bright photo.
    scrim: float = 0.45


# Every text size in a render is expressed as a percentage of the frame height,
# so a setting chosen once looks the same at 720p, 1080p and 4K, and in every
# aspect ratio. They are floats rather than ints because a whole percent is a
# coarse step at these sizes — the difference between 6% and 7% of a 1080p frame
# is 11 pixels of title.
def _clamp_pct(low: float, high: float):
    def _validate(value: float) -> float:
        return max(low, min(high, float(value)))
    return _validate


class WatermarkSpec(BaseModel):
    """Corner watermark: an uploaded icon plus a caption line beside it."""

    enabled: bool = False
    url: Optional[str] = None          # /media/... icon
    text: str = ""                     # free text; defaults to "by {note title}"
    position: Position = "bottom-right"
    opacity: float = 0.85
    # Icon height as a percentage of the frame height.
    scale_pct: float = 6.0
    # Caption size, also as a percentage of the frame height — independent of the
    # icon, so the two can be balanced against each other.
    caption_pct: float = 2.3
    margin_pct: int = 4

    _scale = field_validator("scale_pct")(_clamp_pct(1.0, 30.0))
    _caption = field_validator("caption_pct")(_clamp_pct(0.5, 15.0))


class OverlayTextSpec(BaseModel):
    """A text overlay held on screen for the whole video.

    `mode` picks what's shown: the note's title, the title with the current
    chapter added underneath, or `text` verbatim. `text` is only read in
    "fixed" mode — the other two derive their words from the note itself.
    """

    enabled: bool = False
    mode: OverlayTextMode = "fixed"
    text: str = ""
    position: Position = "bottom-left"
    color: str = "#ffffff"
    # Font size as a percentage of the frame height.
    size_pct: float = 3.0
    margin_pct: int = 5
    shadow: bool = True

    _size = field_validator("size_pct")(_clamp_pct(0.5, 20.0))


class CardTextSpec(BaseModel):
    """Type sizes for a full-screen card (the title screen or a chapter screen)."""

    title_pct: float = 6.8
    subtitle_pct: float = 2.9

    _title = field_validator("title_pct")(_clamp_pct(1.0, 25.0))
    _subtitle = field_validator("subtitle_pct")(_clamp_pct(0.5, 15.0))


class TransitionSpec(BaseModel):
    """How one shot gives way to the next."""

    style: Transition = "none"
    # Seconds. A dip spends this long fading out and the same fading back in; a
    # crossfade overlaps its neighbours by it. Clamped again at render time
    # against the shortest shot, which is the real ceiling.
    duration: float = 0.6

    @field_validator("duration")
    @classmethod
    def _sane_duration(cls, v: float) -> float:
        return max(0.1, min(3.0, float(v)))


class KenBurnsSpec(BaseModel):
    """Slow drift over a still, so a photo-backed section isn't frozen."""

    effect: KenBurnsEffect = "none"
    # Fraction of the frame travelled: 0.12 is a 12% push. Clamped at render
    # time to the headroom the prescale actually provides.
    amount: float = 0.12
    # Title and chapter screens have their text drawn into the picture, so they
    # are left still by default; when included they only ever zoom from the
    # centre, never pan, or the type would drift out of frame.
    include_cards: bool = False

    @field_validator("amount")
    @classmethod
    def _sane_amount(cls, v: float) -> float:
        return max(0.02, min(0.5, float(v)))


class MusicSpec(BaseModel):
    """A background bed mixed under the narration."""

    enabled: bool = False
    url: Optional[str] = None          # /media/... audio file
    # Bed level relative to the narration.
    volume: float = 0.18
    # Duck the bed under speech with a sidechain compressor. Falls back to a
    # flat mix when the host ffmpeg has no sidechaincompress.
    duck: bool = True
    fade_in: float = 1.5
    fade_out: float = 3.0

    @field_validator("volume")
    @classmethod
    def _sane_volume(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))

    @field_validator("fade_in", "fade_out")
    @classmethod
    def _sane_fade(cls, v: float) -> float:
        return max(0.0, min(15.0, float(v)))


class QuoteSpec(BaseModel):
    """Pull-quote panel drawn over the section a blockquote interrupts."""

    enabled: bool = False
    position: QuotePosition = "center"
    # Quotation size as a percentage of the frame height, like every other size
    # in a render, so one setting holds at 720p, 1080p and 4K.
    size_pct: float = 4.2
    color: str = "#ffffff"
    accent: str = "#818cf8"
    # Darkened panel behind the words so they stay legible over a bright photo.
    scrim: float = 0.55

    _size = field_validator("size_pct")(_clamp_pct(1.0, 15.0))

    @field_validator("scrim")
    @classmethod
    def _sane_scrim(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))


class CodeSpec(BaseModel):
    """Code panel drawn over the section a code block interrupts.

    Unlike QuoteSpec there is no `enabled` toggle: a code block always gets
    its panel, on screen until the next shot replaces it — this only styles
    it. Whether it's also *read aloud* is `RenderOptions.narrate_code`, a
    separate concern the way a blockquote's own narration is always on but a
    code block's is opt-in.
    """

    position: QuotePosition = "center"
    size_pct: float = 3.4
    color: str = "#e2e8f0"
    # Darkened panel behind the text so it stays legible over a bright photo.
    scrim: float = 0.72

    _size = field_validator("size_pct")(_clamp_pct(1.0, 12.0))

    @field_validator("scrim")
    @classmethod
    def _sane_scrim(cls, v: float) -> float:
        return max(0.0, min(1.0, float(v)))


class RenderOptions(BaseModel):
    """The complete render configuration. Persisted as JSON on the job row."""

    aspect: Aspect = "16:9"
    resolution: Resolution = "1080p"
    quality: Quality = "standard"
    fps: int = 30
    fit: Fit = "blur"

    fallback: BackgroundSpec = Field(default_factory=BackgroundSpec)
    waveform: WaveformSpec = Field(default_factory=WaveformSpec)
    watermark: WatermarkSpec = Field(default_factory=WatermarkSpec)
    overlay_text: OverlayTextSpec = Field(default_factory=OverlayTextSpec)
    # Sized separately: the opening title is usually the largest thing in the
    # video, while chapter dividers read better a little smaller.
    title_card_text: CardTextSpec = Field(default_factory=CardTextSpec)
    chapter_card_text: CardTextSpec = Field(default_factory=CardTextSpec)

    # Motion and audio. `transition` is the one option that can change how the
    # video is stitched — see is_crossfade.
    transition: TransitionSpec = Field(default_factory=TransitionSpec)
    ken_burns: KenBurnsSpec = Field(default_factory=KenBurnsSpec)
    music: MusicSpec = Field(default_factory=MusicSpec)
    quotes: QuoteSpec = Field(default_factory=QuoteSpec)
    code: CodeSpec = Field(default_factory=CodeSpec)

    # Append the finished video to the note as a playable block. Done by the
    # worker rather than the browser so a render survives the tab being closed.
    insert_into_note: bool = True

    title_card: bool = True
    chapter_screens: bool = False
    embed_chapters: bool = True
    thumbnail: bool = True
    subtitles: SubtitleMode = "sidecar"

    # Narration
    voice: Optional[str] = None        # None = the account's configured voice
    speed: float = 1.0
    paragraph_pause_ms: int = 350
    # Held at a heading, going in and coming out. A full stop is all a voice has
    # to separate "...ends here." from "A New Chapter.", so the two run together
    # in one breath — which is the main thing that makes a long read sound
    # machine-made. Set to 0 to run headings on as ordinary prose.
    heading_pause_ms: int = 800
    # Held after the *last* word of every shot — a plain section, a title
    # screen, a chapter card — before the cut to whatever comes next. Without
    # this a shot's audio stops the instant speech does, often mid-decay on a
    # voice's own trailing intonation, and the cut lands right on top of it: it
    # reads as the sentence getting clipped rather than finishing. This is the
    # gap paragraph_pause_ms and heading_pause_ms don't cover — both only ever
    # sit *between* two chunks inside one shot, never after the shot's last one.
    shot_end_pause_ms: int = 600
    # A code block always gets its own on-screen panel (see CodeSpec); this
    # only controls whether its text is *read aloud* too. Off, the panel is
    # still shown, silently, for at least min_shot_seconds.
    narrate_code: bool = False

    # Shortest a shot may be, so a media block with little or no text under it
    # doesn't flash past. Also the duration of a silent title/chapter card.
    min_shot_seconds: float = 2.5
    card_seconds: float = 3.5

    # blockId -> /media URL for `diagram` blocks the client rasterised for us.
    diagram_images: Dict[str, str] = Field(default_factory=dict)

    @field_validator("fps")
    @classmethod
    def _sane_fps(cls, v: int) -> int:
        return max(12, min(60, v))

    @field_validator("speed")
    @classmethod
    def _sane_speed(cls, v: float) -> float:
        return max(0.5, min(2.0, v))

    @field_validator("paragraph_pause_ms")
    @classmethod
    def _sane_pause(cls, v: int) -> int:
        return max(0, min(3000, v))

    @field_validator("heading_pause_ms")
    @classmethod
    def _sane_heading_pause(cls, v: int) -> int:
        return max(0, min(5000, v))

    @field_validator("shot_end_pause_ms")
    @classmethod
    def _sane_shot_end_pause(cls, v: int) -> int:
        return max(0, min(3000, v))

    @field_validator("min_shot_seconds", "card_seconds")
    @classmethod
    def _sane_seconds(cls, v: float) -> float:
        return max(0.5, min(30.0, v))
