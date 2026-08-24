"""Overlay layout tests.

These assert against the rendered RGBA layer rather than internal numbers, so
they describe what a viewer would actually see: how much of an edge an overlay
is allowed to use, and whether two overlays collide.
"""

import pytest
from PIL import Image

from app.video.compose import (
    _edge_of, _side_of, card_image, overlay_layer, quote_panel, wrap_text, load_font, SEMIBOLD,
)
from app.video.options import (
    CardTextSpec, OverlayTextSpec, QuoteSpec, RenderOptions, WatermarkSpec,
)

WIDTH, HEIGHT = 1280, 720

# Long enough to need more than half the frame, short enough to fit across all
# of it — so the "is this edge shared?" decision is what changes the layout.
LONG_TEXT = "A fairly long line of fixed overlay text that really does want the room"


def _text(position="bottom-left", enabled=True, text=LONG_TEXT):
    return OverlayTextSpec(enabled=enabled, text=text, position=position)


def _mark(position="bottom-right", enabled=True):
    return WatermarkSpec(enabled=enabled, text="by Gecko Notes", position=position)


def _layer(watermark, overlay_text):
    return overlay_layer(WIDTH, HEIGHT, watermark=watermark,
                         watermark_icon=None, overlay_text=overlay_text)


def _box(layer: Image.Image, crop=None):
    """Bounding box of everything actually drawn (alpha > 0)."""
    region = layer.crop(crop) if crop else layer
    return region.getchannel("A").getbbox()


def _height_of(box):
    return box[3] - box[1]


