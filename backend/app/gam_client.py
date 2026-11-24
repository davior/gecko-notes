"""Reading the person's GAM library (Gecko Asset Manager) on their behalf.

GAM keeps the files; Notes never mirrors its library. A note holds a `gamAsset` block
naming an asset id, and every time the block is shown the editor asks here for a fresh
address, because GAM's file URLs are signed and expire after an hour. Storing one in a
note would leave a broken image behind the next morning.

Every call goes out as the user. A request forwards the token it arrived with, so GAM
runs its normal ownership checks and Notes can reach nothing the person could not reach
from GAM's own frontend (GVC's `app/gam/client.py` works the same way, and this is a
trimmed port of it). The assistant's worker has no request, so `token_for` mints a
short-lived token for the turn's owner with the same secret GAM already trusts; it is
only ever sent to GAM, server to server.

Configuration is read per call, like `suite.py`, so tests can set it with monkeypatch:

- `GAM_BASE_URL` — how this server reaches GAM. Unset means the feature is off and every
  entry point in the editor is hidden.
- `GAM_PUBLIC_URL` — what the browser opens (the `/a/<id>` page, and the base for GAM's
  relative media URLs). Defaults to `GAM_BASE_URL`; set it when that is an internal
  compose address.
- `GAM_TIMEOUT_SECONDS`, `GAM_COPY_MAX_BYTES`.

Tests set `TRANSPORT`; production leaves it None, which is httpx's real transport.
"""

from __future__ import annotations

import logging
import os
from datetime import timedelta
from typing import IO, Any, Dict, List, Optional

import httpx
from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

TRANSPORT: Optional[httpx.BaseTransport] = None

ASSET_TYPES = ("image", "video", "audio", "document")
DEFAULT_COPY_MAX_BYTES = 500 * 1024 * 1024
# Long enough for one assistant turn's GAM calls, short enough that a token which
# somehow leaked from a log would be worthless by the time anyone read it.
WORKER_TOKEN_MINUTES = 5


def base_url() -> str:
    return (os.getenv("GAM_BASE_URL") or "").strip().rstrip("/")


def public_url() -> str:
    return ((os.getenv("GAM_PUBLIC_URL") or "").strip() or base_url()).rstrip("/")


def enabled() -> bool:
    return bool(base_url())


def _timeout() -> float:
    try:
        return float(os.getenv("GAM_TIMEOUT_SECONDS") or 30)
    except ValueError:
        return 30.0


def copy_max_bytes() -> int:
    try:
        return int(os.getenv("GAM_COPY_MAX_BYTES") or DEFAULT_COPY_MAX_BYTES)
    except ValueError:
        return DEFAULT_COPY_MAX_BYTES


class GamError(Exception):
    """A failure talking to GAM, with the status the route should answer."""

    def __init__(self, code: str, message: str, *, status_code: int = 502):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def http(self) -> HTTPException:
        return HTTPException(status_code=self.status_code,
                             detail={"code": self.code, "message": self.message})


def not_configured() -> GamError:
    return GamError("gam_not_configured",
                    "The asset library is not connected to Notes (GAM_BASE_URL is not set).",
                    status_code=503)


# ─── tokens ──────────────────────────────────────────────────────────────────


def request_token(request: Request) -> Optional[str]:
    """The token this request was authenticated with: header first, as the middleware
    reads it, then the suite session cookie."""
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:]
    from app.routers.auth import AUTH_COOKIE_NAME
    return request.cookies.get(AUTH_COOKIE_NAME)


def token_for(user_id: str, username: str = "") -> str:
    """A short-lived token for a caller with no request (the assistant's worker)."""
    from app.auth import create_access_token
    return create_access_token({"sub": user_id, "username": username},
                               expires_delta=timedelta(minutes=WORKER_TOKEN_MINUTES))


# ─── shapes ──────────────────────────────────────────────────────────────────


def _absolute(url: Optional[str]) -> Optional[str]:
    """GAM's media URLs are relative to GAM (`/media/<key>?exp=…&sig=…`); the browser
    loads them from GAM directly, so they have to name GAM's public host."""
    if not url:
        return None
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return public_url() + url


def page_url(asset_id: str) -> str:
    return f"{public_url()}/a/{asset_id}"


def to_asset(raw: Dict[str, Any]) -> Dict[str, Any]:
    """The part of GAM's AssetRead the editor uses, with addresses made absolute.

    `file_url_internal` is the same file at the address this server reaches, for
    copying into a note; the route drops it before answering the browser.
    """
    asset_type = raw.get("asset_type") or ""
    return {
        "id": raw["id"],
        "name": raw.get("name") or raw.get("original_name") or "Untitled",
        "asset_type": asset_type if asset_type in ASSET_TYPES else "document",
        "description": raw.get("description") or raw.get("summary") or None,
        "original_name": raw.get("original_name"),
        "mime_type": raw.get("mime_type"),
        "file_format": raw.get("file_format"),
        "size_bytes": raw.get("size_bytes") or 0,
        "duration_seconds": raw.get("duration_seconds"),
        "width": raw.get("width"),
        "height": raw.get("height"),
        "in_point": raw.get("in_point"),
        "out_point": raw.get("out_point"),
        "file_url": _absolute(raw.get("file_url")),
        "thumb_url": _absolute(raw.get("thumb_url")),
        "page_url": page_url(raw["id"]),
        "credit": raw.get("credit") or "",
        "missing": bool(raw.get("missing")),
        "file_url_internal": raw.get("file_url"),
    }


