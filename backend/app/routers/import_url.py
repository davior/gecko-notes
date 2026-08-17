"""Import a web page as a note.

Backs the "Import URL" action with two endpoints:

  POST /api/import/url/extract    fetch a page, return its main content as Markdown
  POST /api/import/url/resources  download image URLs into the caller's media dir

They are deliberately split. The modal previews an extraction before anything is written
to /media, so cancelling an import leaves nothing behind — worth caring about because the
app has no orphan-media collection (deleting a note leaves its uploads on disk).

The Markdown handoff is not incidental: the frontend already turns Markdown into BlockNote
blocks for the "Import Markdown" action, so returning Markdown lets a web page ride the
exact same path into a note.
"""

import asyncio
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import trafilatura
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from lxml import html as lxml_html

from app.limiter import limiter
from app.routers.media import IMAGE_EXTENSIONS, get_user_media_dir
from app.schemas import (
    DataResponse,
    ResourceFetchRequest,
    ResourceFetchResult,
    UrlExtractRequest,
    UrlExtractResult,
)
from app.thumbnails import generate_thumbnail
from app.web_fetch import FetchError, fetch_document, fetch_image

router = APIRouter()

logger = logging.getLogger(__name__)

# Bounds for one import. The per-image byte cap lives in web_fetch (MAX_IMAGE_BYTES).
MAX_IMAGES_PER_IMPORT = 50
MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024
IMAGE_CONCURRENCY = 5

# When trafilatura finds no article it falls back to dumping whatever text the page has,
# which on a nav-only listing page is a handful of menu labels. Anything this short is
# far likelier to be that fallback than a real article, and saying so beats silently
# creating a note that reads "Home About Contact".
MIN_CONTENT_CHARS = 200

# Only content types that map to an extension media.py will accept. SVG is deliberately
# absent — ALLOWED_EXTENSIONS has no .svg, so those images stay remote rather than being
# written under a name the rest of the app would not serve back.
_CONTENT_TYPE_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/pjpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "image/heic": ".heic",
    "image/heif": ".heif",
}

# Attributes lazy-loading scripts stash the real image URL in, most specific first.
_LAZY_SRC_ATTRS = ("data-src", "data-original", "data-lazy-src", "data-actualsrc", "data-hi-res-src")
_LAZY_SRCSET_ATTRS = ("data-srcset", "data-lazy-srcset")

