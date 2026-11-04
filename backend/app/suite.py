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

import asyncio
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
# The same, for the synchronous client the assistant's tool loop uses on its worker thread.
SYNC_TRANSPORT: Optional[httpx.BaseTransport] = None

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


def chat_client(user_id: str):
    """A `gecko-suite-client` connection as Notes, for `user_id`, for the assistant's tool
    loop (`assistant/tool_planner.py`). One per turn, closed after it: the credential names
    the user. Imported here, not at the top, so the rest of Notes never needs the package."""
    from gecko_suite_client import SuiteClient

    return SuiteClient(
        base_url(), app=os.getenv("SUITE_APP_ID") or APP, app_secret=os.getenv("SUITE_APP_SECRET", ""),
        on_behalf_of=user_id, transport=SYNC_TRANSPORT, timeout=httpx.Timeout(15.0, read=300.0),
    )


def public_url() -> str:
    """Where a person's browser reaches the suite, for the links in Settings.

    Not `SUITE_BASE_URL`: that is how this server reaches it, which in some deployments is
    an internal address (a compose service name) no browser can open.
    """
    return (os.getenv("SUITE_PUBLIC_URL") or base_url()).rstrip("/")


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


async def request_bytes(
    method: str,
    path: str,
    user_id: str,
    *,
    content: Optional[bytes] = None,
    json_body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
    content_type: Optional[str] = None,
    timeout: Optional[httpx.Timeout] = None,
) -> httpx.Response:
    """A call to the suite whose answer is not a `{"data": ...}` envelope (audio out, audio in).

    Errors are raised exactly as `request_json` raises them; a good response is returned
    whole so the caller can read its body and its headers.
    """
    headers = _headers(user_id)
    if content is not None:
        headers["content-type"] = content_type or "application/octet-stream"
    try:
        async with httpx.AsyncClient(transport=TRANSPORT, timeout=timeout or httpx.Timeout(30.0)) as client:
            response = await client.request(
                method, f"{base_url()}/api/v1{path}", headers=headers,
                content=content, json=json_body, params=params)
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail={
            "code": "upstream_timeout", "message": f"Timed out waiting for Gecko Suite ({type(exc).__name__})."}) from exc
    except httpx.RequestError as exc:
        logger.warning("Gecko Suite unreachable: %s", exc)
        raise _unavailable() from exc
    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=_detail(response))
    return response


# What the suite resolved for a spoken chunk. `model_ref` is the pin: a narration sends it
# back for every later chunk so the whole thing is read by one model in one voice.
class Spoken:
    def __init__(self, audio: bytes, media_type: str, model_ref: str, voice: str):
        self.audio, self.media_type, self.model_ref, self.voice = audio, media_type, model_ref, voice


# Notes' old engine names. They mean "let the account decide", which in this mode is the
# suite's `speech.tts` routing, so none of them can pin anything.
_NOT_A_PIN = {"", "auto", "deepgram", "fal"}


async def speak(text: str, user_id: str, *, voice: Optional[str] = None,
                model_ref: Optional[str] = None) -> Spoken:
    """Text to audio through the model the suite routes `speech.tts` to.

    A `model_ref` that is one of Notes' own engine names is ignored (see `_NOT_A_PIN`);
    a real one is sent, and the suite then uses that model or fails: it never falls back
    to another engine, which is what made a narration change voice partway through.
    """
    body: Dict[str, Any] = {"text": text}
    if voice:
        body["voice"] = voice
    if model_ref and model_ref not in _NOT_A_PIN:
        body["model_ref"] = model_ref
    response = await request_bytes("POST", "/ai/speech/tts", user_id, json_body=body,
                                   timeout=httpx.Timeout(10.0, read=180.0))
    return Spoken(response.content, response.headers.get("content-type", "audio/mpeg").split(";")[0],
                  response.headers.get("X-Speech-Model", ""), response.headers.get("X-Speech-Voice", ""))


async def transcribe(audio: bytes, content_type: str, user_id: str) -> str:
    """Audio to text by the suite's Deepgram. Which model reads it is the suite's default;
    Notes' `stt_model` names a fal endpoint and means nothing there."""
    response = await request_bytes("POST", "/ai/speech/stt", user_id, content=audio, content_type=content_type,
                                   timeout=httpx.Timeout(30.0, read=900.0))
    try:
        segments = response.json()["data"]["segments"]
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=502, detail={
            "code": "suite_error", "message": "Gecko Suite sent a transcript Notes could not read."}) from exc
    return " ".join((seg.get("text") or "").strip() for seg in segments).strip()


# How often a queued generation is asked after. fal image endpoints take seconds, so this is
# short; a test sets it to 0.
POLL_INTERVAL = 1.5


async def run_fal_job(kind: str, endpoint_id: str, body: Dict[str, Any], user_id: str,
                      *, timeout: float) -> Dict[str, Any]:
    """One fal generation through the suite's queue, waited for. Returns the finished job.

    The request `body` is the endpoint's own dialect, built by the caller: the model list and
    each endpoint's fields stay in Notes, and the suite is the key, the queue and the bill.
    A failure keeps fal's reason; running out of time cancels the job so it is not billed
    for a result nobody is waiting for.
    """
    job = await request_json("POST", "/ai/media/jobs", user_id, body={
        "kind": kind, "endpoint_id": endpoint_id, "input": body})
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while job.get("status") not in ("completed", "failed", "cancelled"):
        if loop.time() >= deadline:
            try:
                await request_json("DELETE", f"/ai/media/jobs/{job['id']}", user_id)
            except HTTPException:
                logger.warning("Could not cancel timed-out suite job %s", job.get("id"))
            raise HTTPException(status_code=504, detail={
                "code": "upstream_timeout", "message": f"The image did not finish within {int(timeout)}s."})
        await asyncio.sleep(POLL_INTERVAL)
        job = await request_json("GET", f"/ai/media/jobs/{job['id']}", user_id)
    if job["status"] != "completed" or not isinstance(job.get("result"), dict):
        raise HTTPException(status_code=502, detail={
            "code": "fal_error", "message": (job.get("error") or f"The generation {job['status']}.")[:500]})
    return job


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