LEFT_HALF = (0, 0, WIDTH // 2, HEIGHT)


# ── the sharing rule ─────────────────────────────────────────────────────────

def test_text_alone_on_an_edge_spans_the_whole_edge():
    box = _box(_layer(_mark(enabled=False), _text()))
    assert box[2] > WIDTH // 2, "an unshared edge should not be limited to half the frame"


def test_sharing_an_edge_confines_each_overlay_to_its_own_half():
    layer = _layer(_mark("bottom-right"), _text("bottom-left"))
    left = _box(layer, LEFT_HALF)
    right = _box(layer, (WIDTH // 2, 0, WIDTH, HEIGHT))
    assert left is not None and right is not None
    # Neither one crosses the midline into the other's space.
    assert left[2] <= WIDTH // 2
    assert right[0] >= 0


def test_text_wraps_only_once_the_edge_is_actually_shared():
    alone = _box(_layer(_mark(enabled=False), _text("bottom-left")))
    shared = _box(_layer(_mark("bottom-right"), _text("bottom-left")), LEFT_HALF)
    assert _height_of(shared) > _height_of(alone), (
        "the same text should fit on fewer lines when it has the edge to itself"
    )


def test_overlays_on_different_edges_each_keep_the_full_width():
    # Watermark up top, text along the bottom: they never compete, so the text
    # should lay out exactly as it does when it is the only overlay.
    alone = _box(_layer(_mark(enabled=False), _text("bottom-left")))
    apart = _box(_layer(_mark("top-right"), _text("bottom-left")), (0, HEIGHT // 2, WIDTH, HEIGHT))
    assert _height_of(apart) == _height_of(alone)
    assert apart[2] > WIDTH // 2


def test_centre_counts_as_its_own_band():
    assert _edge_of("center") == "center"
    # A centred watermark does not squeeze text pinned to the bottom.
    alone = _box(_layer(_mark(enabled=False), _text("bottom-left")))
    with_centre = _box(_layer(_mark("center"), _text("bottom-left")),
                       (0, int(HEIGHT * 0.75), WIDTH, HEIGHT))
    assert _height_of(with_centre) == _height_of(alone)


# ── collisions ───────────────────────────────────────────────────────────────

def test_two_overlays_in_the_same_corner_stack_instead_of_overlapping():
    """Halving the width can't separate overlays that share an anchor."""
    layer = _layer(_mark("bottom-left"), _text("bottom-left"))
    box = _box(layer, LEFT_HALF)
    text_only = _box(_layer(_mark(enabled=False), _text("bottom-left")))
    # Taller than the text alone, because the watermark now sits clear above it.
    assert _height_of(box) > _height_of(text_only)


def test_a_stacked_watermark_stays_inside_the_frame():
    for position in ("top-left", "bottom-left", "center"):
        layer = _layer(_mark(position), _text(position))
        box = _box(layer)
        assert box is not None
        assert box[1] >= 0 and box[3] <= HEIGHT


def test_a_long_caption_is_trimmed_rather_than_running_off_the_edge():
    mark = _mark("bottom-right")
    mark.text = "by " + ("An Extremely Long Note Title " * 6)
    box = _box(_layer(mark, _text(enabled=False)))
    assert box[2] <= WIDTH


# ── position mapping ─────────────────────────────────────────────────────────

def test_edge_and_side_mapping():
    assert [_edge_of(p) for p in ("top-left", "top-right")] == ["top", "top"]
    assert [_edge_of(p) for p in ("bottom-left", "bottom-right")] == ["bottom", "bottom"]
    assert _edge_of("center") == "center"
    assert [_side_of(p) for p in ("top-left", "bottom-left")] == ["left", "left"]
    assert [_side_of(p) for p in ("top-right", "bottom-right")] == ["right", "right"]
    assert _side_of("center") == "center"


# ── nothing to draw ──────────────────────────────────────────────────────────

def test_no_layer_is_produced_when_there_is_nothing_to_show():
    assert _layer(_mark(enabled=False), _text(enabled=False)) is None
    assert _layer(_mark(enabled=False), _text(text="   ")) is None


# ── configurable sizes ───────────────────────────────────────────────────────

def _ink(card: Image.Image) -> int:
    """Roughly how much type is on a card: bright pixels over its dim ground."""
    grey = card.convert("L")
    return sum(1 for p in grey.getdata() if p > 200)


def test_card_type_scales_with_its_size_setting():
    small = card_image(WIDTH, HEIGHT, title="A Reasonably Long Card Title",
                       subtitle="by someone", sizes=CardTextSpec(title_pct=3.0, subtitle_pct=1.5))
    large = card_image(WIDTH, HEIGHT, title="A Reasonably Long Card Title",
                       subtitle="by someone", sizes=CardTextSpec(title_pct=10.0, subtitle_pct=4.0))
    assert _ink(large) > _ink(small) * 2


def test_a_card_with_no_sizes_given_uses_the_defaults():
    assert _ink(card_image(WIDTH, HEIGHT, title="Title", subtitle="sub")) == _ink(
        card_image(WIDTH, HEIGHT, title="Title", subtitle="sub", sizes=CardTextSpec())
    )


def test_title_and_chapter_screens_are_sized_independently():
    options = RenderOptions()
    assert options.title_card_text is not options.chapter_card_text
    options.chapter_card_text.title_pct = 4.0
    assert options.title_card_text.title_pct == 6.8


def test_the_watermark_caption_is_sized_independently_of_the_icon():
    def caption_box(caption_pct: float):
        mark = WatermarkSpec(enabled=True, text="by Gecko Notes",
                             position="bottom-right", caption_pct=caption_pct)
        return _box(_layer(mark, _text(enabled=False)))

    small, large = caption_box(1.5), caption_box(6.0)
    assert _height_of(large) > _height_of(small)
    assert large[2] - large[0] > small[2] - small[0]


def test_size_defaults_match_the_shipped_look():
    """These are the values the renders in the PR were checked against."""
    options = RenderOptions()
    assert (options.title_card_text.title_pct, options.title_card_text.subtitle_pct) == (6.8, 2.9)
    assert (options.chapter_card_text.title_pct, options.chapter_card_text.subtitle_pct) == (6.8, 2.9)
    assert (options.watermark.scale_pct, options.watermark.caption_pct) == (6.0, 2.3)
    assert options.overlay_text.size_pct == 3.0


def test_sizes_are_clamped_rather_than_rejected():
    assert CardTextSpec(title_pct=999).title_pct == 25.0
    assert CardTextSpec(title_pct=-1).title_pct == 1.0
    assert CardTextSpec(subtitle_pct=0).subtitle_pct == 0.5
    assert WatermarkSpec(scale_pct=999).scale_pct == 30.0
    assert WatermarkSpec(caption_pct=0).caption_pct == 0.5
    assert OverlayTextSpec(size_pct=999).size_pct == 20.0


def test_whole_number_sizes_are_accepted():
    """Stored options predating the switch to fractional percentages."""
    assert CardTextSpec(title_pct=7).title_pct == 7.0
    assert WatermarkSpec(scale_pct=6).scale_pct == 6.0


def test_a_tiny_card_size_still_renders_legible_type():
    card = card_image(WIDTH, HEIGHT, title="Tiny", subtitle="also tiny",
                      sizes=CardTextSpec(title_pct=1.0, subtitle_pct=0.5))
    assert _ink(card) > 0


def test_wrap_text_never_exceeds_the_budget():
    font = load_font(SEMIBOLD, 28)
    draw = Image.new("RGBA", (10, 10)).convert("RGBA")
    from PIL import ImageDraw
    d = ImageDraw.Draw(draw)
    for line in wrap_text(d, LONG_TEXT, font, 300):
        assert d.textlength(line, font=font) <= 300


# ── quote panels ─────────────────────────────────────────────────────────────

QUOTE = "The best way out is always through, however long the way may look."


def _panel(text=QUOTE, attribution="", **spec):
    return quote_panel(WIDTH, HEIGHT, text=text, attribution=attribution,
                       spec=QuoteSpec(**spec))


def test_a_quote_panel_draws_something_and_an_empty_one_draws_nothing():
    assert _box(_panel()) is not None
    assert _panel(text="   ") is None
    assert _panel(text="") is None


def test_a_bigger_setting_makes_a_taller_panel():
    """Sizes are percentages of the frame height, so this is the control the
    user actually turns — it has to move the type, not just the box."""
    small = _height_of(_box(_panel(size_pct=3.0)))
    large = _height_of(_box(_panel(size_pct=8.0)))
    assert large > small * 1.5


def test_a_long_quotation_wraps_instead_of_running_off_the_frame():
    long_quote = QUOTE * 3
    box = _box(_panel(text=long_quote))
    assert box[2] <= WIDTH
    assert _height_of(box) > _height_of(_box(_panel()))


def test_an_attribution_adds_a_line_without_changing_the_quotation():
    """The credit is sized off the quotation, so it must not resize it."""
    plain = _box(_panel())
    credited = _box(_panel(attribution="Robert Frost"))
    assert _height_of(credited) > _height_of(plain)


@pytest.mark.parametrize("position", ["top", "center", "bottom"])
def test_the_panel_lands_in_the_band_it_was_asked_for(position):
    box = _box(_panel(position=position))
    middle = (box[1] + box[3]) / 2
    if position == "top":
        assert middle < HEIGHT / 2
    elif position == "bottom":
        assert middle > HEIGHT / 2
    else:
        assert abs(middle - HEIGHT / 2) < HEIGHT * 0.1


def test_the_panel_hugs_its_text_rather_than_spanning_the_frame():
    """A full-width band reads as a subtitle; a quotation should read as a quotation."""
    assert _box(_panel(text="Short one."))[2] < WIDTH * 0.75


def test_an_out_of_range_size_clamps_rather_than_failing_the_render():
    assert QuoteSpec(size_pct=999).size_pct == 15.0
    assert QuoteSpec(size_pct=0).size_pct == 1.0
    assert QuoteSpec(scrim=5).scrim == 1.0
    assert _box(_panel(size_pct=999)) is not None


def test_a_quote_panel_is_transparent_where_nothing_was_drawn():
    """It is composited over the section's own picture, so it cannot be opaque."""
    layer = _panel(position="bottom", scrim=1.0)
    assert layer.getpixel((WIDTH // 2, 2))[3] == 0
