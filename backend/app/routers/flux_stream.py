"""Realtime voice-mode speech-to-text via Deepgram Flux — a backend-proxied WebSocket.

This mirrors routers/stt_stream.py (the realtime dictation proxy) but talks to
Deepgram's **Flux** conversational-STT model on the /v2/listen endpoint. Flux adds
turn-taking: instead of a stream of interim/final transcripts, it emits discrete
turn events (StartOfTurn / EagerEndOfTurn / EndOfTurn / Update / TurnResumed) that
the browser uses to drive a hands-free conversational loop — sending each completed
turn's transcript through the *same* assistant pipeline as typed chat, speaking the
reply with Deepgram TTS, and barging in when the user starts talking again.

As with dictation, the browser never talks to Deepgram directly: it streams
MediaRecorder (WebM/Opus) audio to us, we relay it to Deepgram using the user's own
encrypted key, and relay Flux's events back in a small decoupled JSON shape. Flux
accepts containerized WebM/Opus with the encoding parameter omitted, so the client
reuses the exact capture path the dictation flow already uses.
"""
import asyncio
import json
import logging
from typing import Optional, Set

import websockets
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from jose import JWTError
from sqlmodel import Session

from app.app_settings import get_bool, VOICE_MODE_ENABLED
from app.auth import decode_token
from app.database import get_session
from app.routers.settings import (
    _record_usage,
    load_deepgram_api_key,
)

router = APIRouter()
logger = logging.getLogger(__name__)

DEEPGRAM_FLUX_URL = "wss://api.deepgram.com/v2/listen"
FLUX_MODEL = "flux-general-en"
# End-of-turn confidence needed to finalise a turn (Deepgram default 0.7; 0.5–0.9).
FLUX_EOT_THRESHOLD = 0.7
# Hard cap on a single voice session's wall-clock length, to bound runaway cost if
# a client leaves the mic open. The browser can always reopen a new session.
FLUX_MAX_SESSION_SECONDS = 600

# Flux "TurnInfo" event names → the small client-facing event vocabulary the
# frontend voice loop understands (see frontend/src/api/fluxStream.ts).
_FLUX_EVENT_MAP = {
    "StartOfTurn": "start_of_turn",
    "Update": "update",
    "EagerEndOfTurn": "eager_eot",
    "EndOfTurn": "end_of_turn",
    "TurnResumed": "turn_resumed",
}

# One active Flux voice session per user at a time — a cheap guard against runaway
# concurrent-session cost, since slowapi's Limiter doesn't cover websocket routes.
# Kept separate from stt_stream's set so dictation and voice mode don't collide.
_active_flux_sessions: Set[str] = set()


async def _get_ws_user_id(websocket: WebSocket) -> Optional[str]:
    """Authenticate a websocket from the ?token= query param — jwt_auth_middleware is
    an @app.middleware("http") that Starlette never runs for websockets, and a browser
    can't set an Authorization header on a WS handshake. Mirrors stt_stream._get_ws_user_id."""
    token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        payload = decode_token(token)
    except JWTError:
        return None
    return payload.get("sub")


