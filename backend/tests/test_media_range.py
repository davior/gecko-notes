"""Tests for serving /media with HTTP Range support.

The bug these are written against: a note's exported video is hundreds of megabytes,
and Starlette's StaticFiles answers a ranged request with 200 and the whole file. The
browser cancels the transfer on every seek and starts again from byte 0 — the failed
media GETs in a network log. These check the response the player actually needs.

Pure ASGI: a temp directory of files, no database, no network.
"""

import pytest
from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.media_files import RangedStaticFiles, Unsatisfiable, parse_range

BODY = bytes(range(256)) * 8  # 2048 bytes of known, position-identifying content


@pytest.fixture
def client(tmp_path):
    (tmp_path / "clip.mp4").write_bytes(BODY)
    (tmp_path / "empty.bin").write_bytes(b"")
    app = Starlette()
    app.mount("/media", RangedStaticFiles(directory=str(tmp_path)), name="media")
    return TestClient(app)


# ─── Parsing ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "header,expected",
    [
        ("bytes=0-99", (0, 99)),
        ("bytes=100-199", (100, 199)),
        ("bytes=742964-", (742964, 999999)),          # the open-ended seek a player sends
        ("bytes=-500", (999500, 999999)),             # the last 500 bytes, not the first
        ("bytes=999990-1000005", (999990, 999999)),   # clamped to the end of the file
        ("bytes = 0-99 ", None),                      # malformed → serve it whole
        ("bytes=0-99, 200-299", None),                # multi-range → serve it whole
        ("items=0-99", None),
        ("bytes=-", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_range(header, expected):
    assert parse_range(header, 1_000_000) == expected


def test_a_range_past_the_end_is_unsatisfiable():
    with pytest.raises(Unsatisfiable):
        parse_range("bytes=2048-", 2048)


def test_an_empty_file_has_no_range_to_serve():
    assert parse_range("bytes=0-", 0) is None


# ─── Responses ────────────────────────────────────────────────────────────────


def test_an_unranged_request_still_gets_the_whole_file(client):
    res = client.get("/media/clip.mp4")
    assert res.status_code == 200
    assert res.content == BODY
    # Without this a media element assumes seeking is unavailable and never asks.
    assert res.headers["accept-ranges"] == "bytes"


def test_a_ranged_request_gets_exactly_that_slice(client):
    res = client.get("/media/clip.mp4", headers={"Range": "bytes=100-199"})
    assert res.status_code == 206
    assert res.content == BODY[100:200]
    assert res.headers["content-range"] == f"bytes 100-199/{len(BODY)}"
    assert res.headers["content-length"] == "100"
    assert res.headers["accept-ranges"] == "bytes"


def test_an_open_ended_seek_gets_the_rest_of_the_file(client):
    """The shape a <video> sends when the viewer scrubs: "everything from here on"."""
    res = client.get("/media/clip.mp4", headers={"Range": "bytes=2000-"})
    assert res.status_code == 206
    assert res.content == BODY[2000:]
    assert res.headers["content-range"] == f"bytes 2000-2047/{len(BODY)}"


def test_a_suffix_range_gets_the_tail(client):
    res = client.get("/media/clip.mp4", headers={"Range": "bytes=-48"})
    assert res.status_code == 206
    assert res.content == BODY[-48:]


def test_a_ranged_and_an_unranged_fetch_describe_the_same_entity(client):
    full = client.get("/media/clip.mp4")
    part = client.get("/media/clip.mp4", headers={"Range": "bytes=0-9"})
    assert part.headers["content-type"] == full.headers["content-type"] == "video/mp4"
    assert part.headers["etag"] == full.headers["etag"]
    assert part.headers["last-modified"] == full.headers["last-modified"]


def test_a_range_past_the_end_is_refused_not_answered_in_full(client):
    res = client.get("/media/clip.mp4", headers={"Range": f"bytes={len(BODY)}-"})
    assert res.status_code == 416
    assert res.headers["content-range"] == f"bytes */{len(BODY)}"
    assert res.content == b""


def test_an_unparseable_range_falls_back_to_the_whole_file(client):
    res = client.get("/media/clip.mp4", headers={"Range": "bytes=0-99, 200-299"})
    assert res.status_code == 200
    assert res.content == BODY


def test_an_empty_file_is_served_whole(client):
    res = client.get("/media/empty.bin", headers={"Range": "bytes=0-"})
    assert res.status_code == 200
    assert res.content == b""


def test_a_missing_file_is_still_a_404(client):
    assert client.get("/media/nope.mp4", headers={"Range": "bytes=0-9"}).status_code == 404


def test_the_directory_sandbox_is_untouched(client):
    """Path handling is StaticFiles'; this only swaps the response."""
    assert client.get("/media/../secret.txt").status_code in (404, 400)
