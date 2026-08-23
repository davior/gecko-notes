"""Pillow composition: cards, overlays and fallback backgrounds.

Every piece of static text in a rendered video is drawn here into a PNG and then
composited by ffmpeg with a plain `overlay`, rather than being passed to
ffmpeg's `drawtext`. That is a deliberate choice: `drawtext` needs its text
escaped for colons, quotes, apostrophes and percent signs — note titles contain
all of those — and it has no real line-breaking. Pillow gives proper measurement
and wrapping, and removes the escaping surface entirely.
"""

import logging
import math
import os
from typing import List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, UnidentifiedImageError

from app.video.options import CardTextSpec, OverlayTextSpec, Position, QuoteSpec, WatermarkSpec

logger = logging.getLogger(__name__)

FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "fonts")
REGULAR = os.path.join(FONT_DIR, "Inter-Regular.ttf")
SEMIBOLD = os.path.join(FONT_DIR, "Inter-SemiBold.ttf")

# Only used if the vendored files are somehow missing; keeps a render working
# (with the wrong typeface) rather than failing it.
_FALLBACKS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    for candidate in (path, *_FALLBACKS):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    logger.warning("No usable TrueType font found; falling back to the bitmap default")
    return ImageFont.load_default()


def parse_colour(value: str, default: Tuple[int, int, int] = (255, 255, 255)) -> Tuple[int, int, int]:
    c = (value or "").strip().lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) >= 6:
        try:
            return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
        except ValueError:
            pass
    return default


def gradient_background(width: int, height: int, colours: Sequence[str], angle: int = 135) -> Image.Image:
    """Two-stop linear gradient at an arbitrary angle.

    Built by stretching a 1x256 ramp over the frame's diagonal, rotating it, and
    cropping back — which keeps the gradient smooth at any angle without needing
    a per-pixel loop (or numpy, which isn't a dependency here).
    """
    start = parse_colour(colours[0] if colours else "#1e293b", (30, 41, 59))
    end = parse_colour(colours[1] if len(colours) > 1 else colours[0], (15, 23, 42))

    ramp = Image.new("RGB", (1, 256))
    px = ramp.load()
    for i in range(256):
        t = i / 255
        px[0, i] = tuple(round(start[c] + (end[c] - start[c]) * t) for c in range(3))

    diagonal = int(math.ceil(math.hypot(width, height))) + 2
    stretched = ramp.resize((diagonal, diagonal), Image.BILINEAR).rotate(angle, resample=Image.BILINEAR)
    left = (diagonal - width) // 2
    top = (diagonal - height) // 2
    return stretched.crop((left, top, left + width, top + height))


def solid_background(width: int, height: int, colour: str) -> Image.Image:
    return Image.new("RGB", (width, height), parse_colour(colour, (15, 23, 42)))


def cover_image(path: str, width: int, height: int) -> Optional[Image.Image]:
    """Load an image and scale-and-crop it to exactly fill the frame."""
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img).convert("RGB")
            return ImageOps.fit(img, (width, height), Image.LANCZOS, centering=(0.5, 0.5))
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.warning("Could not use %s as a background: %s", path, exc)
        return None


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> List[str]:
    """Greedy word wrap, breaking an over-long single word by character."""
    lines: List[str] = []
    for paragraph in (text or "").splitlines() or [""]:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            trial = f"{current} {word}"
            if draw.textlength(trial, font=font) <= max_width:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)

    out: List[str] = []
    for line in lines:
        while draw.textlength(line, font=font) > max_width and len(line) > 1:
            cut = len(line)
            while cut > 1 and draw.textlength(line[:cut], font=font) > max_width:
                cut -= 1
            out.append(line[:cut])
            line = line[cut:]
        out.append(line)
    return out


def fit_font(
    draw: ImageDraw.ImageDraw, text: str, font_path: str,
    start_size: int, max_width: int, min_size: int = 8,
) -> ImageFont.FreeTypeFont:
    """Largest size at or below `start_size` where the longest word still fits.

    Wrapping alone can't help a single unbreakable token — a domain name, a long
    hashtag — which would otherwise be chopped mid-word; shrinking it does.
    """
    words = (text or "").split() or [""]
    size = max(min_size, start_size)
    while size > min_size:
        font = load_font(font_path, size)
        if all(draw.textlength(word, font=font) <= max_width for word in words):
            return font
        size -= 1
    return load_font(font_path, min_size)


