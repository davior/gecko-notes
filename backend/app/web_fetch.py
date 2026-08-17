"""Browser-like, SSRF-guarded HTTP fetching for the URL importer.

Two concerns live here, neither of which belongs in a router:

1. **Looking like a browser.** Plenty of sites reject anything that doesn't, so we send
   a full self-consistent set of Chrome headers, speak HTTP/2, keep cookies across hops
   (consent interstitials set one and redirect), send a plausible Referer when fetching
   images, and retry a refusal once under a second browser profile. That makes ordinary
   public pages readable. It is not an attempt to get through CAPTCHAs, login walls or
   paywalls — those still fail, and the importer reports them as a failed extraction
   rather than pretending harder.

2. **Not becoming an open proxy.** The URL is typed by whoever is using the app, so every
   hop is re-validated against private address space *after DNS resolution* — a hostname
   resolving to 127.0.0.1 or 169.254.169.254 is rejected exactly like a literal one.
   Redirects are followed by hand so no hop can skip that check.

`app.routers.settings._require_safe_external_url` covers the same ground for admin-entered
provider base URLs, but is https-only and never resolves DNS. That is fine for a field an
admin sets once; it is not enough for an endpoint whose entire job is fetching whatever
URL it is handed.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse, urlunparse

import httpx

# A page has to fit in memory to be parsed, so cap what we're willing to read.
MAX_HTML_BYTES = 5 * 1024 * 1024
# Per-image cap for the resource downloader.
MAX_IMAGE_BYTES = 10 * 1024 * 1024
FETCH_TIMEOUT = 20.0
MAX_REDIRECTS = 5

# Two self-consistent Chrome profiles. The client hints have to agree with the
# User-Agent — a Windows UA paired with `sec-ch-ua-platform: "macOS"` is a louder
# bot signal than sending no hints at all.
_BROWSER_PROFILES: Tuple[Dict[str, str], ...] = (
    {
        "user_agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "sec_ch_ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "platform": '"macOS"',
    },
    {
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        ),
        "sec_ch_ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        "platform": '"Windows"',
    },
)

# Status codes worth one retry under a different browser profile. 403/429 are the
# usual "you look automated" refusals; 503 is what a challenge page often returns.
_RETRY_STATUSES = frozenset({403, 429, 503})

HTML_CONTENT_TYPES = ("text/html", "application/xhtml+xml", "application/xml", "text/xml")


class FetchError(Exception):
    """A fetch failed in a way worth reporting to the user verbatim."""

    def __init__(self, code: str, message: str, status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _document_headers(profile: Dict[str, str], referer: Optional[str] = None) -> Dict[str, str]:
    """Headers Chrome sends for a top-level navigation, in Chrome's own order."""
    headers = {
        "sec-ch-ua": profile["sec_ch_ua"],
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": profile["platform"],
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": profile["user_agent"],
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,image/apng,*/*;q=0.8,"
            "application/signed-exchange;v=b3;q=0.7"
        ),
        "Sec-Fetch-Site": "cross-site" if referer else "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        headers["Referer"] = referer
    # Accept-Encoding is left to httpx, which advertises exactly what it can decode
    # (gzip, deflate, and br when brotli is installed).
    return headers


def _image_headers(profile: Dict[str, str], referer: Optional[str] = None) -> Dict[str, str]:
    """Headers Chrome sends for a subresource image request.

    The Referer matters: hotlink protection is common, and an image request arriving
    with no referer from a page that does have one is exactly what it screens for.
    """
    headers = {
        "sec-ch-ua": profile["sec_ch_ua"],
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": profile["platform"],
        "User-Agent": profile["user_agent"],
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Sec-Fetch-Site": "cross-site" if referer else "none",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "image",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if referer:
        headers["Referer"] = referer
    return headers


async def assert_public_url(url: str) -> str:
    """Validate a URL is http(s) and resolves only to public addresses.

    Returns the normalised URL. Raises FetchError(status_code=400) otherwise.

    Note the unavoidable TOCTOU gap: we resolve here and httpx resolves again when it
    connects, so a hostile authoritative server could in principle answer differently
    the second time (DNS rebinding). Closing that fully means pinning the connection to
    the validated IP while preserving SNI and Host, which httpx does not expose cleanly.
    Resolving and checking still blocks every practical case — literals, redirects to
    internal names, and cloud metadata endpoints.
    """
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise FetchError("invalid_url", "URL must start with http:// or https://", 400)

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise FetchError("invalid_url", "URL has no valid hostname", 400)

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(hostname, parsed.port or (443 if parsed.scheme == "https" else 80),
                                       proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise FetchError("dns_failed", f"Could not resolve {hostname}", 400)

    if not infos:
        raise FetchError("dns_failed", f"Could not resolve {hostname}", 400)

    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        # is_global rejects loopback, link-local (169.254.169.254), RFC1918, CGNAT,
        # unique-local v6 and the unspecified address in one check.
        if not ip.is_global:
            raise FetchError(
                "ssrf_blocked",
                "That URL points to a private or internal address",
                400,
            )

    return urlunparse(parsed)


async def _get_once(
    client: httpx.AsyncClient,
    url: str,
    headers: Dict[str, str],
    max_bytes: int,
) -> Tuple[httpx.Response, bytes]:
    """One GET, reading at most max_bytes. Redirects are returned unread."""
    async with client.stream("GET", url, headers=headers) as response:
        if response.is_redirect:
            return response, b""
        chunks: List[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > max_bytes:
                raise FetchError(
                    "too_large",
                    f"That page is larger than {max_bytes // (1024 * 1024)} MB",
                    413,
                )
            chunks.append(chunk)
        return response, b"".join(chunks)


async def _follow(
    client: httpx.AsyncClient,
    url: str,
    profile: Dict[str, str],
    max_bytes: int,
    kind: str,
    referer: Optional[str],
) -> Tuple[str, httpx.Response, bytes]:
    """GET `url`, following up to MAX_REDIRECTS hops, validating every one."""
    current = await assert_public_url(url)
    build = _document_headers if kind == "document" else _image_headers

    for _ in range(MAX_REDIRECTS + 1):
        try:
            response, body = await _get_once(client, current, build(profile, referer), max_bytes)
        except httpx.RequestError as exc:
            raise FetchError("fetch_failed", f"Could not reach that URL ({type(exc).__name__})")

        if not response.is_redirect:
            return current, response, body

        location = response.headers.get("location")
        if not location:
            return current, response, body
        # Relative Location headers are legal and common.
        current = await assert_public_url(str(httpx.URL(current).join(location)))

    raise FetchError("too_many_redirects", "That URL redirected too many times", 400)


async def fetch_document(url: str) -> Tuple[str, bytes]:
    """Fetch an HTML page. Returns (final_url, body_bytes).

    Tries each browser profile in turn when the site answers with a refusal that
    smells like bot filtering, then gives up rather than escalating further.
    """
    last_error: Optional[FetchError] = None

    for index, profile in enumerate(_BROWSER_PROFILES):
        # A fresh client per attempt so a challenge cookie from a refused attempt
        # doesn't follow the retry, but cookies persist across redirects within one.
        async with httpx.AsyncClient(
            http2=True,
            follow_redirects=False,
            timeout=FETCH_TIMEOUT,
            verify=True,
        ) as client:
            final_url, response, body = await _follow(
                client, url, profile, MAX_HTML_BYTES, "document", None
            )

            if response.status_code in _RETRY_STATUSES and index + 1 < len(_BROWSER_PROFILES):
                retry_after = response.headers.get("retry-after", "")
                if retry_after.isdigit():
                    await asyncio.sleep(min(int(retry_after), 5))
                last_error = FetchError(
                    "blocked",
                    f"The site refused the request (HTTP {response.status_code}). "
                    "It may require a login, or be blocking automated readers.",
                    502,
                )
                continue

            if response.status_code >= 400:
                raise FetchError(
                    "http_error",
                    f"That URL returned HTTP {response.status_code}",
                    502,
                )

            content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if content_type and not content_type.startswith(HTML_CONTENT_TYPES):
                raise FetchError(
                    "not_html",
                    f"That URL is {content_type}, not a web page",
                    415,
                )

            return final_url, body

    raise last_error or FetchError("fetch_failed", "Could not fetch that URL")


async def fetch_image(url: str, referer: Optional[str] = None) -> Tuple[str, bytes, str]:
    """Fetch a single image. Returns (final_url, body_bytes, content_type).

    Raises FetchError; callers download images in bulk and are expected to catch it
    per-image so one dead asset doesn't sink the whole import.
    """
    async with httpx.AsyncClient(
        http2=True,
        follow_redirects=False,
        timeout=FETCH_TIMEOUT,
        verify=True,
    ) as client:
        final_url, response, body = await _follow(
            client, url, _BROWSER_PROFILES[0], MAX_IMAGE_BYTES, "image", referer
        )

    if response.status_code >= 400:
        raise FetchError("http_error", f"HTTP {response.status_code}")
    if not body:
        raise FetchError("empty", "Empty response")

    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    return final_url, body, content_type
