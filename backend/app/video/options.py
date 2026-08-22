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


class WatermarkSpec(BaseModel):
    """Corner watermark: an uploaded icon plus a caption line beside it."""

    enabled: bool = False
    url: Optional[str] = None          # /media/... icon
    text: str = ""                     # free text; defaults to "by {note title}"
    position: Position = "bottom-right"
    opacity: float = 0.85
    # Icon height as a percentage of the frame height.
    scale_pct: int = 6
    margin_pct: int = 4


class OverlayTextSpec(BaseModel):
    """A fixed text line held on screen for the whole video."""

    enabled: bool = False
    text: str = ""
    position: Position = "bottom-left"
    color: str = "#ffffff"
    # Font size as a percentage of the frame height.
    size_pct: int = 3
    margin_pct: int = 5
    shadow: bool = True


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

    @field_validator("min_shot_seconds", "card_seconds")
    @classmethod
    def _sane_seconds(cls, v: float) -> float:
        return max(0.5, min(30.0, v))
