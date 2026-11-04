"""Gecko Suite as the place AI chat goes (`AI_BACKEND=suite`).

Everything this app knows about the suite's chat gateway is here. The seam is the six
proxy functions in `routers/settings.py` (three blocking, three streaming): in `suite`
mode each still resolves the caller's provider row, so ownership, vendor and protocol
checks behave as before, and then hands the request body to the suite instead of the
vendor. The suite holds the key, builds nothing, and answers in the shapes these routes
always returned, so the frontend and the assistant worker do not change.

**Who the call is for.** Always Notes, on behalf of the user (`SUITE_APP_SECRET`), never
the browser's token: a worker's call outlives the request that queued it and has no
token to forward. The suite credits the spend to the app and the user. An app credential
can use the gateway but never change anyone's settings.

**Which provider the suite uses.** Notes sends the vendor of the row the person picked
and the model name; the suite searches the person's own providers, then shared ones, for
that vendor and model. The local row's key and `extra_params` are not sent: the suite has
its own copies, brought across by its importer.

**What it does not do.** It records no usage (the suite does) and holds no key. When the
suite is down the caller gets a 503 `suite_unavailable` with a sentence; nothing else in
Notes depends on it.

Tests set `TRANSPORT`; production leaves it None, which is httpx's real transport.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, AsyncIterator, Callable, Dict, Optional, Tuple

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

APP = "notes"
DEFAULT_BASE_URL = "https://suite.geckopico.com"

TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

# A blocking call returns when the reply exists, so its read timeout is the whole call.
# Streamed ones bound only the gap between events (the suite pings through its own).
_BLOCKING = httpx.Timeout(10.0, read=700.0)
_STREAMING = httpx.Timeout(10.0, read=150.0)


def backend() -> str:
    return os.getenv("AI_BACKEND", "local").strip().lower() or "local"


def enabled() -> bool:
    return backend() == "suite"


def base_url() -> str:
    return (os.getenv("SUITE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def validate() -> None:
    """Refuse to start on a configuration that cannot work, rather than fail every call.

    Read when the app starts, not at import, so a test can set the variables first.
    """
    value = backend()
    if value not in {"local", "suite"}:
        raise RuntimeError('AI_BACKEND must be "local" or "suite"')
    if value == "suite" and not (os.getenv("SUITE_APP_SECRET") or "").strip():
        raise RuntimeError(
            "AI_BACKEND=suite needs SUITE_APP_SECRET: a worker's AI call has no user "
            "session to forward. An administrator issues it on the suite's Apps screen."
        )


def _headers(user_id: str) -> Dict[str, str]:
    return {
        "X-Gecko-App": os.getenv("SUITE_APP_ID") or APP,
        "X-Gecko-App-Secret": os.getenv("SUITE_APP_SECRET", ""),
        "X-On-Behalf-Of": user_id,
        "content-type": "application/json",
    }


def _unavailable() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": "suite_unavailable",
            "message": "Gecko Suite can't be reached right now, so AI chat is paused. "
                       "Notes itself still works.",
        },
    )


def _detail(response: httpx.Response) -> Any:
    """The suite's `{"code", "message"}`, or a sentence if what came back was not that."""
    try:
        detail = response.json().get("detail")
    except (ValueError, AttributeError):
        detail = None
    if isinstance(detail, dict) and detail.get("message"):
        return detail
    return {"code": "suite_error", "message": f"Gecko Suite answered {response.status_code}."}


def request_body(payload: Any, vendor: str) -> Dict[str, Any]:
    """The proxy request as the suite takes it: the vendor in place of the provider id."""
    body = payload.model_dump(exclude={"provider_id"}, exclude_none=True)
    body["vendor"] = vendor
    return body


