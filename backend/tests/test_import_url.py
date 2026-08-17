"""Tests for the URL importer's HTML/Markdown helpers and its SSRF guard.

These cover the pure functions only — no database, no network, no app startup — so the
whole file runs in well under a second.

The srcset cases carry the most weight. Importing a Substack article once produced a note
whose image pointed at
`https://<publication>.substack.com/p/fl_progressive:steep/https%3A%2F%2F...`: a fragment
of a Cloudinary-style URL that a comma-split had shredded, then resolved against the page.
`test_substack_cloudinary_srcset_survives_commas` is that regression.
"""

import asyncio

import pytest

from app.routers.import_url import (
    _absolutise_markdown,
    _best_from_srcset,
    _collect_image_urls,
    _descriptor_score,
    _extension_for,
    _parse_srcset,
    _prepare_html,
)
from app.routers.notes import _thumbnail_url_for
from app.web_fetch import FetchError, assert_public_url

PAGE_URL = "https://example.com/news/story"

# The shape Substack serves: a signed Cloudinary transform whose parameters are
# comma-separated, wrapping a percent-encoded S3 source URL.
_SUBSTACK_TEMPLATE = (
    "https://substackcdn.com/image/fetch/$s_!qRnE!,w_{w},c_limit,f_auto,q_auto:good,"
    "fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic"
    "%2Fimages%2Fc947100f-8944-4997-b1dc-b98c8dd5f84c_784x1168.jpeg"
)
SUBSTACK_SRCSET = ", ".join(
    f"{_SUBSTACK_TEMPLATE.format(w=width)} {width}w" for width in (424, 848, 1272, 1456)
)


# ─── srcset parsing ───────────────────────────────────────────────────────────


def test_substack_cloudinary_srcset_survives_commas():
    """The regression: commas inside a candidate URL are not candidate separators."""
    best = _best_from_srcset(SUBSTACK_SRCSET)

    assert best == _SUBSTACK_TEMPLATE.format(w=1456)
    # The whole URL, not a fragment of it.
    assert best.startswith("https://substackcdn.com/image/fetch/")
    assert "c_limit,f_auto" in best
    assert not best.startswith("fl_progressive")

    assert len(_parse_srcset(SUBSTACK_SRCSET)) == 4


def test_picks_largest_width_descriptor():
    srcset = "/img/small.jpg 400w, /img/large.jpg 1600w, /img/mid.jpg 800w"
    assert _best_from_srcset(srcset) == "/img/large.jpg"


def test_picks_largest_density_descriptor():
    assert _best_from_srcset("/a.jpg, /b.jpg 2x, /c.jpg 3x") == "/c.jpg"


def test_single_candidate_without_descriptor():
    assert _best_from_srcset("/only.jpg") == "/only.jpg"
    assert _parse_srcset("/only.jpg") == [("/only.jpg", 1.0)]


def test_trailing_comma_marks_a_descriptorless_candidate():
    assert _parse_srcset("/a.jpg,") == [("/a.jpg", 1.0)]
    assert _parse_srcset("/a.jpg, /b.jpg 2x") == [("/a.jpg", 1.0), ("/b.jpg", 2.0)]


def test_a_comma_not_followed_by_whitespace_stays_inside_the_url():
    """The spec runs the URL token to the next whitespace, so an unspaced comma is part
    of the URL rather than a separator. That is precisely the rule that keeps Cloudinary
    transform URLs whole, so it is worth pinning down rather than leaving implied."""
    assert _parse_srcset("/a.jpg,,/b.jpg 2x") == [("/a.jpg,,/b.jpg", 2.0)]


def test_irregular_whitespace():
    assert _best_from_srcset("  /a.jpg   400w ,   /b.jpg   900w  ") == "/b.jpg"


def test_comma_bearing_url_without_a_descriptor():
    url = "https://cdn.example.com/x/w_1,h_2/img.jpg"
    assert _parse_srcset(url) == [(url, 1.0)]


def test_empty_and_blank_srcset():
    assert _parse_srcset("") == []
    assert _parse_srcset("   ") == []
    assert _best_from_srcset("") is None


@pytest.mark.parametrize(
    "descriptor,expected",
    [("1456w", 1456.0), ("2x", 2.0), ("1.5x", 1.5), ("", 1.0), ("junk", 1.0), ("xw", 1.0)],
)
def test_descriptor_scoring(descriptor, expected):
    assert _descriptor_score(descriptor) == expected


# ─── image normalisation (the pre-pass trafilatura sees) ──────────────────────


def _images_in(html: str) -> list:
    from lxml import html as lxml_html

    return [img.get("src") for img in lxml_html.fromstring(html).iter("img")]


def test_substack_article_image_normalises_to_the_full_cdn_url():
    """End-to-end through the pre-pass: the reported bug, at the level it occurred."""
    html = f'<html><body><article><img src="/small.jpg" srcset="{SUBSTACK_SRCSET}"></article></body></html>'.encode()

    assert _images_in(_prepare_html(html, PAGE_URL)) == [_SUBSTACK_TEMPLATE.format(w=1456)]


def test_lazy_data_src_replaces_a_data_uri_placeholder():
    html = (
        b'<html><body><img data-src="/img/real.jpg" '
        b'src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="lazy"></body></html>'
    )
    assert _images_in(_prepare_html(html, PAGE_URL)) == ["https://example.com/img/real.jpg"]