# Matches trafilatura's `![alt](url)` output. URLs containing parentheses are missed,
# which only means that image stays remote instead of being downloaded.
_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)")


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _fetch_error(exc: FetchError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": exc.message})


def _best_from_srcset(srcset: str) -> Optional[str]:
    """Pick the highest-resolution candidate out of a srcset attribute.

    Without this the importer saves thumbnails: trafilatura reads `src`, which on a
    responsive image is the smallest fallback, so a 1600w hero arrives as a 400w crop.
    """
    best_url: Optional[str] = None
    best_score = -1.0
    for candidate in srcset.split(","):
        parts = candidate.split()
        if not parts:
            continue
        url = parts[0].strip()
        if not url:
            continue
        score = 1.0
        if len(parts) > 1:
            descriptor = parts[1].strip().lower()
            try:
                if descriptor.endswith("w"):
                    score = float(descriptor[:-1])
                elif descriptor.endswith("x"):
                    # Density descriptors never coexist with width ones; scale them so a
                    # 2x beats a 1x without outranking a genuine pixel width.
                    score = float(descriptor[:-1])
            except ValueError:
                score = 1.0
        if score > best_score:
            best_url, best_score = url, score
    return best_url


def _normalise_images(tree: lxml_html.HtmlElement) -> None:
    """Rewrite lazy-loaded and responsive <img> tags into a plain, best-quality `src`.

    Modern pages overwhelmingly ship either a 1×1 placeholder with the real URL in a
    data- attribute, or a srcset whose `src` fallback is the smallest variant. Both make
    the extractor emit useless images, so normalise before handing the tree over.
    """
    for picture in tree.iter("picture"):
        # <source srcset> beats the inner <img src> for quality; hoist the best one.
        best: Optional[str] = None
        best_score = -1.0
        for source in picture.iter("source"):
            candidate = _best_from_srcset(source.get("srcset") or source.get("data-srcset") or "")
            if candidate and best_score < 1:
                best, best_score = candidate, 1
        if best:
            for img in picture.iter("img"):
                img.set("src", best)
                break

    for img in tree.iter("img"):
        src = (img.get("src") or "").strip()
        placeholder = not src or src.startswith("data:")

        for attr in _LAZY_SRCSET_ATTRS:
            candidate = _best_from_srcset(img.get(attr) or "")
            if candidate:
                img.set("src", candidate)
                src, placeholder = candidate, False
                break

        if placeholder:
            for attr in _LAZY_SRC_ATTRS:
                candidate = (img.get(attr) or "").strip()
                if candidate and not candidate.startswith("data:"):
                    img.set("src", candidate)
                    src, placeholder = candidate, False
                    break

        # A real srcset outranks the src fallback even when the src is valid.
        candidate = _best_from_srcset(img.get("srcset") or "")
        if candidate:
            img.set("src", candidate)

        # Strip the lazy attributes so the extractor can't pick a stale one back up.
        for attr in _LAZY_SRC_ATTRS + _LAZY_SRCSET_ATTRS + ("srcset", "loading"):
            if img.get(attr) is not None:
                del img.attrib[attr]


def _prepare_html(body: bytes, base_url: str) -> str:
    """Parse, normalise images, and re-serialise a page for extraction."""
    try:
        tree = lxml_html.fromstring(body)
    except Exception:
        # Undecodable or empty markup — hand the raw bytes to trafilatura, which has
        # its own tolerant parser and may still find something.
        return body.decode("utf-8", errors="replace")

    _normalise_images(tree)
    # Resolve every relative href/src against the page URL up front, so the Markdown
    # comes out with absolute links regardless of what the extractor does.
    try:
        tree.make_links_absolute(base_url, resolve_base_href=True)
    except ValueError:
        pass
    return lxml_html.tostring(tree, encoding="unicode")


def _absolutise_markdown(markdown: str, base_url: str) -> str:
    """Backstop for any link the HTML pass missed (extractor-synthesised URLs)."""

    def fix(match: re.Match) -> str:
        url = match.group(2)
        if url.startswith(("http://", "https://", "data:", "#", "mailto:")):
            return match.group(0)
        return f"{match.group(1)}({urljoin(base_url, url)}"

    return re.sub(r"(!?\[[^\]]*\])\(\s*([^)\s]+)", fix, markdown)


def _collect_image_urls(markdown: str) -> List[str]:
    """Unique http(s) image URLs in document order. data: URIs render fine as-is."""
    seen: Dict[str, None] = {}
    for match in _MD_IMAGE_RE.finditer(markdown):
        url = match.group(1).strip("<>")
        if url.startswith(("http://", "https://")):
            seen.setdefault(url, None)
    return list(seen)


@router.post("/url/extract", response_model=DataResponse[UrlExtractResult])
@limiter.limit("20/minute")
async def extract_url(payload: UrlExtractRequest, request: Request):
    """Fetch a page and return its main content as Markdown plus page metadata.

    Nothing is persisted — this only reads. Rate limited so the endpoint can't be
    driven as a general-purpose proxy or port scanner by an authenticated account.
    """
    _get_user_id(request)

    try:
        final_url, body = await fetch_document(payload.url)
    except FetchError as exc:
        raise _fetch_error(exc)

    if not body:
        raise HTTPException(
            status_code=422,
            detail={"code": "empty_page", "message": "That page returned no content"},
        )

    prepared = _prepare_html(body, final_url)

    markdown = trafilatura.extract(
        prepared,
        url=final_url,
        output_format="markdown",
        include_images=True,
        include_links=True,
        include_formatting=True,
        include_tables=True,
        # A reader's comment section is not part of the article.
        include_comments=False,
    )

    markdown = (markdown or "").strip()
    if len(markdown) < MIN_CONTENT_CHARS:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "extraction_failed",
                "message": (
                    "Couldn't find an article on that page. It may be a listing page, "
                    "or need JavaScript or a login to show its content."
                ),
            },
        )

    markdown = _absolutise_markdown(markdown, final_url)

    metadata = None
    try:
        metadata = trafilatura.extract_metadata(prepared, default_url=final_url)
    except Exception:
        logger.debug("metadata extraction failed for %s", final_url, exc_info=True)

    def meta(name: str) -> Optional[str]:
        value = getattr(metadata, name, None) if metadata else None
        value = (value or "").strip() if isinstance(value, str) else None
        return value or None

    hostname = (urlparse(final_url).hostname or "").lower()
    if hostname.startswith("www."):
        hostname = hostname[4:]

    return DataResponse(data=UrlExtractResult(
        url=final_url,
        title=meta("title") or hostname or "Untitled",
        byline=meta("author"),
        published=meta("date"),
        site_name=meta("sitename"),
        excerpt=meta("description"),
        hostname=hostname,
        markdown=markdown,
        image_urls=_collect_image_urls(markdown),
    ))


