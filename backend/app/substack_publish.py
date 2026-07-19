"""Publish a gecko-notes note to Substack as a draft via the `python-substack` SDK.

Every `substack` import and call is isolated in this module so the (alpha, fast-moving)
library surface lives in exactly one place. The library is synchronous (built on
`requests`), so callers must run these functions off the event loop (e.g. FastAPI's
`run_in_threadpool`).

Auth is cookie-only: Substack blocks scripted email/password logins behind a captcha,
so the user pastes their browser session-cookie string instead.

Image handling: `create_draft_from_markdown` would embed non-`http` image sources as-is
(or upload them relative to the process CWD, which is fragile). Instead we upload every
referenced image ourselves via `Api.get_image` and rewrite each Markdown `src` to the
returned Substack-hosted URL *before* handing the Markdown to the library — so the library
only ever sees `http` URLs it leaves untouched. We handle three source kinds:
  • `data:` URIs        — rasterized Mermaid diagrams (decoded to a temp file)
  • `/media/<file>` refs — the note's own images, read straight off disk (MEDIA_DIR)
  • other `http(s)` URLs — external images, downloaded to a temp file (best-effort)
An image that can't be uploaded is dropped (local refs) or left as its original URL
(remote refs) so the draft is still created.
"""
import base64
import logging
import os
import re
import tempfile
from typing import List, Optional
from urllib.parse import unquote, urlparse

import httpx

logger = logging.getLogger(__name__)

# Markdown image: ![alt](src "optional title"). `src` stops at whitespace or ')'.
# Base64 data URIs contain neither, so they are captured whole.
_MD_IMAGE_RE = re.compile(r'!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)(?P<title>\s+"[^"]*")?\)')
_DATA_URI_RE = re.compile(r'^data:(?P<mime>[^;,]*)(?P<b64>;base64)?,(?P<data>.*)$', re.DOTALL)
_MEDIA_MARKER = "/media/"


class SubstackError(Exception):
    """Publishing failed, carrying a message safe to show the user (no secrets)."""


def create_substack_draft(
    *,
    publication_url: str,
    cookie: str,
    title: str,
    markdown: str,
    subtitle: str = "",
    tags: Optional[List[str]] = None,
    media_dir: str,
) -> str:
    """Create a Substack **draft** from Markdown and return the draft id (as a string).

    Never publishes — `create_draft_from_markdown` defaults to draft-only. Raises
    :class:`SubstackError` with a user-facing message on any failure.
    """
    from substack import Api  # local import keeps the dependency contained to this module

    if not publication_url or not cookie:
        raise SubstackError("Substack is not configured. Add your publication URL and session cookie in Settings → Publishing.")

    try:
        api = Api(cookies_string=cookie, publication_url=publication_url)
    except Exception as e:  # malformed cookie string, bad URL, etc.
        raise SubstackError(f"Couldn't initialise the Substack client: {e}") from e

    # Upload images first so the library only sees hosted http URLs.
    try:
        markdown = _upload_and_rewrite_images(api, markdown, media_dir)
    except _AuthError as e:
        raise SubstackError(str(e)) from e
    except Exception:
        # A non-auth image failure shouldn't sink the whole publish — individual
        # images already fail soft inside the helper; this guards the pass itself.
        logger.warning("Substack image pass failed; publishing with original sources", exc_info=True)

    try:
        result = api.create_draft_from_markdown(
            title=title or "Untitled",
            markdown=markdown,
            subtitle=subtitle or "",
        )
    except Exception as e:
        raise SubstackError(_auth_hint(e, "create the draft")) from e

    draft = (result or {}).get("draft") or {}
    draft_id = draft.get("id")
    if not draft_id:
        raise SubstackError("Substack accepted the request but returned no draft id.")

    # Tags are best-effort: a tag failure must not fail an already-created draft.
    clean_tags = [t.strip() for t in (tags or []) if t and t.strip()]
    if clean_tags:
        try:
            api.add_tags_to_post(draft_id, clean_tags)
        except Exception:
            logger.warning("Failed to add tags to Substack draft %s", draft_id, exc_info=True)

    return str(draft_id)


def test_substack_connection(*, publication_url: str, cookie: str) -> None:
    """Verify a cookie + publication URL without creating anything. Raises
    :class:`SubstackError` with a user-facing message on failure, returns None on success.

    Constructing the Api already makes an authenticated call (it fetches the user's
    publications and matches the publication subdomain), so a bad cookie or a wrong URL
    surfaces there; `get_user_id()` is a second lightweight authenticated read to be sure."""
    from substack import Api

    if not publication_url or not cookie:
        raise SubstackError("Enter both a publication URL and a session cookie first.")
    try:
        api = Api(cookies_string=cookie, publication_url=publication_url)
        api.get_user_id()
    except Exception as e:
        raise SubstackError(_connect_error_message(e, publication_url)) from e


class _AuthError(Exception):
    """Internal: an image call failed in a way that looks like an expired cookie."""