def test_srcset_outranks_a_valid_but_small_src():
    html = b'<html><body><img src="/img/small.jpg" srcset="/img/small.jpg 400w, /img/large.jpg 1600w"></body></html>'
    assert _images_in(_prepare_html(html, PAGE_URL)) == ["https://example.com/img/large.jpg"]


def test_picture_source_is_hoisted_onto_the_inner_img():
    html = (
        b'<html><body><picture>'
        b'<source srcset="/img/hi.webp 1200w" type="image/webp">'
        b'<source srcset="/img/huge.jpg 2000w" type="image/jpeg">'
        b'<img src="/img/lo.jpg"></picture></body></html>'
    )
    # Largest across every source, not merely the first one.
    assert _images_in(_prepare_html(html, PAGE_URL)) == ["https://example.com/img/huge.jpg"]


def test_plain_image_is_left_alone_apart_from_being_absolutised():
    html = b'<html><body><img src="/img/plain.jpg" alt="plain"></body></html>'
    assert _images_in(_prepare_html(html, PAGE_URL)) == ["https://example.com/img/plain.jpg"]


def test_lazy_attributes_are_stripped_so_the_extractor_cannot_reuse_them():
    html = b'<html><body><img data-src="/img/real.jpg" src="data:image/gif;base64,AA" srcset="/img/x.jpg 9w"></body></html>'
    prepared = _prepare_html(html, PAGE_URL)
    assert "data-src" not in prepared
    assert "srcset" not in prepared


def test_unparseable_markup_falls_back_to_raw_text():
    assert _prepare_html(b"", PAGE_URL) == ""


# ─── markdown post-processing ─────────────────────────────────────────────────


def test_absolutise_markdown_resolves_relative_targets_only():
    markdown = "![a](/x.jpg) [b](/y) [c](https://z.com/q) ![d](data:image/png;base64,AA) [e](mailto:a@b.c)"
    result = _absolutise_markdown(markdown, "https://example.com/n/")

    assert "![a](https://example.com/x.jpg)" in result
    assert "[b](https://example.com/y)" in result
    assert "[c](https://z.com/q)" in result
    assert "![d](data:image/png;base64,AA)" in result
    assert "[e](mailto:a@b.c)" in result


def test_collect_image_urls_dedupes_keeps_order_and_skips_data_uris():
    markdown = (
        "![a](https://e.com/1.jpg) ![b](data:image/gif;base64,X) "
        "![c](https://e.com/2.png) ![d](https://e.com/1.jpg)"
    )
    assert _collect_image_urls(markdown) == ["https://e.com/1.jpg", "https://e.com/2.png"]


def test_collect_image_urls_keeps_comma_bearing_cdn_urls_whole():
    url = _SUBSTACK_TEMPLATE.format(w=1456)
    assert _collect_image_urls(f"![hero]({url})") == [url]


# ─── stored-file extensions ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    "content_type,url,expected",
    [
        ("image/jpeg", "https://e.com/x", ".jpg"),
        ("image/png", "https://e.com/x", ".png"),
        # Some CDNs serve octet-stream; fall back to the URL's extension.
        ("application/octet-stream", "https://e.com/x.PNG?w=1", ".png"),
        # media.py has no .svg in ALLOWED_EXTENSIONS, so these stay remote.
        ("image/svg+xml", "https://e.com/x.svg", None),
        ("application/octet-stream", "https://e.com/x", None),
    ],
)
def test_extension_for(content_type, url, expected):
    assert _extension_for(content_type, url) == expected


# ─── thumbnails are only derived for local uploads ────────────────────────────


def test_thumbnail_url_derived_for_media_uploads():
    assert _thumbnail_url_for("/media/u1/abc.png") == "/media/u1/abc.thumb.png"


def test_no_thumbnail_url_for_remote_or_missing_images():
    # A URL import that linked its images rather than downloading them.
    assert _thumbnail_url_for("https://substackcdn.com/image/fetch/x.jpeg") is None
    assert _thumbnail_url_for(None) is None
    assert _thumbnail_url_for("") is None


# ─── SSRF guard ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url,code",
    [
        ("http://127.0.0.1/", "ssrf_blocked"),
        ("http://localhost:8000/", "ssrf_blocked"),
        ("http://169.254.169.254/latest/meta-data/", "ssrf_blocked"),  # cloud metadata
        ("http://192.168.1.1/", "ssrf_blocked"),
        ("http://10.0.0.5/admin", "ssrf_blocked"),
        ("http://[::1]/", "ssrf_blocked"),
        ("http://0.0.0.0/", "ssrf_blocked"),
        ("file:///etc/passwd", "invalid_url"),
        ("ftp://example.com/x", "invalid_url"),
        ("javascript:alert(1)", "invalid_url"),
        ("https://", "invalid_url"),
    ],
)
def test_private_and_non_http_urls_are_rejected(url, code):
    with pytest.raises(FetchError) as excinfo:
        asyncio.run(assert_public_url(url))

    assert excinfo.value.code == code
    assert excinfo.value.status_code == 400


def test_public_url_is_allowed():
    try:
        result = asyncio.run(assert_public_url("https://example.com/real-page"))
    except FetchError as exc:
        if exc.code == "dns_failed":
            pytest.skip("no DNS resolution available in this environment")
        raise

    assert result == "https://example.com/real-page"