def _extension_for(content_type: str, url: str) -> Optional[str]:
    ext = _CONTENT_TYPE_EXT.get(content_type)
    if ext:
        return ext
    # Some CDNs serve images as application/octet-stream; fall back to the URL's own
    # extension, but only if it is one media.py would have accepted on upload.
    path_ext = os.path.splitext(urlparse(url).path)[1].lower()
    return path_ext if path_ext in IMAGE_EXTENSIONS else None


@router.post("/url/resources", response_model=DataResponse[ResourceFetchResult])
@limiter.limit("10/minute")
async def fetch_resources(
    payload: ResourceFetchRequest,
    request: Request,
    background_tasks: BackgroundTasks,
):
    """Download images into the caller's media dir and map remote URL -> /media URL.

    Every URL is re-validated: this list is client-supplied and must not be trusted just
    because /url/extract produced one like it. Failures are collected rather than raised
    so one dead asset doesn't cost the user the whole import.
    """
    user_id = _get_user_id(request)

    urls = [u for u in dict.fromkeys(payload.urls) if u.startswith(("http://", "https://"))]
    if len(urls) > MAX_IMAGES_PER_IMPORT:
        urls = urls[:MAX_IMAGES_PER_IMPORT]

    user_dir = get_user_media_dir(user_id)
    mapping: Dict[str, str] = {}
    failed: List[str] = []
    total_bytes = 0
    semaphore = asyncio.Semaphore(IMAGE_CONCURRENCY)
    lock = asyncio.Lock()

    async def grab(url: str) -> None:
        nonlocal total_bytes
        async with semaphore:
            try:
                _, data, content_type = await fetch_image(url, referer=payload.page_url)
            except FetchError:
                failed.append(url)
                return
            except Exception:
                logger.debug("image download failed: %s", url, exc_info=True)
                failed.append(url)
                return

            ext = _extension_for(content_type, url)
            if not ext:
                failed.append(url)
                return

            async with lock:
                if total_bytes + len(data) > MAX_TOTAL_IMAGE_BYTES:
                    failed.append(url)
                    return
                total_bytes += len(data)

            filename = f"{uuid.uuid4()}{ext}"
            file_path = os.path.join(user_dir, filename)
            try:
                with open(file_path, "wb") as handle:
                    handle.write(data)
            except OSError:
                logger.warning("could not write imported image to %s", file_path, exc_info=True)
                failed.append(url)
                return

            background_tasks.add_task(generate_thumbnail, Path(file_path))
            mapping[url] = f"/media/{user_id}/{filename}"

    await asyncio.gather(*(grab(url) for url in urls))

    return DataResponse(data=ResourceFetchResult(mapping=mapping, failed=failed))
