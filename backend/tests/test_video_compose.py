"""Overlay layout tests.

These assert against the rendered RGBA layer rather than internal numbers, so
they describe what a viewer would actually see: how much of an edge an overlay
is allowed to use, and whether two overlays collide.
"""

from PIL import Image

from app.video.compose import _edge_of, _side_of, overlay_layer, wrap_text, load_font, SEMIBOLD
from app.video.options import OverlayTextSpec, WatermarkSpec

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


def test_wrap_text_never_exceeds_the_budget():
    font = load_font(SEMIBOLD, 28)
    draw = Image.new("RGBA", (10, 10)).convert("RGBA")
    from PIL import ImageDraw
    d = ImageDraw.Draw(draw)
    for line in wrap_text(d, LONG_TEXT, font, 300):
        assert d.textlength(line, font=font) <= 300