@router.websocket("/ws")
async def flux_stream_ws(websocket: WebSocket, session: Session = Depends(get_session)):
    await websocket.accept()

    user_id = await _get_ws_user_id(websocket)
    if not user_id:
        await websocket.close(code=4401, reason="unauthorized")
        return

    # Instance-wide feature gate: voice mode is off by default and admin-enabled.
    if not get_bool(session, VOICE_MODE_ENABLED, False):
        await websocket.close(code=4403, reason="voice_mode_disabled")
        return

    if user_id in _active_flux_sessions:
        await websocket.close(code=4409, reason="session_already_active")
        return

    api_key = load_deepgram_api_key(session, user_id)
    if not api_key:
        await websocket.close(code=4400, reason="no_deepgram_key")
        return

    _active_flux_sessions.add(user_id)
    seconds_sent = 0.0
    try:
        upstream_url = (
            f"{DEEPGRAM_FLUX_URL}?model={FLUX_MODEL}"
            f"&eot_threshold={FLUX_EOT_THRESHOLD}"
        )
        async with websockets.connect(
            upstream_url,
            extra_headers={"Authorization": f"Token {api_key}"},
        ) as deepgram_ws:
            logger.info("Flux voice session connected for user %s (model=%s)", user_id, FLUX_MODEL)

            async def pump_client_to_deepgram():
                chunks = 0
                audio_bytes = 0
                try:
                    while True:
                        message = await websocket.receive()
                        if message["type"] == "websocket.disconnect":
                            logger.info(
                                "Voice client disconnected for user %s (code=%s) after %d chunk(s)/%d byte(s)",
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
                                "Voice client requested stop for user %s after %d chunk(s)/%d byte(s)",
                                user_id, chunks, audio_bytes,
                            )
                            try:
                                await deepgram_ws.send(json.dumps({"type": "CloseStream"}))
                            except Exception:
                                pass
                            return
                finally:
                    if chunks == 0:
                        logger.warning("No audio chunks were ever received from the voice client for user %s", user_id)

            async def pump_deepgram_to_client():
                nonlocal seconds_sent
                async for raw in deepgram_ws:
                    try:
                        event = json.loads(raw)
                    except (ValueError, TypeError):
                        continue
                    event_type = event.get("type")
                    if event_type == "TurnInfo":
                        flux_event = event.get("event")
                        client_event = _FLUX_EVENT_MAP.get(flux_event)
                        if not client_event:
                            logger.debug("Unhandled Flux TurnInfo event %r for user %s", flux_event, user_id)
                            continue
                        # Track audio processed for best-effort usage accounting.
                        window_end = event.get("audio_window_end")
                        if isinstance(window_end, (int, float)):
                            seconds_sent = max(seconds_sent, float(window_end))
                        await websocket.send_json({
                            "type": client_event,
                            "text": (event.get("transcript") or "").strip(),
                            "turn_index": event.get("turn_index"),
                        })
                    elif event_type in ("Error", "Fatal"):
                        logger.warning("Flux sent an %s event for user %s: %s", event_type, user_id, event)
                        await websocket.send_json({
                            "type": "error",
                            "message": event.get("description") or event.get("message") or "Deepgram Flux error",
                        })
                    else:
                        # Connected / Metadata / keepalive acks etc.
                        logger.debug("Unhandled Flux event type %r for user %s: %s", event_type, user_id, event)

            recv_task = asyncio.create_task(pump_client_to_deepgram())
            send_task = asyncio.create_task(pump_deepgram_to_client())
            # A wall-clock cap so an abandoned open mic can't run up unbounded cost.
            timeout_task = asyncio.create_task(asyncio.sleep(FLUX_MAX_SESSION_SECONDS))
            try:
                done, pending = await asyncio.wait(
                    {recv_task, send_task, timeout_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if timeout_task in done:
                    logger.info("Flux voice session hit the %ds cap for user %s", FLUX_MAX_SESSION_SECONDS, user_id)
                    try:
                        await websocket.send_json({"type": "error", "message": "Voice session time limit reached"})
                    except Exception:
                        pass
                elif recv_task in done and send_task in pending:
                    # Client stopped/disconnected — give Flux a brief window to flush a
                    # trailing EndOfTurn before tearing the connection down.
                    try:
                        await asyncio.wait_for(send_task, timeout=3.0)
                    except asyncio.TimeoutError:
                        pass
                elif send_task in done and recv_task in pending:
                    logger.warning(
                        "Flux closed its stream for user %s after %.1fs of audio "
                        "(close_code=%s, close_reason=%r)",
                        user_id, seconds_sent, deepgram_ws.close_code, deepgram_ws.close_reason,
                    )
                    try:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Deepgram closed the connection unexpectedly",
                        })
                    except Exception:
                        pass
                # asyncio.wait() never re-raises a task's exception, so surface a failure
                # in either relay leg instead of silently discarding it here.
                for task in (recv_task, send_task):
                    if task.done() and not task.cancelled():
                        task_exc = task.exception()
                        if task_exc is not None:
                            raise task_exc
            finally:
                for task in (recv_task, send_task, timeout_task):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(recv_task, send_task, timeout_task, return_exceptions=True)

    except WebSocketDisconnect as e:
        logger.warning("Voice websocket disconnected for user %s (code=%s, reason=%r)", user_id, e.code, e.reason)
    except Exception as e:
        logger.warning("Flux voice session error for user %s: %s", user_id, e, exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": "Deepgram Flux connection failed"})
        except Exception:
            pass
    finally:
        _active_flux_sessions.discard(user_id)
        if seconds_sent > 0:
            _record_usage(
                session, user_id, "stt", FLUX_MODEL, round(seconds_sent), "seconds",
                provider="deepgram", cost=None, cost_estimated=True,
            )
        try:
            await websocket.close()
        except Exception:
            pass