def _upload_and_rewrite_images(api, markdown: str, media_dir: str) -> str:
    """Upload every Markdown image to Substack and rewrite each `src` to the hosted URL."""
    cache: dict[str, Optional[str]] = {}

    def _replace(match: "re.Match[str]") -> str:
        src = match.group("src")
        if src not in cache:
            cache[src] = _upload_one(api, src, media_dir)
        hosted = cache[src]
        if hosted:
            return f'![{match.group("alt")}]({hosted}{match.group("title") or ""})'
        # Couldn't upload. Keep a remote URL (Substack may fetch it); drop a local/data
        # ref (leaving it would make the library POST a bogus image path).
        if src.startswith("http://") or src.startswith("https://"):
            return match.group(0)
        alt = match.group("alt")
        return alt or ""

    return _MD_IMAGE_RE.sub(_replace, markdown)


def _upload_one(api, src: str, media_dir: str) -> Optional[str]:
    """Return a Substack-hosted URL for `src`, or None if it can't be uploaded.

    Only a genuine Substack auth failure propagates (as :class:`_AuthError`); every
    other problem — a missing local file, an undownloadable/forbidden remote image, a
    bad data URI, or Substack rejecting a single image — fails soft (returns None) so
    the rest of the draft still publishes. Distinguishing the two matters: a 403 from
    fetching an *external* image is not the user's Substack cookie expiring."""
    tmp: Optional[str] = None
    try:
        if src.startswith("data:"):
            tmp = path = _data_uri_to_temp(src)
        else:
            path = _resolve_media_path(src, media_dir)
            if not path and (src.startswith("http://") or src.startswith("https://")):
                tmp = path = _download_to_temp(src)  # download failure → soft fail below
        if not path:
            return None
        # Only failures from here (the Substack image endpoint) can be auth errors.
        try:
            result = api.get_image(path)
        except Exception as e:
            if _looks_like_auth_error(e):
                raise _AuthError(_auth_hint(e, "upload an image"))
            raise
        return (result or {}).get("url") or None
    except _AuthError:
        raise
    except Exception as e:
        logger.warning("Skipping Substack image %r: %s", src[:80], e)
        return None
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _resolve_media_path(src: str, media_dir: str) -> Optional[str]:
    """Map a `/media/<file>` reference (root-relative or absolute URL) to the local
    file under MEDIA_DIR, guarding against path traversal. None if it isn't ours or
    the file is missing."""
    path = urlparse(src).path if "://" in src else src
    idx = path.find(_MEDIA_MARKER)
    if idx == -1:
        return None
    rel = unquote(path[idx + len(_MEDIA_MARKER):])
    if not rel:
        return None
    root = os.path.realpath(media_dir)
    candidate = os.path.realpath(os.path.join(root, rel))
    if candidate != root and not candidate.startswith(root + os.sep):
        return None  # traversal attempt
    return candidate if os.path.isfile(candidate) else None


def _data_uri_to_temp(src: str) -> Optional[str]:
    """Decode a data: URI to a temp file and return its path."""
    m = _DATA_URI_RE.match(src)
    if not m:
        return None
    raw = m.group("data")
    content = base64.b64decode(raw) if m.group("b64") else unquote(raw).encode()
    mime = m.group("mime") or "image/png"
    ext = "." + (mime.split("/")[-1].split("+")[0] or "png") if "/" in mime else ".png"
    fd, tmp = tempfile.mkstemp(suffix=ext)
    with os.fdopen(fd, "wb") as f:
        f.write(content)
    return tmp


def _download_to_temp(url: str) -> Optional[str]:
    """Download a remote image to a temp file (best-effort). None on failure."""
    with httpx.Client(timeout=30.0, follow_redirects=True) as client:
        resp = client.get(url)
        resp.raise_for_status()
        ext = os.path.splitext(urlparse(url).path)[1] or ".img"
        fd, tmp = tempfile.mkstemp(suffix=ext)
        with os.fdopen(fd, "wb") as f:
            f.write(resp.content)
    return tmp


def _looks_like_auth_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(s in text for s in ("401", "403", "unauthor", "forbidden", "login", "sign in", "signin"))


def _auth_hint(exc: Exception, action: str) -> str:
    """A user-facing message; adds a cookie-expiry hint when the error looks like auth."""
    if _looks_like_auth_error(exc):
        return (
            f"Couldn't {action} — your Substack session cookie may be invalid or expired. "
            f"Refresh it in Settings → Publishing. ({exc})"
        )
    return f"Couldn't {action}: {exc}"


def _connect_error_message(exc: Exception, publication_url: str) -> str:
    """User-facing message for a failed connection test: distinguish an expired cookie
    from a publication-URL mismatch when we can."""
    if _looks_like_auth_error(exc):
        return "Your Substack session cookie looks invalid or expired — copy a fresh one and try again."
    return (
        f"Couldn't connect. Check that the cookie is current (they expire) and that the "
        f"publication URL ({publication_url}) matches your account. ({exc})"
    )