def truncate_to_width(
    draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_width: int,
) -> str:
    """Shorten `text` with an ellipsis until it fits `max_width`."""
    if max_width <= 0 or not text:
        return ""
    if draw.textlength(text, font=font) <= max_width:
        return text
    ellipsis = "\u2026"
    trimmed = text
    while trimmed and draw.textlength(trimmed + ellipsis, font=font) > max_width:
        trimmed = trimmed[:-1]
    return (trimmed.rstrip() + ellipsis) if trimmed else ""


def _edge_of(position: str) -> str:
    """Which horizontal band a position sits in — top, centre or bottom.

    Two overlays only compete for width when they're in the same band; one at
    the bottom and one at the top are free to use the full frame each.
    """
    if position.startswith("top"):
        return "top"
    if position.startswith("bottom"):
        return "bottom"
    return "center"


def _side_of(position: str) -> str:
    if position.endswith("left"):
        return "left"
    if position.endswith("right"):
        return "right"
    return "center"


def _anchor_xy(position: str, width: int, height: int, box_w: int, box_h: int, margin: int) -> Tuple[int, int]:
    if position == "top-left":
        return (margin, margin)
    if position == "top-right":
        return (width - box_w - margin, margin)
    if position == "center":
        return ((width - box_w) // 2, (height - box_h) // 2)
    if position == "bottom-left":
        return (margin, height - box_h - margin)
    return (width - box_w - margin, height - box_h - margin)


def card_image(
    width: int, height: int, *,
    title: str, subtitle: str = "",
    background: Optional[Image.Image] = None,
    sizes: Optional[CardTextSpec] = None,
) -> Image.Image:
    """A title or chapter screen: large centred text over a dimmed background.

    `sizes` gives the title and subtitle as percentages of the frame height, so
    one setting holds at every resolution and aspect ratio.
    """
    spec = sizes or CardTextSpec()
    base = (background.copy() if background is not None
            else gradient_background(width, height, ["#1e293b", "#0f172a"], 135)).convert("RGB")

    # Blur and darken whatever is behind so the text always has contrast.
    base = base.filter(ImageFilter.GaussianBlur(radius=max(6, width // 90)))
    base = Image.blend(base, Image.new("RGB", (width, height), (0, 0, 0)), 0.45)

    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    title_font = load_font(SEMIBOLD, max(10, int(height * spec.title_pct / 100)))
    sub_font = load_font(REGULAR, max(8, int(height * spec.subtitle_pct / 100)))
    max_width = int(width * 0.82)

    title_lines = wrap_text(draw, title or "", title_font, max_width)[:4]
    sub_lines = wrap_text(draw, subtitle or "", sub_font, max_width)[:2] if subtitle else []

    line_h = int(title_font.size * 1.22)
    sub_h = int(sub_font.size * 1.35)
    # Spacing follows the type rather than the frame, so the block stays in
    # proportion when the sizes are turned down. The multipliers reproduce the
    # default layout exactly.
    gap = int(sub_font.size * 1.05) if sub_lines else 0
    block_h = len(title_lines) * line_h + gap + len(sub_lines) * sub_h
    y = (height - block_h) // 2

    for line in title_lines:
        w = draw.textlength(line, font=title_font)
        draw.text(((width - w) / 2, y), line, font=title_font, fill=(255, 255, 255, 255))
        y += line_h
    y += gap
    for line in sub_lines:
        w = draw.textlength(line, font=sub_font)
        draw.text(((width - w) / 2, y), line, font=sub_font, fill=(226, 232, 240, 230))
        y += sub_h

    # A short rule under the block, purely so a bare title doesn't float.
    rule_w = int(width * 0.12)
    rule_y = y + int(title_font.size * 0.75)
    draw.rounded_rectangle(
        [(width - rule_w) // 2, rule_y, (width + rule_w) // 2, rule_y + max(2, height // 400)],
        radius=max(1, height // 600), fill=(129, 140, 248, 210),
    )

    return Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB")


def quote_panel(
    width: int, height: int, *,
    text: str, attribution: str = "", spec: Optional[QuoteSpec] = None,
) -> Optional[Image.Image]:
    """A pull-quote panel drawn over whatever the section is already showing.

    Returns a full-frame RGBA layer so the caller can composite it into the same
    single `overlay` input the watermark already uses, rather than adding another
    filter to every shot. Returns None when there is nothing to draw.

    The panel hugs its text rather than spanning the frame: a quotation set
    against the left edge of a photo reads as a quotation, where a full-width
    band reads as a subtitle.
    """
    body = (text or "").strip()
    if not body:
        return None
    style = spec or QuoteSpec()

    # Curly quotes unless the author already supplied their own — the panel has
    # to read as speech at a glance, before anyone has begun the sentence.
    if body[0] not in "\u201c\"\u00ab":
        body = f"\u201c{body}\u201d"

    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    margin = int(min(width, height) * 0.07)
    pad = max(8, int(height * 0.028))
    bar_w = max(3, int(height * 0.007))
    gap = int(pad * 0.9)
    # What the text may occupy once the panel's own furniture is accounted for.
    budget = max(1, width - margin * 2 - pad * 2 - bar_w - gap)

    font = fit_font(draw, body, SEMIBOLD, max(8, int(height * style.size_pct / 100)), budget)
    lines = wrap_text(draw, body, font, budget)[:8]
    line_h = int(font.size * 1.32)

    credit = (attribution or "").strip()
    credit_font = load_font(REGULAR, max(8, int(font.size * 0.5)))
    credit_lines: List[str] = []
    if credit:
        if not credit.startswith(("\u2014", "\u2013", "-")):
            credit = f"\u2014 {credit}"
        credit_lines = wrap_text(draw, credit, credit_font, budget)[:2]
    credit_h = int(credit_font.size * 1.4)
    credit_gap = int(font.size * 0.55) if credit_lines else 0

    text_w = int(max((draw.textlength(l, font=font) for l in lines), default=0))
    if credit_lines:
        text_w = max(text_w, int(max(draw.textlength(l, font=credit_font) for l in credit_lines)))
    panel_w = min(width - margin * 2, pad * 2 + bar_w + gap + text_w)
    panel_h = pad * 2 + line_h * len(lines) + credit_gap + credit_h * len(credit_lines)

    if style.position == "top":
        panel_y = margin
    elif style.position == "bottom":
        panel_y = max(0, height - panel_h - margin)
    else:
        panel_y = max(0, (height - panel_h) // 2)
    panel_x = margin

    scrim = max(0.0, min(1.0, style.scrim))
    if scrim > 0.01:
        draw.rounded_rectangle(
            [panel_x, panel_y, panel_x + panel_w, panel_y + panel_h],
            radius=max(4, int(height * 0.018)), fill=(0, 0, 0, int(255 * scrim)),
        )
    draw.rounded_rectangle(
        [panel_x + pad, panel_y + pad, panel_x + pad + bar_w, panel_y + panel_h - pad],
        radius=max(1, bar_w // 2), fill=(*parse_colour(style.accent, (129, 140, 248)), 255),
    )

    colour = parse_colour(style.color, (255, 255, 255))
    x = panel_x + pad + bar_w + gap
    y = panel_y + pad
    for line in lines:
        draw.text((x, y), line, font=font, fill=(*colour, 255))
        y += line_h
    y += credit_gap
    for line in credit_lines:
        draw.text((x, y), line, font=credit_font, fill=(226, 232, 240, 225))
        y += credit_h

    return layer


def overlay_layer(
    width: int, height: int, *,
    watermark: WatermarkSpec, watermark_icon: Optional[str],
    overlay_text: OverlayTextSpec,
) -> Optional[Image.Image]:
    """One full-frame RGBA layer carrying the watermark and the fixed text.

    Composing both into a single PNG means ffmpeg applies one `overlay` per shot
    instead of a chain of scale/overlay/drawtext filters.
    """
    wants_watermark = watermark.enabled and (watermark_icon or watermark.text.strip())
    wants_text = overlay_text.enabled and overlay_text.text.strip()
    if not wants_watermark and not wants_text:
        return None

    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # An overlay only has to share the frame's width when something else sits in
    # the same band. Alone on the bottom edge it gets the whole bottom edge, and
    # only wraps when the text genuinely doesn't fit across it.
    shares_edge = (
        wants_watermark and wants_text
        and _edge_of(overlay_text.position) == _edge_of(watermark.position)
    )
    # ...and if they're also on the same side, splitting the width wouldn't
    # separate them at all, so the watermark is stacked clear of the text instead.
    stacked = shares_edge and _side_of(overlay_text.position) == _side_of(watermark.position)

    def _budget(margin: int, taken: int = 0) -> int:
        usable = width - margin * 2 - taken
        if shares_edge and not stacked:
            usable = (usable - margin) // 2
        return max(1, usable)

    # Where the fixed text ended up, so a stacked watermark can avoid it.
    text_rect: Optional[Tuple[int, int, int, int]] = None

    if wants_text:
        margin = int(min(width, height) * max(0, min(25, overlay_text.margin_pct)) / 100)
        colour = parse_colour(overlay_text.color, (255, 255, 255))
        text_budget = _budget(margin)
        font = fit_font(
            draw, overlay_text.text, SEMIBOLD,
            max(8, int(height * overlay_text.size_pct / 100)),
            text_budget, min_size=8,
        )
        lines = wrap_text(draw, overlay_text.text, font, text_budget)[:4]
        line_h = int(font.size * 1.3)
        box_w = int(max((draw.textlength(l, font=font) for l in lines), default=0))
        box_h = line_h * len(lines)
        x, y = _anchor_xy(overlay_text.position, width, height, box_w, box_h, margin)
        text_rect = (x, y, box_w, box_h)
        for line in lines:
            lw = draw.textlength(line, font=font)
            # Right-aligned corners look wrong if the wrapped lines are ragged left.
            lx = x + (box_w - lw) if overlay_text.position.endswith("right") else x
            lx = x + (box_w - lw) / 2 if overlay_text.position == "center" else lx
            if overlay_text.shadow:
                off = max(1, font.size // 18)
                draw.text((lx + off, y + off), line, font=font, fill=(0, 0, 0, 150))
            draw.text((lx, y), line, font=font, fill=(*colour, 255))
            y += line_h

    if wants_watermark:
        margin = int(min(width, height) * max(0, min(25, watermark.margin_pct)) / 100)
        icon: Optional[Image.Image] = None
        icon_h = max(2, int(height * watermark.scale_pct / 100))
        if watermark_icon:
            try:
                with Image.open(watermark_icon) as raw:
                    raw = ImageOps.exif_transpose(raw).convert("RGBA")
                    ratio = raw.width / raw.height if raw.height else 1
                    icon = raw.resize((max(1, int(icon_h * ratio)), icon_h), Image.LANCZOS)
            except (UnidentifiedImageError, OSError, ValueError) as exc:
                logger.warning("Could not load watermark icon %s: %s", watermark_icon, exc)

        caption = watermark.text.strip()
        # Sized off the frame rather than off the icon, so the two can be
        # balanced independently — a large mark beside small type, or the reverse.
        font = load_font(REGULAR, max(8, int(height * watermark.caption_pct / 100)))
        # A caption defaulting to the note title can easily be wider than a 9:16
        # frame, so it is trimmed to whatever width this edge actually offers.
        icon_w = icon.width if icon is not None else 0
        gap = int(icon_h * 0.35) if (icon is not None and caption) else 0
        caption = truncate_to_width(draw, caption, font, _budget(margin, icon_w + gap))
        cap_w = int(draw.textlength(caption, font=font)) if caption else 0
        if not caption:
            gap = 0
        box_w = icon_w + gap + cap_w
        box_h = max(icon_h if icon is not None else 0, font.size)
        x, y = _anchor_xy(watermark.position, width, height, box_w, box_h, margin)

        if stacked and text_rect is not None:
            # Same edge and same side as the fixed text: sit clear of it rather
            # than on top of it. Bottom stacks upward, everything else downward.
            tx, ty, _tw, th = text_rect
            spacing = max(4, int(height * 0.012))
            y = ty - box_h - spacing if _edge_of(watermark.position) == "bottom" else ty + th + spacing
            y = max(0, min(height - box_h, y))

        mark = Image.new("RGBA", (max(1, box_w), max(1, box_h)), (0, 0, 0, 0))
        mdraw = ImageDraw.Draw(mark)
        cursor = 0
        if icon is not None:
            mark.paste(icon, (0, (box_h - icon.height) // 2), icon)
            cursor = icon.width + gap
        if caption:
            ty = (box_h - font.size) // 2
            off = max(1, font.size // 16)
            mdraw.text((cursor + off, ty + off), caption, font=font, fill=(0, 0, 0, 140))
            mdraw.text((cursor, ty), caption, font=font, fill=(255, 255, 255, 255))

        alpha = max(0.05, min(1.0, watermark.opacity))
        if alpha < 0.999:
            mark.putalpha(mark.getchannel("A").point(lambda v: int(v * alpha)))
        layer.alpha_composite(mark, (max(0, x), max(0, y)))

    return layer