def public(asset: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in asset.items() if k != "file_url_internal"}


# ─── the client ──────────────────────────────────────────────────────────────


class GamClient:
    def __init__(self, token: Optional[str]):
        if not enabled():
            raise not_configured()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = httpx.Client(base_url=base_url(), timeout=_timeout(), headers=headers,
                                  transport=TRANSPORT)

    def __enter__(self) -> "GamClient":
        return self

    def __exit__(self, *exc) -> None:
        self._http.close()

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = self._http.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise GamError("gam_unavailable", "The asset library took too long to answer") from exc
        except httpx.HTTPError as exc:
            logger.warning("GAM unreachable at %s: %s", base_url(), exc)
            raise GamError("gam_unavailable", "Could not reach the asset library") from exc

        if response.status_code == 401:
            # The person is signed in here, so GAM refusing the same token means the two
            # apps disagree about JWT_SECRET_KEY: an operator's problem, said as one.
            raise GamError(
                "gam_rejected_session",
                "The asset library did not accept your session. Notes and GAM probably "
                "have different JWT_SECRET_KEY values.",
            )
        if response.status_code >= 500:
            raise GamError("gam_unavailable", f"The asset library failed ({response.status_code})")
        return response

    @staticmethod
    def _fail(response: httpx.Response) -> GamError:
        try:
            detail = response.json().get("detail") or {}
        except ValueError:
            detail = {}
        if isinstance(detail, dict):
            code, message = detail.get("code") or "gam_error", detail.get("message") or response.text[:200]
        else:
            code, message = "gam_error", str(detail)
        return GamError(code, message, status_code=400 if response.status_code < 500 else 502)

    def search(self, query: str, *, asset_type: Optional[str] = None, limit: int = 30) -> Dict[str, Any]:
        """GAM's search (keywords plus meaning, where GAM has embeddings). With no query
        it lists the newest assets instead, so the picker shows something before the
        person types."""
        params: Dict[str, Any] = {"limit": limit}
        if asset_type:
            params["asset_type"] = asset_type
        query = (query or "").strip()
        if not query:
            response = self._request("GET", "/api/assets", params=params)
            if response.status_code != 200:
                raise self._fail(response)
            body = response.json()
            return {
                "data": [{"asset": to_asset(raw), "snippet": "", "page_label": None,
                          "start_time": None} for raw in body.get("data", [])],
                "total": body.get("total", 0), "query": "", "semantic": False,
            }
        response = self._request("GET", "/api/search", params={**params, "q": query})
        if response.status_code != 200:
            raise self._fail(response)
        body = response.json()
        return {
            "data": [
                {"asset": to_asset(hit["asset"]), "snippet": hit.get("snippet") or "",
                 "page_label": hit.get("page_label"), "start_time": hit.get("start_time")}
                for hit in body.get("data", [])
            ],
            "total": body.get("total", 0),
            "query": body.get("query", query),
            "semantic": bool(body.get("semantic")),
        }

    def get_asset(self, asset_id: str) -> Optional[Dict[str, Any]]:
        """One asset, or None when it is gone or not the caller's (GAM says 404 for both,
        and so does Notes: whether someone else's id exists is not this caller's business)."""
        response = self._request("GET", f"/api/assets/{asset_id}")
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise self._fail(response)
        return to_asset(response.json()["data"])

    def document_text(self, asset_id: str) -> List[Dict[str, Any]]:
        """A document's text in reading order; empty when GAM has read none of it."""
        response = self._request("GET", f"/api/assets/{asset_id}/text")
        if response.status_code != 200:
            return []
        return response.json().get("data") or []

    def transcript(self, asset_id: str) -> List[Dict[str, Any]]:
        """What is said in a video or recording, as segments; empty when there is none."""
        response = self._request("GET", f"/api/assets/{asset_id}/transcript")
        if response.status_code != 200:
            return []
        return (response.json().get("data") or {}).get("segments") or []

    def download(self, file_url: str, sink: IO[bytes], *, max_bytes: int) -> int:
        """Stream one of GAM's signed media URLs into `sink`. Returns the bytes written."""
        written = 0
        try:
            with self._http.stream("GET", file_url, timeout=600) as response:
                if response.status_code != 200:
                    raise GamError("gam_media_unavailable",
                                   f"The asset library would not hand over the file ({response.status_code})")
                for chunk in response.iter_bytes(1024 * 1024):
                    written += len(chunk)
                    if written > max_bytes:
                        raise GamError("gam_media_too_large",
                                       f"This file is larger than {max_bytes // (1024 * 1024)} MB, "
                                       "too large to copy into a note", status_code=413)
                    sink.write(chunk)
        except httpx.HTTPError as exc:
            raise GamError("gam_unavailable", "Could not fetch the file from the asset library") from exc
        return written
