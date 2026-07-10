"""Realtime streaming speech-to-text via Deepgram — a backend-proxied WebSocket.

The browser never talks to Deepgram directly: it streams MediaRecorder audio
chunks to us, we relay them to Deepgram's Listen API using the user's own
encrypted API key, and relay Deepgram's transcript events back in a small,
decoupled JSON shape. This mirrors how every other provider key in this app
(fal.ai, Anthropic, OpenAI) stays server-side and is never exposed to the
client.
"""
import asyncio
import json
import logging
from typing import Optional, Set

import websockets
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from jose import JWTError
from sqlmodel import Session

from app.auth import decode_token
from app.database import get_session
from app.routers.settings import (
    DEFAULT_DEEPGRAM_MODEL,
    _record_usage,
    load_deepgram_api_key,
    load_speech_config,
)

router = APIRouter()
logger = logging.getLogger(__name__)

DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen"

# One active Deepgram stream per user at a time — a cheap guard against runaway
# concurrent-session cost, since slowapi's Limiter doesn't cover websocket routes.
_active_sessions: Set[str] = set()


async def _get_ws_user_id(websocket: WebSocket) -> Optional[str]:
    """Mirrors _get_user_id (routers/settings.py) but for the websocket scope.
    jwt_auth_middleware is an @app.middleware("http") that Starlette never invokes
    for websocket connections, and a browser can't set a custom Authorization header
    on a WS handshake — so the JWT travels as a query param instead."""
    token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        payload = decode_token(token)
    except JWTError:
        return None
    return payload.get("sub")


@router.websocket("/ws")
async def stt_stream_ws(websocket: WebSocket, session: Session = Depends(get_session)):
    await websocket.accept()

    user_id = await _get_ws_user_id(websocket)
    if not user_id:
        await websocket.close(code=4401, reason="unauthorized")
        return

    if user_id in _active_sessions:
        await websocket.close(code=4409, reason="stream_already_active")
        return

    api_key = load_deepgram_api_key(session, user_id)
    if not api_key:
        await websocket.close(code=4400, reason="no_deepgram_key")
        return

    model = load_speech_config(session, user_id).get("deepgram_model") or DEFAULT_DEEPGRAM_MODEL

    _active_sessions.add(user_id)
    seconds_sent = 0.0
    try:
        upstream_url = (
            f"{DEEPGRAM_LISTEN_URL}?model={model}&interim_results=true"
            "&smart_format=true&punctuate=true"
        )
        async with websockets.connect(
            upstream_url,
            extra_headers={"Authorization": f"Token {api_key}"},
        ) as deepgram_ws:
            logger.info("Deepgram stream connected for user %s (model=%s)", user_id, model)

            async def pump_client_to_deepgram():
                chunks = 0
                audio_bytes = 0
                try:
                    while True:
                        message = await websocket.receive()
                        if message["type"] == "websocket.disconnect":
                            logger.info(
                                "Client websocket disconnected for user %s (code=%s) after %d chunk(s)/%d byte(s)",
                                user_id, message.get("code"), chunks, audio_bytes,
                            )
                            return
                        data = message.get("bytes")
                        if data is not None:
                            chunks += 1
                            audio_bytes += len(data)
                            await deepgram_ws.send(data)
                            continue
                        text = message.get("text")
                        if text is None:
                            continue
                        try:
                            control = json.loads(text)
                        except (ValueError, TypeError):
                            continue
                        if control.get("type") == "stop":
                            logger.info(
                                "Client requested stop for user %s after %d chunk(s)/%d byte(s)",
                                user_id, chunks, audio_bytes,
                            )
                            await deepgram_ws.send(json.dumps({"type": "CloseStream"}))
                            return
                finally:
                    if chunks == 0:
                        logger.warning("No audio chunks were ever received from the client for user %s", user_id)

            async def pump_deepgram_to_client():
                nonlocal seconds_sent
                async for raw in deepgram_ws:
                    try:
                        event = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    event_type = event.get("type")
                    if event_type == "Results":
                        alternatives = event.get("channel", {}).get("alternatives") or [{}]
                        text = (alternatives[0].get("transcript") or "").strip()
                        if text:
                            await websocket.send_json({
                                "type": "final" if event.get("is_final") else "interim",
                                "text": text,
                            })
                    elif event_type == "Metadata":
                        duration = event.get("duration")
                        if isinstance(duration, (int, float)):
                            seconds_sent = duration
                    elif event_type == "Error":
                        logger.warning("Deepgram sent an Error event for user %s: %s", user_id, event)
                        await websocket.send_json({
                            "type": "error",
                            "message": event.get("message") or event.get("description") or "Deepgram error",
                        })
                    else:
                        logger.debug("Unhandled Deepgram event type %r for user %s: %s", event_type, user_id, event)

            recv_task = asyncio.create_task(pump_client_to_deepgram())
            send_task = asyncio.create_task(pump_deepgram_to_client())
            try:
                done, pending = await asyncio.wait(
                    {recv_task, send_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if recv_task in done and send_task in pending:
                    # Client said stop / disconnected — give Deepgram a brief window
                    # to flush its trailing final Results before tearing down.
                    try:
                        await asyncio.wait_for(send_task, timeout=3.0)
                    except asyncio.TimeoutError:
                        pass
                # asyncio.wait() never raises a task's exception on our behalf — a
                # failure in either relay direction (e.g. the client-facing leg
                # breaking under a reverse proxy) would otherwise be silently
                # discarded here instead of reaching the except block below.
                for task in (recv_task, send_task):
                    if task.done() and not task.cancelled():
                        task_exc = task.exception()
                        if task_exc is not None:
                            raise task_exc
            finally:
                for task in (recv_task, send_task):
                    if not task.done():
                        task.cancel()
                # cancel() only schedules the cancellation — without awaiting the
                # tasks here, this function can return before a cancelled task's
                # own `finally` (e.g. the chunk-count logging below) ever runs.
                await asyncio.gather(recv_task, send_task, return_exceptions=True)

    except WebSocketDisconnect as e:
        # Starlette raises this (code 1006 = abnormal closure) when send() hits an
        # OSError because the underlying transport is already dead — e.g. an
        # intermediary killed the TCP connection without a clean WS close. This
        # was previously swallowed with zero logging, hiding exactly the signal
        # we need to tell a proxy-side drop apart from a real client close.
        logger.warning("WebSocket disconnected for user %s (code=%s, reason=%r)", user_id, e.code, e.reason)
    except Exception as e:
        logger.warning("Deepgram stream error for user %s: %s", user_id, e, exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": "Deepgram connection failed"})
        except Exception:
            pass
    finally:
        _active_sessions.discard(user_id)
        if seconds_sent > 0:
            _record_usage(
                session, user_id, "stt", model, round(seconds_sent), "seconds",
                provider="deepgram", cost=None, cost_estimated=True,
            )
        try:
            await websocket.close()
        except Exception:
            pass