async def complete(
    protocol: str,
    body: Dict[str, Any],
    user_id: str,
    *,
    on_delta: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """One call, answered with the dict the local path would have returned."""
    if on_delta is not None:
        # A worker watching a long planning call wants to see it alive; the stream is the
        # same call with the deltas passed on, ending in the same dict.
        final: Optional[Dict[str, Any]] = None
        async for event, data in events(protocol, body, user_id):
            if event == "delta":
                on_delta(data.get("text", ""))
            elif event == "final":
                final = data
            elif event == "error":
                raise HTTPException(status_code=502, detail=data)
        if final is None:
            raise HTTPException(status_code=502, detail={
                "code": "stream_incomplete", "message": "Gecko Suite's reply ended early."})
        return final

    try:
        async with httpx.AsyncClient(transport=TRANSPORT, timeout=_BLOCKING) as client:
            response = await client.post(
                f"{base_url()}/api/v1/ai/proxy/{protocol}", headers=_headers(user_id), json=body)
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail={
            "code": "upstream_timeout", "message": f"Timed out waiting for Gecko Suite ({type(exc).__name__})."}) from exc
    except httpx.RequestError as exc:
        logger.warning("Gecko Suite unreachable: %s", exc)
        raise _unavailable() from exc
    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=_detail(response))
    return response.json()


async def request_json(
    method: str,
    path: str,
    user_id: str,
    *,
    body: Optional[Dict[str, Any]] = None,
    timeout: Optional[httpx.Timeout] = None,
) -> Any:
    """One non-streaming call to the suite's `/api/v1` as Notes for `user_id`.

    Returns the `data` of the suite's `{"data": ...}` envelope. A refusal keeps the
    suite's status and `{code, message}`, so a caller that already maps HTTPException
    (the assistant's failed-search note, a route's own response) needs no new case.
    """
    try:
        async with httpx.AsyncClient(transport=TRANSPORT, timeout=timeout or httpx.Timeout(30.0)) as client:
            response = await client.request(
                method, f"{base_url()}/api/v1{path}", headers=_headers(user_id), json=body)
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail={
            "code": "upstream_timeout", "message": f"Timed out waiting for Gecko Suite ({type(exc).__name__})."}) from exc
    except httpx.RequestError as exc:
        logger.warning("Gecko Suite unreachable: %s", exc)
        raise _unavailable() from exc
    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=_detail(response))
    try:
        return response.json()["data"]
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=502, detail={
            "code": "suite_error", "message": "Gecko Suite sent a reply Notes could not read."}) from exc


async def web_search(query: str, count: Optional[int], user_id: str) -> Dict[str, Any]:
    """A search by the suite, in the shape `search_web_for_user` has always returned.

    Which backend runs is the suite's decision (the person's own, else the shared one,
    else DuckDuckGo), so the Notes setting for it does not apply in this mode.
    """
    body: Dict[str, Any] = {"query": query.strip()[:500]}
    if count:
        body["count"] = max(1, min(int(count), 10))
    data = await request_json("POST", "/search/web", user_id, body=body, timeout=httpx.Timeout(10.0, read=40.0))
    return {
        "provider": data.get("kind", ""),
        "provider_label": data.get("provider", ""),
        "query": query.strip(),
        "results": data.get("results", []),
    }


async def events(protocol: str, body: Dict[str, Any], user_id: str) -> AsyncIterator[Tuple[str, Any]]:
    """The suite's SSE as (event, data): `delta`, then `final`, or `error`.

    A refusal before the stream starts (no such provider, say) arrives as an `error`
    event as well. The browser's response is already a 200 by then, which is how every
    failure of these routes is reported.
    """
    try:
        async with httpx.AsyncClient(transport=TRANSPORT, timeout=_STREAMING) as client:
            async with client.stream(
                "POST", f"{base_url()}/api/v1/ai/proxy/{protocol}/stream",
                headers=_headers(user_id), json=body,
            ) as response:
                if not response.is_success:
                    await response.aread()
                    yield "error", _detail(response)
                    return
                event = "message"
                async for line in response.aiter_lines():
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        try:
                            yield event, json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            logger.warning("Gecko Suite sent an unreadable %s frame", event)
                    elif not line:
                        event = "message"
    except httpx.TimeoutException as exc:
        yield "error", {"code": "upstream_timeout",
                        "message": f"Timed out waiting for Gecko Suite ({type(exc).__name__})."}
    except httpx.RequestError as exc:
        logger.warning("Gecko Suite unreachable: %s", exc)
        yield "error", _unavailable().detail
