"""Range-aware static file serving for `/media`.

The media directory holds exported videos alongside images, and a rendered video is
routinely hundreds of megabytes. A `<video>` element never downloads one of those in a
single GET: it asks for byte ranges as the viewer plays and seeks.

Starlette 0.37 (pinned by FastAPI 0.111) has no Range support in `FileResponse` — the
response `StaticFiles` returns — so it answers every request, ranged or not, with `200`
and the whole file. The browser gets a stream it cannot seek in, cancels the transfer
the moment the viewer scrubs, and re-requests from byte 0; those cancelled transfers
are the failed media GETs that show up in a network log, and on a large video they
repeat for the length of the session.

So the mount is served through :class:`RangedStaticFiles`: `StaticFiles` still resolves
and sandboxes the path (nothing here touches path handling), and only the response is
swapped for a `206 Partial Content` when the request carries a usable Range header.
"""

from __future__ import annotations

import os
import re
from typing import AsyncIterator, Optional, Tuple

import anyio
from starlette.datastructures import Headers
from starlette.responses import Response, StreamingResponse
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# A ranged request for a video can still ask for tens of megabytes, so read the slice
# back in chunks rather than loading it whole.
CHUNK_SIZE = 64 * 1024

# Only the single-range forms: "bytes=500-999", "bytes=500-" (to the end), "bytes=-500"
# (the last 500). A multi-range request needs a multipart body, is vanishingly rare from
# a media element, and is always safe to answer with the whole file instead.
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class Unsatisfiable(Exception):
    """A syntactically valid Range that falls outside the file.

    RFC 9110 says answer 416 rather than 200-with-everything: a player that asked past
    the end needs to be told the file is shorter than it thought, not handed the file
    again from the start.
    """


def parse_range(header: Optional[str], size: int) -> Optional[Tuple[int, int]]:
    """Resolve a Range header to the inclusive `(start, end)` byte pair it asks for.

    Returns ``None`` when there is no range to honour — absent, malformed, multi-range,
    or an empty file — in which case the caller serves the whole body, which is what a
    client that sent an unparseable range expects anyway. Raises :class:`Unsatisfiable`
    for a well-formed range that starts past the end of the file.
    """
    if not header or size <= 0:
        return None
    match = _RANGE_RE.match(header.strip())
    if not match:
        return None

    first, last = match.group(1), match.group(2)
    if first:
        start = int(first)
        end = int(last) if last else size - 1
    elif last:
        # A suffix range ("bytes=-500") asks for the LAST n bytes, not the first n.
        start = max(size - int(last), 0)
        end = size - 1
    else:
        return None  # "bytes=-" names nothing

    if start >= size:
        raise Unsatisfiable
    end = min(end, size - 1)
    if start > end:
        raise Unsatisfiable
    return start, end


async def iter_slice(path: str | os.PathLike, start: int, end: int) -> AsyncIterator[bytes]:
    """Yield bytes `[start, end]` inclusive from `path`, a chunk at a time."""
    remaining = end - start + 1
    async with await anyio.open_file(path, mode="rb") as handle:
        await handle.seek(start)
        while remaining > 0:
            chunk = await handle.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break  # the file shrank under us; stop rather than loop forever
            remaining -= len(chunk)
            yield chunk


class RangedStaticFiles(StaticFiles):
    """`StaticFiles` that answers a ranged request with `206 Partial Content`."""

    def file_response(
        self,
        full_path: os.PathLike,
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        # Advertise range support even on a full response: without this header a media
        # element assumes the server has none and won't offer seeking at all.
        response.headers.setdefault("accept-ranges", "bytes")

        # A 304 has no body to slice and anything else is an error page, not the file.
        if status_code != 200 or response.status_code != 200:
            return response

        size = stat_result.st_size
        try:
            span = parse_range(Headers(scope=scope).get("range"), size)
        except Unsatisfiable:
            return Response(
                status_code=416,
                headers={"content-range": f"bytes */{size}", "accept-ranges": "bytes"},
            )
        if span is None:
            return response

        start, end = span
        partial = StreamingResponse(iter_slice(full_path, start, end), status_code=206)
        # Carry over what the full response already worked out, so a ranged and an
        # unranged fetch describe the same entity, then say which slice this is.
        for header in ("content-type", "etag", "last-modified"):
            value = response.headers.get(header)
            if value:
                partial.headers[header] = value
        partial.headers["content-range"] = f"bytes {start}-{end}/{size}"
        partial.headers["content-length"] = str(end - start + 1)
        partial.headers["accept-ranges"] = "bytes"
        return partial
