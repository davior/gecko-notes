import asyncio
import hashlib
import ipaddress
import json
import re
from pathlib import Path
import logging
import urllib.parse
import uuid
from datetime import datetime, timedelta
import fal_client
import httpx
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Tuple, Union
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth import encrypt_api_key, decrypt_api_key
from app.database import get_session, engine
from app.model_profiles import parse_extra_params
from app.pricing import cost_for
from app.routers.media import MEDIA_DIR as _MEDIA_ROOT
from app.substack_publish import SubstackError, create_substack_draft, test_substack_connection
from app.video.ffmpeg import FFmpegError, ffmpeg_available
from app.video.narration import stitch_chunks_to_mp3, strip_emoji
from app.video.pause_markup import Chunk, parse_pause_markup
from app.web_search import (
    DEFAULT_PROVIDER as WEB_SEARCH_DEFAULT_PROVIDER,
    PROVIDERS as WEB_SEARCH_PROVIDERS,
    SearchError,
    search_web,
)
from app.models import AIProvider, AppSetting, ModelCatalogEntry, User, UsageEvent, UserSetting, SystemPrompt, Theme
from app.schemas import (
    AIProviderCreate, AIProviderUpdate, AIProviderRead, AIProviderTest,
    DataResponse, ListResponse, SettingsUpdate,
    ModelCatalogEntryCreate, ModelCatalogEntryUpdate, ModelCatalogEntryRead,
    SystemPromptCreate, SystemPromptUpdate, SystemPromptRead,
    ThemeCreate, ThemeUpdate, ThemeRead,
)

router = APIRouter()

logger = logging.getLogger(__name__)


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _is_admin(request: Request, session: Session) -> bool:
    user_id = _get_user_id(request)
    user = session.get(User, user_id)
    return bool(user and user.is_admin)


def _record_usage(
    session: Session,
    user_id: str,
    kind: str,
    model: str,
    units: int,
    unit_type: str,
    provider: Optional[str] = None,
    external_ref: Optional[str] = None,
    cost: Optional[float] = None,
    currency: Optional[str] = None,
    cost_estimated: Optional[bool] = None,
) -> None:
    """Record an external-API usage event. Best-effort: never breaks the request.

    `provider` groups events in the usage dashboard ("anthropic"/"openai"/"deepseek"/
    "ollama"/"fal.ai"). `external_ref`/`cost`/`currency` are cost attribution; `cost_estimated`
    flags a list-price estimate (LLM tokens) vs a provider-billed exact amount (fal)."""
    try:
        session.add(UsageEvent(
            id=str(uuid.uuid4()),
            user_id=user_id,
            kind=kind,
            provider=provider,
            model=model or "",
            units=int(units or 0),
            unit_type=unit_type or "",
            created_at=datetime.utcnow(),
            external_ref=external_ref,
            cost=cost,
            currency=currency,
            cost_estimated=cost_estimated,
        ))
        session.commit()
    except Exception:
        session.rollback()


def _record_ai_usage(
    session: Session,
    user_id: str,
    provider_type: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    """Record an `ai` usage event with a list-price cost estimate.

    `units` stays the total token count (input+output, matching the historical shape);
    cost is estimated per provider/model and flagged `cost_estimated=True`. Best-effort."""
    total = int(input_tokens or 0) + int(output_tokens or 0)
    if total <= 0:
        return
    estimate = cost_for(provider_type, model, input_tokens, output_tokens)
    cost = estimate[0] if estimate else None
    currency = estimate[1] if estimate else None
    _record_usage(
        session, user_id, "ai", model, total, "tokens",
        provider=provider_type, cost=cost, currency=currency,
        cost_estimated=True if estimate else None,
    )


def _require_safe_external_url(url: str) -> None:
    """Reject URLs that could be used for SSRF against internal services."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_url", "message": "Base URL must use https://"},
        )
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_url", "message": "Base URL has no valid hostname"},
        )
    try:
        addr = ipaddress.ip_address(hostname)
        if not addr.is_global:
            raise HTTPException(
                status_code=400,
                detail={"code": "ssrf_blocked", "message": "Base URL must point to a public host"},
            )
    except ValueError:
        if hostname == "localhost":
            raise HTTPException(
                status_code=400,
                detail={"code": "ssrf_blocked", "message": "Base URL must point to a public host"},
            )


# ─── App Settings (per-user) ──────────────────────────────────────────────────

@router.get("", response_model=Dict[str, Any])
def get_settings(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    rows = session.exec(select(UserSetting).where(UserSetting.user_id == user_id)).all()
    result = {}
    for row in rows:
        try:
            result[row.key] = json.loads(row.value)
        except Exception:
            result[row.key] = row.value
    return result


@router.put("", response_model=Dict[str, Any])
def update_settings(payload: SettingsUpdate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    for key, value in payload.settings.items():
        existing = session.exec(
            select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == key)
        ).first()
        serialised = json.dumps(value)
        if existing:
            existing.value = serialised
            session.add(existing)
        else:
            session.add(UserSetting(user_id=user_id, key=key, value=serialised))
    session.commit()

    rows = session.exec(select(UserSetting).where(UserSetting.user_id == user_id)).all()
    result = {}
    for row in rows:
        try:
            result[row.key] = json.loads(row.value)
        except Exception:
            result[row.key] = row.value
    return result


# ─── AI Providers (per-user) ──────────────────────────────────────────────────

@router.get("/ai-providers", response_model=ListResponse[AIProviderRead])
def list_ai_providers(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    providers = session.exec(select(AIProvider).where(AIProvider.user_id == user_id)).all()
    return ListResponse(
        data=[AIProviderRead.model_validate(p) for p in providers],
        total=len(providers),
        limit=len(providers),
        offset=0,
    )


@router.post("/ai-providers", response_model=DataResponse[AIProviderRead], status_code=201)
def create_ai_provider(payload: AIProviderCreate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    if payload.provider_type in ("openai", "custom") and payload.base_url:
        _require_safe_external_url(payload.base_url)
    provider = AIProvider(
        id=str(uuid.uuid4()),
        name=payload.name,
        provider_type=payload.provider_type,
        api_key=encrypt_api_key(payload.api_key) if payload.api_key else "",
        base_url=payload.base_url,
        model=payload.model,
        max_tokens=payload.max_tokens,
        supports_images=payload.supports_images,
        use_anthropic_api=payload.use_anthropic_api,
        extra_params=json.dumps(payload.extra_params) if payload.extra_params else None,
        enabled=payload.enabled,
        is_active=payload.is_active,
        user_id=user_id,
    )
    if payload.is_active:
        others = session.exec(select(AIProvider).where(AIProvider.user_id == user_id)).all()
        for o in others:
            o.is_active = False
            session.add(o)
    session.add(provider)
    session.commit()
    session.refresh(provider)
    return DataResponse(data=AIProviderRead.model_validate(provider))


@router.put("/ai-providers/{provider_id}", response_model=DataResponse[AIProviderRead])
def update_ai_provider(
    provider_id: str,
    payload: AIProviderUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})

    # Validate a new base_url BEFORE storing it. This used to ride inside the
    # `if payload.api_key:` block below, so changing only the URL skipped the check —
    # and the stored URL is what the proxies POST to (both the OpenAI-compatible one
    # and, for an Anthropic-compatible gateway, the Messages one).
    if payload.base_url and (payload.provider_type or provider.provider_type) in ("openai", "custom"):
        _require_safe_external_url(payload.base_url)

    for field in ["name", "provider_type", "base_url", "model", "max_tokens", "supports_images", "use_anthropic_api", "enabled", "is_active"]:
        val = getattr(payload, field, None)
        if val is not None:
            setattr(provider, field, val)
    # extra_params is a dict on the wire but stored as JSON text; sending {} clears it.
    if payload.extra_params is not None:
        provider.extra_params = json.dumps(payload.extra_params) if payload.extra_params else None
    if payload.api_key:
        provider.api_key = encrypt_api_key(payload.api_key)

    if payload.is_active:
        others = session.exec(select(AIProvider).where(AIProvider.user_id == user_id)).all()
        for o in others:
            if o.id != provider_id:
                o.is_active = False
                session.add(o)

    session.add(provider)
    session.commit()
    session.refresh(provider)
    return DataResponse(data=AIProviderRead.model_validate(provider))


@router.delete("/ai-providers/{provider_id}", status_code=204)
def delete_ai_provider(provider_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    session.delete(provider)
    session.commit()


@router.post("/ai-providers/{provider_id}/activate", response_model=DataResponse[AIProviderRead])
def activate_ai_provider(provider_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})

    all_providers = session.exec(select(AIProvider).where(AIProvider.user_id == user_id)).all()
    for p in all_providers:
        p.is_active = p.id == provider_id
        session.add(p)

    session.commit()
    session.refresh(provider)
    return DataResponse(data=AIProviderRead.model_validate(provider))


@router.post("/ai-providers/test", response_model=Dict[str, Any])
async def test_ai_provider(
    payload: AIProviderTest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Test connection to an AI provider. Requires authentication."""
    user_id = _get_user_id(request)

    # Resolve the API key: prefer the stored (encrypted) key when a provider_id is given
    api_key = payload.api_key
    base_url = payload.base_url
    if payload.provider_id:
        provider = session.get(AIProvider, payload.provider_id)
        if not provider or provider.user_id != user_id:
            raise HTTPException(
                status_code=404,
                detail={"code": "not_found", "message": "AI provider not found"},
            )
        api_key = decrypt_api_key(provider.api_key)
        base_url = base_url or provider.base_url

    # A provider that speaks the Anthropic protocol is tested against THAT endpoint
    # whatever its type — otherwise a DeepSeek provider on api.deepseek.com/anthropic
    # would be tested against the OpenAI-compatible endpoint it no longer uses, and
    # report success (or failure) for the wrong URL entirely.
    speaks_anthropic = payload.provider_type == "anthropic" or payload.use_anthropic_api

    try:
        if speaks_anthropic:
            probe = AIProvider(
                id="probe",
                name="probe",
                provider_type=payload.provider_type,
                api_key="",
                base_url=base_url,
                model=payload.model,
                use_anthropic_api=payload.use_anthropic_api,
            )
            headers = _anthropic_headers(probe, uses_web_search=False)
            # The probe carries no stored key, so put the one under test in by hand
            # (both header names, for the same reason _anthropic_headers sends both).
            headers["x-api-key"] = api_key
            if "Authorization" in headers:
                headers["Authorization"] = f"Bearer {api_key}"
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{_anthropic_base(probe)}/v1/messages",
                    headers=headers,
                    json={
                        "model": payload.model,
                        "max_tokens": 10,
                        "messages": [{"role": "user", "content": "Hi"}],
                    },
                )
            if response.status_code in (200, 400):
                return {"success": True, "message": "Connection successful"}
            return {"success": False, "message": f"HTTP {response.status_code}"}

        elif payload.provider_type in ("openai", "deepseek", "custom"):
            base = _openai_compat_base(payload.provider_type, base_url)
            _require_safe_external_url(base)
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{base}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "content-type": "application/json",
                    },
                    json={
                        "model": payload.model,
                        "max_tokens": 10,
                        "messages": [{"role": "user", "content": "Hi"}],
                    },
                )
            if response.status_code in (200, 400):
                return {"success": True, "message": "Connection successful"}
            return {"success": False, "message": f"HTTP {response.status_code}"}

        elif payload.provider_type == "ollama":
            base = (base_url or "http://localhost:11434").rstrip("/")
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{base}/api/tags")
            if response.status_code == 200:
                return {"success": True, "message": "Ollama reachable"}
            return {"success": False, "message": f"HTTP {response.status_code}"}

        else:
            return {"success": False, "message": "Unknown provider type"}

    except HTTPException:
        raise
    except Exception as e:
        return {"success": False, "message": str(e)}


# ─── System Prompts (per-user) ────────────────────────────────────────────────

@router.get("/system-prompts", response_model=ListResponse[SystemPromptRead])
def list_system_prompts(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    prompts = session.exec(select(SystemPrompt).where(SystemPrompt.user_id == user_id)).all()
    return ListResponse(
        data=[SystemPromptRead.model_validate(p) for p in prompts],
        total=len(prompts),
        limit=len(prompts),
        offset=0,
    )


@router.post("/system-prompts", response_model=DataResponse[SystemPromptRead], status_code=201)
def create_system_prompt(payload: SystemPromptCreate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    if payload.is_active:
        for p in session.exec(select(SystemPrompt).where(SystemPrompt.user_id == user_id)).all():
            p.is_active = False
            session.add(p)
    prompt = SystemPrompt(
        id=str(uuid.uuid4()),
        name=payload.name,
        content=payload.content,
        is_active=payload.is_active,
        sort_order=payload.sort_order,
        user_id=user_id,
    )
    session.add(prompt)
    session.commit()
    session.refresh(prompt)
    return DataResponse(data=SystemPromptRead.model_validate(prompt))


@router.put("/system-prompts/{prompt_id}", response_model=DataResponse[SystemPromptRead])
def update_system_prompt(prompt_id: str, payload: SystemPromptUpdate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    prompt = session.get(SystemPrompt, prompt_id)
    if not prompt or prompt.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "System prompt not found"})
    if payload.is_active:
        for p in session.exec(select(SystemPrompt).where(SystemPrompt.user_id == user_id)).all():
            if p.id != prompt_id:
                p.is_active = False
                session.add(p)
    for field in ["name", "content", "is_active", "sort_order"]:
        val = getattr(payload, field, None)
        if val is not None:
            setattr(prompt, field, val)
    session.add(prompt)
    session.commit()
    session.refresh(prompt)
    return DataResponse(data=SystemPromptRead.model_validate(prompt))


@router.delete("/system-prompts/{prompt_id}", status_code=204)
def delete_system_prompt(prompt_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    prompt = session.get(SystemPrompt, prompt_id)
    if not prompt or prompt.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "System prompt not found"})
    session.delete(prompt)
    session.commit()


@router.post("/system-prompts/{prompt_id}/activate", response_model=DataResponse[SystemPromptRead])
def activate_system_prompt(prompt_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    prompt = session.get(SystemPrompt, prompt_id)
    if not prompt or prompt.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "System prompt not found"})
    for p in session.exec(select(SystemPrompt).where(SystemPrompt.user_id == user_id)).all():
        p.is_active = p.id == prompt_id
        session.add(p)
    session.commit()
    session.refresh(prompt)
    return DataResponse(data=SystemPromptRead.model_validate(prompt))


# ─── AI Provider Proxies ─────────────────────────────────────────────────────

_RETRY_STATUS_CODES = {429, 503}
_MAX_UPSTREAM_ATTEMPTS = 3
_RETRY_BASE_DELAY = 0.5

# Read timeout for blocking upstream POSTs. A full-note summary/tag/rewrite body can take
# well over a minute to generate, and a blocking request returns nothing until the whole
# completion is ready, so a short cap fails with a ReadTimeout mid-generation. 120s matches
# the streaming paths and the Anthropic read timeout, and stays under the nginx /api/
# proxy_read_timeout (300s). Connect/write/pool stay short (see _post_upstream) so a
# genuinely unreachable provider still fails fast.
_BLOCKING_UPSTREAM_TIMEOUT = 120.0


async def _post_upstream(
    url: str,
    *,
    headers: Dict[str, str],
    json_body: Dict[str, Any],
    timeout: float,
    provider_label: str,
) -> httpx.Response:
    """POST to an upstream AI provider, translating connection-level failures
    into informative 5xx errors.

    Without this, a network / DNS / TLS / timeout failure raises an uncaught
    exception that FastAPI returns as an opaque ``500 Internal Server Error`` with
    no body — so the only way to learn the cause was to read the server logs. We
    surface the exception type and message in ``detail`` (which the client renders
    in its error panel) while still logging the full traceback server-side. A
    real HTTP error response from the provider is NOT handled here; the caller
    forwards that (with the upstream body) via ``response.is_success``.

    A 429/503 response is retried a couple of times with a short backoff before
    being handed back — the upstream explicitly asked us to back off, so retrying
    a fresh request is safe (nothing was billed/produced on that attempt). Any
    other status is returned immediately, same as before.
    """
    try:
        # Split the timeout: allow a long read (a blocking POST returns nothing until the
        # whole completion is generated) while keeping connect/write/pool short so a dead
        # endpoint fails fast instead of hanging for the entire read window.
        client_timeout = httpx.Timeout(
            timeout, connect=min(timeout, 10.0), write=min(timeout, 30.0), pool=min(timeout, 10.0)
        )
        async with httpx.AsyncClient(timeout=client_timeout) as client:
            for attempt in range(_MAX_UPSTREAM_ATTEMPTS):
                response = await client.post(url, headers=headers, json=json_body)
                if response.status_code not in _RETRY_STATUS_CODES or attempt == _MAX_UPSTREAM_ATTEMPTS - 1:
                    return response
                await asyncio.sleep(_RETRY_BASE_DELAY * (2 ** attempt))
            return response
    except httpx.TimeoutException as e:
        logger.exception("Timed out contacting %s", provider_label)
        raise HTTPException(
            status_code=504,
            detail={
                "code": "upstream_timeout",
                "message": f"Timed out after {timeout:.0f}s contacting {provider_label} ({type(e).__name__}).",
            },
        )
    except httpx.RequestError as e:
        logger.exception("Failed to reach %s", provider_label)
        raise HTTPException(
            status_code=502,
            detail={
                "code": "upstream_unreachable",
                "message": f"Could not reach {provider_label}: {type(e).__name__}: {e}",
            },
        )


async def _iter_anthropic_events(
    url: str,
    *,
    headers: Dict[str, str],
    json_body: Dict[str, Any],
    read_timeout: float,
) -> AsyncIterator[Tuple[str, Any]]:
    """Stream a Messages API response from Anthropic, yielding ("delta", text) for
    each text chunk as it arrives and finally ("final", message) with the fully
    reassembled message dict — the identical shape the non-streaming endpoint returns.

    Why stream instead of a single blocking POST: a non-streaming request returns
    no bytes until the *entire* completion is generated, so the read timeout has
    to cover total generation time. A large note (tens of thousands of tokens of
    system-prompt context) plus web-search latency (each server-side search pauses
    generation) routinely pushes that past 120s, and the request fails with a
    ReadTimeout 504 even though it would have eventually succeeded. Streaming keeps
    a steady flow of SSE events (text deltas and periodic pings), so ``read_timeout``
    bounds the gap *between* events — always small — rather than the whole request.

    The blocking wrapper below consumes only the "final" event; the streaming
    endpoints forward the "delta" text to the browser live.
    """
    body = {**json_body, "stream": True}
    timeout = httpx.Timeout(read_timeout, connect=10.0, write=30.0, pool=10.0)

    message: Dict[str, Any] = {}
    json_buffers: Dict[int, str] = {}  # index -> accumulated input_json_delta text

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, headers=headers, json=body) as response:
                if not response.is_success:
                    # Read the (small) error body so we can forward it like the
                    # blocking path does — without aread() the body isn't loaded.
                    await response.aread()
                    raise HTTPException(status_code=response.status_code, detail=response.text)

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if not payload:
                        continue
                    event = json.loads(payload)
                    etype = event.get("type")

                    if etype == "message_start":
                        message = event.get("message", {}) or {}
                        message.setdefault("content", [])
                    elif etype == "content_block_start":
                        idx = event.get("index", 0)
                        block = event.get("content_block", {}) or {}
                        content = message.setdefault("content", [])
                        while len(content) <= idx:
                            content.append({})
                        content[idx] = block
                    elif etype == "content_block_delta":
                        idx = event.get("index", 0)
                        content = message.setdefault("content", [])
                        if idx >= len(content):
                            continue
                        block = content[idx]
                        delta = event.get("delta", {}) or {}
                        dtype = delta.get("type")
                        if dtype == "text_delta":
                            chunk = delta.get("text", "")
                            block["text"] = (block.get("text") or "") + chunk
                            if chunk:
                                yield ("delta", chunk)
                        elif dtype == "input_json_delta":
                            json_buffers[idx] = json_buffers.get(idx, "") + delta.get("partial_json", "")
                        elif dtype == "thinking_delta":
                            block["thinking"] = (block.get("thinking") or "") + delta.get("thinking", "")
                        elif dtype == "signature_delta":
                            block["signature"] = (block.get("signature") or "") + delta.get("signature", "")
                        elif dtype == "citations_delta":
                            citation = delta.get("citation")
                            if citation is not None:
                                block.setdefault("citations", []).append(citation)
                    elif etype == "content_block_stop":
                        idx = event.get("index", 0)
                        raw = json_buffers.pop(idx, None)
                        if raw is not None:
                            content = message.get("content", [])
                            if idx < len(content):
                                try:
                                    content[idx]["input"] = json.loads(raw) if raw else {}
                                except json.JSONDecodeError:
                                    content[idx]["input"] = {}
                    elif etype == "message_delta":
                        delta = event.get("delta", {}) or {}
                        message.update(delta)  # stop_reason, stop_sequence
                        usage = event.get("usage")
                        if usage:
                            message.setdefault("usage", {}).update(usage)
                    elif etype == "message_stop":
                        break
                    elif etype == "error":
                        err = event.get("error", {}) or {}
                        raise HTTPException(
                            status_code=502,
                            detail={
                                "code": "upstream_error",
                                "message": f"Anthropic stream error: {err.get('type', 'error')}: {err.get('message', '')}",
                            },
                        )
    except HTTPException:
        raise
    except httpx.TimeoutException as e:
        logger.exception("Timed out streaming from Anthropic")
        raise HTTPException(
            status_code=504,
            detail={
                "code": "upstream_timeout",
                "message": f"Anthropic stopped sending data for {read_timeout:.0f}s ({type(e).__name__}).",
            },
        )
    except httpx.RequestError as e:
        logger.exception("Failed to reach Anthropic")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "upstream_unreachable",
                "message": f"Could not reach Anthropic: {type(e).__name__}: {e}",
            },
        )

    yield ("final", message)


async def _stream_anthropic_message(
    url: str,
    *,
    headers: Dict[str, str],
    json_body: Dict[str, Any],
    read_timeout: float,
    on_delta: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Blocking wrapper over :func:`_iter_anthropic_events`: drain the stream and
    return the reassembled message dict, so the non-streaming proxy is unchanged.

    `on_delta` is how a worker watches a reply it is not returning to a browser. The
    assistant's planning call takes minutes, and without it the chat sits silent for
    the whole of it; the worker writes what it receives onto its job row so the panel
    can poll for it. A sink that raises must not take the generation down, so it is
    called defensively.
    """
    message: Dict[str, Any] = {}
    async for kind, val in _iter_anthropic_events(
        url, headers=headers, json_body=json_body, read_timeout=read_timeout
    ):
        if kind == "final":
            message = val
        elif kind == "delta" and on_delta is not None:
            _feed(on_delta, val)
    return message


def _feed(on_delta: Callable[[str], None], text: str) -> None:
    """Hand one chunk to a delta sink. A sink that fails is a preview that stops
    updating, never a generation that dies."""
    try:
        on_delta(text)
    except Exception:
        logger.exception("A delta sink raised; dropping the chunk")


# ─── the same, for the other two protocols ───────────────────────────────────
#
# The Anthropic blocking proxy has always streamed internally (see above); these two
# posted once and waited. Extracting their stream loops out of the SSE endpoints gives
# all three protocols one shape — ("delta", text) then ("final", <the dict the blocking
# path returns>) — so the SSE routes and a worker watching a planning call drain the
# same generator instead of each having its own copy of the parsing.


async def _iter_openai_events(
    url: str,
    *,
    headers: Dict[str, str],
    json_body: Dict[str, Any],
    read_timeout: float,
) -> AsyncIterator[Tuple[str, Any]]:
    """Stream an OpenAI-compatible chat completion, reassembling the blocking shape.

    `stream_options.include_usage` is what keeps usage accounting working: without it
    a streamed completion reports no token counts at all.
    """
    body = {**json_body, "stream": True, "stream_options": {"include_usage": True}}
    timeout = httpx.Timeout(read_timeout, connect=10.0, write=30.0, pool=10.0)

    full = ""
    finish_reason = None
    usage = None
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=body) as response:
            if not response.is_success:
                await response.aread()
                raise HTTPException(status_code=response.status_code, detail=response.text)
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[len("data:"):].strip()
                if not data_str or data_str == "[DONE]":
                    continue
                try:
                    evt = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                choices = evt.get("choices") or []
                if choices:
                    ch0 = choices[0] or {}
                    piece = (ch0.get("delta") or {}).get("content")
                    if piece:
                        full += piece
                        yield "delta", piece
                    if ch0.get("finish_reason"):
                        finish_reason = ch0["finish_reason"]
                if evt.get("usage"):
                    usage = evt["usage"]

    yield "final", {
        "choices": [{"message": {"role": "assistant", "content": full}, "finish_reason": finish_reason}],
        "usage": usage or {},
    }


async def _iter_ollama_events(
    url: str,
    *,
    json_body: Dict[str, Any],
    read_timeout: float,
) -> AsyncIterator[Tuple[str, Any]]:
    """Stream an Ollama chat response. Ollama sends newline-delimited JSON, not SSE."""
    body = {**json_body, "stream": True}
    timeout = httpx.Timeout(read_timeout, connect=10.0, write=30.0, pool=10.0)

    full = ""
    done_reason = None
    prompt_eval = 0
    eval_count = 0
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST", url, headers={"content-type": "application/json"}, json=body
        ) as response:
            if not response.is_success:
                await response.aread()
                raise HTTPException(status_code=response.status_code, detail=response.text)
            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                except json.JSONDecodeError:
                    continue
                piece = (evt.get("message") or {}).get("content")
                if piece:
                    full += piece
                    yield "delta", piece
                if evt.get("done"):
                    done_reason = evt.get("done_reason")
                    prompt_eval = int(evt.get("prompt_eval_count", 0) or 0)
                    eval_count = int(evt.get("eval_count", 0) or 0)

    yield "final", {
        "message": {"role": "assistant", "content": full},
        "done_reason": done_reason,
        "prompt_eval_count": prompt_eval,
        "eval_count": eval_count,
    }


async def _drain(events: AsyncIterator[Tuple[str, Any]], on_delta: Optional[Callable[[str], None]]) -> Dict[str, Any]:
    """Run a stream to completion and return its final message."""
    message: Dict[str, Any] = {}
    async for kind, val in events:
        if kind == "final":
            message = val
        elif kind == "delta" and on_delta is not None:
            _feed(on_delta, val)
    return message


# ─── The Anthropic Messages protocol ─────────────────────────────────────────
#
# The Messages protocol is no longer only Anthropic's. DeepSeek publishes an
# Anthropic-compatible endpoint at api.deepseek.com/anthropic, and — this is the
# point of it here — that endpoint runs the same SERVER-SIDE web_search tool Claude
# does. So a DeepSeek provider pointed at it searches the web natively, exactly the
# way a Claude one does: no third-party search key, no per-search fee, nothing for
# the app to run. Its OpenAI-compatible endpoint (see `_openai_compat_base`) has no
# such tool, which is why DeepSeek could not search before.
#
# A provider opts in per row with `use_anthropic_api`; `anthropic` itself is always
# on this path. Everything downstream — the proxies, the frontend's AnthropicProvider,
# the assistant's native web-search mode — keys off that, not off the vendor name.

_ANTHROPIC_BASE = "https://api.anthropic.com"
_DEEPSEEK_ANTHROPIC_BASE = "https://api.deepseek.com/anthropic"


# Types that may be pointed at an Anthropic-compatible endpoint instead of their own.
# `ollama` is deliberately excluded: it speaks only its own protocol, and its base_url is
# allowed to be a private address (the one place the app permits that), so honouring the
# flag there would aim the Messages proxy at an internal host.
_ANTHROPIC_CAPABLE_TYPES = ("deepseek", "custom")


def _speaks_anthropic(provider: AIProvider) -> bool:
    """Whether this provider is addressed over the Anthropic Messages protocol."""
    if provider.provider_type == "anthropic":
        return True
    return bool(provider.use_anthropic_api) and provider.provider_type in _ANTHROPIC_CAPABLE_TYPES


def _anthropic_base(provider: AIProvider) -> str:
    """Base URL for a provider's Messages endpoint.

    Anthropic's own is fixed, and so is DeepSeek's — its stored `base_url` describes
    the OpenAI-compatible endpoint, so it is deliberately ignored here (the same
    reasoning as `_openai_compat_base`: a fixed managed endpoint spares the user a
    field and stops a crafted base_url redirecting the proxy). Any other provider
    opting in supplies its own gateway URL, already SSRF-checked when it was saved.
    """
    if provider.provider_type == "anthropic":
        return _ANTHROPIC_BASE
    if provider.provider_type == "deepseek":
        return _DEEPSEEK_ANTHROPIC_BASE
    return (provider.base_url or _ANTHROPIC_BASE).rstrip("/")


def _anthropic_headers(provider: AIProvider, *, uses_web_search: bool) -> Dict[str, str]:
    """Auth and protocol headers for one Messages request.

    Beta flags go only to Anthropic: they name Anthropic-internal features, and a
    gateway that doesn't recognise one could reject the whole request over a feature
    it was never asked for. Compatible gateways get BOTH auth headers because they
    disagree about which to read — DeepSeek documents `x-api-key`, while Claude Code's
    own `ANTHROPIC_AUTH_TOKEN` path sends a bearer token — and an unread header is
    simply ignored.
    """
    key = decrypt_api_key(provider.api_key)
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    if provider.provider_type == "anthropic":
        beta_flags = "pdfs-2024-09-25"
        if uses_web_search:
            beta_flags += ",web-search-2025-03-05"
        headers["anthropic-beta"] = beta_flags
    else:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _requests_web_search(tools: Optional[List[Dict[str, Any]]]) -> bool:
    return bool(tools) and any(t.get("type", "").startswith("web_search") for t in tools)


class AnthropicProxyRequest(BaseModel):
    provider_id: str
    model: str
    max_tokens: int
    messages: List[Dict[str, Any]]
    system: Optional[Union[str, List[Dict[str, Any]]]] = None
    prefill: Optional[str] = None
    tools: Optional[List[Dict[str, Any]]] = None


@router.post("/ai-providers/proxy/anthropic")
async def proxy_anthropic(payload: AnthropicProxyRequest, request: Request, session: Session = Depends(get_session)):
    return await anthropic_completion(payload, _get_user_id(request), session)


async def anthropic_completion(
    payload: AnthropicProxyRequest,
    user_id: str,
    session: Session,
    *,
    on_delta: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """One Messages call, as this user.

    Split out of the route so a worker can call it without inventing a Request. It
    already resolves the provider, applies its stored extra params and records usage,
    which is the whole reason `provider.py` goes through here rather than reaching for
    httpx itself — a generated body is billed and attributed identically whether the
    browser or a worker asked for it. `on_delta` lets a caller with no HTTP response to
    stream watch the reply as it arrives.
    """
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if not _speaks_anthropic(provider):
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider does not use the Anthropic API"})

    messages = list(payload.messages)
    if payload.prefill:
        messages.append({"role": "assistant", "content": payload.prefill})

    body: Dict[str, Any] = {
        "model": payload.model,
        "max_tokens": payload.max_tokens,
        "messages": messages,
    }
    if payload.system:
        body["system"] = payload.system
    if payload.tools:
        body["tools"] = payload.tools
    # Per-model extra params (temperature, top_p, provider-specific knobs) stored on the
    # provider and merged in. Structural keys are stripped, so this can't override
    # model/messages/system/tools. Kept byte-for-byte identical in both Anthropic
    # builders to preserve the prompt-cache breakpoints.
    body.update(parse_extra_params(provider.extra_params))

    # Stream the completion rather than blocking on one big POST: a large note plus
    # web-search latency easily exceeds a fixed total timeout, and a non-streaming
    # request returns nothing until it's fully generated, so it fails with a
    # ReadTimeout. Streaming keeps SSE events flowing (deltas + pings), so the
    # timeout only bounds the gap between events. We reassemble the final message
    # so the response shape is unchanged for the caller.
    data = await _stream_anthropic_message(
        f"{_anthropic_base(provider)}/v1/messages",
        headers=_anthropic_headers(provider, uses_web_search=_requests_web_search(payload.tools)),
        json_body=body,
        read_timeout=120.0,
        on_delta=on_delta,
    )
    try:
        usage = data.get("usage") or {}
        inp = int(usage.get("input_tokens", 0) or 0)
        out = int(usage.get("output_tokens", 0) or 0)
        cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
        cache_write = int(usage.get("cache_creation_input_tokens", 0) or 0)
        # Cache reads/writes are billable input too, so count them toward usage. Log the
        # breakdown so the prompt-cache hit rate is observable end-to-end: a high
        # cache_read with low input means the stable prefix is being reused; a
        # cache_read of ~0 across turns means a cache miss (prefix changed or too small).
        total = inp + out + cache_read + cache_write
        if total:
            # Cache reads/writes are billable input; fold them into the input side for costing.
            # Attributed to the provider's own type, not the protocol it speaks — a DeepSeek
            # provider on the Anthropic endpoint is still DeepSeek spend.
            _record_ai_usage(session, user_id, provider.provider_type, payload.model, inp + cache_read + cache_write, out)
        logger.info(
            "%s (anthropic protocol) usage model=%s input=%d output=%d cache_read=%d cache_write=%d",
            provider.provider_type, payload.model, inp, out, cache_read, cache_write,
        )
    except Exception:
        pass
    return data


class OpenAIProxyRequest(BaseModel):
    provider_id: str
    model: str
    max_tokens: int
    messages: List[Dict[str, Any]]


def _openai_compat_base(provider_type: Optional[str], base_url: Optional[str]) -> str:
    """Resolve the upstream base URL for an OpenAI-compatible provider.

    DeepSeek is a fixed managed endpoint (like OpenAI's own), so it ignores any
    stored base_url — that both spares the user a URL field and stops a crafted
    base_url from redirecting the proxy. `openai`/`custom` keep the existing
    behaviour (custom supplies its own base, already SSRF-checked on save)."""
    if provider_type == "deepseek":
        return "https://api.deepseek.com"
    return (base_url or "https://api.openai.com").rstrip("/")


@router.post("/ai-providers/proxy/openai")
async def proxy_openai(
    payload: OpenAIProxyRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    return await openai_completion(payload, _get_user_id(request), session)


async def openai_completion(
    payload: OpenAIProxyRequest,
    user_id: str,
    session: Session,
    *,
    on_delta: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """One chat completion, as this user. See :func:`anthropic_completion`.

    Without a delta sink this posts once and waits, exactly as before. With one it
    takes the streaming path instead, which returns the same dict — the only caller
    that needs deltas is a worker watching a planning call, and there is no reason to
    change how the browser's own blocking calls behave.
    """
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type not in ("openai", "deepseek", "custom"):
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not OpenAI-compatible"})

    base = _openai_compat_base(provider.provider_type, provider.base_url)
    body: Dict[str, Any] = {
        "model": payload.model,
        "max_tokens": payload.max_tokens,
        "messages": payload.messages,
    }
    # Per-model extra params (temperature, top_p, provider-specific knobs) stored on the provider.
    body.update(parse_extra_params(provider.extra_params))

    url = f"{base}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {decrypt_api_key(provider.api_key)}",
        "content-type": "application/json",
    }

    if on_delta is not None:
        data = await _drain(
            _iter_openai_events(url, headers=headers, json_body=body, read_timeout=120.0),
            on_delta,
        )
    else:
        response = await _post_upstream(
            url,
            headers=headers,
            json_body=body,
            timeout=_BLOCKING_UPSTREAM_TIMEOUT,
            provider_label="the OpenAI-compatible API",
        )
        if not response.is_success:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        data = response.json()

    try:
        usage = data.get("usage") or {}
        inp = int(usage.get("prompt_tokens", 0) or 0)
        out = int(usage.get("completion_tokens", 0) or 0)
        if not (inp or out):
            # Some OpenAI-compatible providers only report total_tokens; cost it as input.
            inp = int(usage.get("total_tokens", 0) or 0)
        _record_ai_usage(session, user_id, provider.provider_type, payload.model, inp, out)
    except Exception:
        pass
    return data


class OllamaProxyRequest(BaseModel):
    provider_id: str
    model: str
    messages: List[Dict[str, Any]]
    max_tokens: Optional[int] = None


@router.post("/ai-providers/proxy/ollama")
async def proxy_ollama(
    payload: OllamaProxyRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    return await ollama_completion(payload, _get_user_id(request), session)


async def ollama_completion(
    payload: OllamaProxyRequest,
    user_id: str,
    session: Session,
    *,
    on_delta: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """One Ollama chat call, as this user. See :func:`anthropic_completion`."""
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type != "ollama":
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not Ollama type"})

    base = (provider.base_url or "http://localhost:11434").rstrip("/")
    body: Dict[str, Any] = {
        "model": payload.model,
        "messages": payload.messages,
        "stream": False,
    }
    # Ollama nests params under `options`; num_predict is its output cap (from
    # max_tokens). Other params (temperature, top_k, …) come from the provider's
    # extra_params blob.
    options: Dict[str, Any] = dict(parse_extra_params(provider.extra_params))
    if payload.max_tokens is not None:
        options["num_predict"] = payload.max_tokens
    if options:
        body["options"] = options

    url = f"{base}/api/chat"

    if on_delta is not None:
        data = await _drain(
            _iter_ollama_events(url, json_body=body, read_timeout=120.0), on_delta
        )
    else:
        response = await _post_upstream(
            url,
            headers={"content-type": "application/json"},
            json_body=body,
            timeout=_BLOCKING_UPSTREAM_TIMEOUT,
            provider_label="Ollama",
        )
        if not response.is_success:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        data = response.json()

    try:
        inp = int(data.get("prompt_eval_count", 0) or 0)
        out = int(data.get("eval_count", 0) or 0)
        _record_ai_usage(session, user_id, "ollama", payload.model, inp, out)
    except Exception:
        pass
    return data


# ─── AI Provider Proxies — streaming (SSE) ───────────────────────────────────
#
# These mirror the blocking proxies above but return a StreamingResponse so the
# browser can render tokens live. All three speak one normalized protocol to the
# client (so the frontend needs no provider-specific delta parsing):
#     event: delta   data: {"text": "<chunk>"}
#     event: final   data: <the full provider dict, same shape the blocking path returns>
#     event: error   data: {"code": "...", "message": "..."}
# A StreamingResponse is already HTTP 200 once the body starts, so ALL failures —
# including an upstream non-200 or a mid-stream error — are surfaced as an `error`
# frame rather than an HTTP status. The blocking endpoints are kept for callers
# that don't stream (deferred body generation, tag/summary helpers). Usage is
# recorded server-side after the `final` event via a fresh Session (the request
# session may be closed by the time the generator finishes).

_STREAM_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}


def _sse(event: str, data: Any) -> str:
    """Format one Server-Sent Events frame."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _error_frame(exc: Exception) -> str:
    """An `error` SSE frame carrying the same detail shape the blocking path 4xx/5xxs with."""
    if isinstance(exc, HTTPException):
        detail = exc.detail
        data = detail if isinstance(detail, dict) else {"message": str(detail)}
    else:
        data = {"code": "stream_failed", "message": str(exc)}
    return _sse("error", data)


def _record_anthropic_usage(user_id: str, provider_type: str, model: str, data: Dict[str, Any]) -> None:
    """Mirror the usage accounting in proxy_anthropic, using a fresh Session.

    `provider_type` is the provider's own type rather than the protocol it speaks, so a
    DeepSeek provider on the Anthropic endpoint is costed and charted as DeepSeek."""
    try:
        usage = data.get("usage") or {}
        inp = int(usage.get("input_tokens", 0) or 0)
        out = int(usage.get("output_tokens", 0) or 0)
        cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
        cache_write = int(usage.get("cache_creation_input_tokens", 0) or 0)
        total = inp + out + cache_read + cache_write
        if total:
            with Session(engine) as s:
                _record_ai_usage(s, user_id, provider_type, model, inp + cache_read + cache_write, out)
        logger.info(
            "%s (anthropic protocol) stream usage model=%s input=%d output=%d cache_read=%d cache_write=%d",
            provider_type, model, inp, out, cache_read, cache_write,
        )
    except Exception:
        pass


@router.post("/ai-providers/proxy/anthropic/stream")
async def proxy_anthropic_stream(payload: AnthropicProxyRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if not _speaks_anthropic(provider):
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider does not use the Anthropic API"})

    # Body construction is identical to proxy_anthropic — keeping it byte-for-byte
    # matched preserves the prompt-cache breakpoints in the messages/system blocks.
    messages = list(payload.messages)
    if payload.prefill:
        messages.append({"role": "assistant", "content": payload.prefill})

    body: Dict[str, Any] = {
        "model": payload.model,
        "max_tokens": payload.max_tokens,
        "messages": messages,
    }
    if payload.system:
        body["system"] = payload.system
    if payload.tools:
        body["tools"] = payload.tools
    # Per-model extra params (temperature, top_p, provider-specific knobs) stored on the
    # provider and merged in. Structural keys are stripped, so this can't override
    # model/messages/system/tools. Kept byte-for-byte identical in both Anthropic
    # builders to preserve the prompt-cache breakpoints.
    body.update(parse_extra_params(provider.extra_params))

    headers = _anthropic_headers(provider, uses_web_search=_requests_web_search(payload.tools))
    url = f"{_anthropic_base(provider)}/v1/messages"
    model = payload.model
    provider_type = provider.provider_type  # captured before the request session closes

    async def gen():
        try:
            async for kind, val in _iter_anthropic_events(
                url,
                headers=headers,
                json_body=body,
                read_timeout=120.0,
            ):
                if kind == "delta":
                    yield _sse("delta", {"text": val})
                else:
                    _record_anthropic_usage(user_id, provider_type, model, val)
                    yield _sse("final", val)
        except Exception as e:  # surfaced to the client as an error frame
            if not isinstance(e, HTTPException):
                logger.exception("anthropic stream failed")
            yield _error_frame(e)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_STREAM_HEADERS)


@router.post("/ai-providers/proxy/openai/stream")
async def proxy_openai_stream(payload: OpenAIProxyRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type not in ("openai", "deepseek", "custom"):
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not OpenAI-compatible"})

    base = _openai_compat_base(provider.provider_type, provider.base_url)
    body: Dict[str, Any] = {
        "model": payload.model,
        "max_tokens": payload.max_tokens,
        "messages": payload.messages,
    }
    # Per-model extra params (temperature, top_p, provider-specific knobs) stored on the provider.
    body.update(parse_extra_params(provider.extra_params))
    headers = {
        "Authorization": f"Bearer {decrypt_api_key(provider.api_key)}",
        "content-type": "application/json",
    }
    url = f"{base}/v1/chat/completions"
    model = payload.model
    provider_type = provider.provider_type  # capture before the request session closes

    async def gen():
        try:
            final: Dict[str, Any] = {}
            async for kind, val in _iter_openai_events(
                url, headers=headers, json_body=body, read_timeout=120.0
            ):
                if kind == "delta":
                    yield _sse("delta", {"text": val})
                else:
                    final = val
            try:
                u = final.get("usage") or {}
                inp = int(u.get("prompt_tokens", 0) or 0)
                out = int(u.get("completion_tokens", 0) or 0)
                if not (inp or out):
                    inp = int(u.get("total_tokens", 0) or 0)
                with Session(engine) as s:
                    _record_ai_usage(s, user_id, provider_type, model, inp, out)
            except Exception:
                pass
            yield _sse("final", final)
        except httpx.TimeoutException as e:
            logger.exception("Timed out streaming from the OpenAI-compatible API")
            yield _error_frame(HTTPException(status_code=504, detail={"code": "upstream_timeout", "message": f"Timed out after 120s ({type(e).__name__})."}))
        except httpx.RequestError as e:
            logger.exception("Failed to reach the OpenAI-compatible API")
            yield _error_frame(HTTPException(status_code=502, detail={"code": "upstream_unreachable", "message": f"Could not reach the OpenAI-compatible API: {type(e).__name__}: {e}"}))
        except Exception as e:
            if not isinstance(e, HTTPException):
                logger.exception("openai stream failed")
            yield _error_frame(e)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_STREAM_HEADERS)


@router.post("/ai-providers/proxy/ollama/stream")
async def proxy_ollama_stream(payload: OllamaProxyRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type != "ollama":
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not Ollama type"})

    base = (provider.base_url or "http://localhost:11434").rstrip("/")
    body: Dict[str, Any] = {
        "model": payload.model,
        "messages": payload.messages,
    }
    options: Dict[str, Any] = dict(parse_extra_params(provider.extra_params))
    if payload.max_tokens is not None:
        options["num_predict"] = payload.max_tokens
    if options:
        body["options"] = options
    url = f"{base}/api/chat"
    model = payload.model

    async def gen():
        try:
            final: Dict[str, Any] = {}
            async for kind, val in _iter_ollama_events(url, json_body=body, read_timeout=120.0):
                if kind == "delta":
                    yield _sse("delta", {"text": val})
                else:
                    final = val
            try:
                with Session(engine) as s:
                    _record_ai_usage(
                        s, user_id, "ollama", model,
                        int(final.get("prompt_eval_count", 0) or 0),
                        int(final.get("eval_count", 0) or 0),
                    )
            except Exception:
                pass
            yield _sse("final", final)
        except httpx.TimeoutException as e:
            logger.exception("Timed out streaming from Ollama")
            yield _error_frame(HTTPException(status_code=504, detail={"code": "upstream_timeout", "message": f"Timed out after 120s ({type(e).__name__})."}))
        except httpx.RequestError as e:
            logger.exception("Failed to reach Ollama")
            yield _error_frame(HTTPException(status_code=502, detail={"code": "upstream_unreachable", "message": f"Could not reach Ollama: {type(e).__name__}: {e}"}))
        except Exception as e:
            if not isinstance(e, HTTPException):
                logger.exception("ollama stream failed")
            yield _error_frame(e)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_STREAM_HEADERS)


# ─── Model Catalog (admin-managed, shared across all users) ─────────────────
#
# Curated image/TTS/STT model lists shown in the relevant dropdowns. Global,
# not per-user — distinct from each user's own custom_models/custom_tts_models,
# which stay in UserSetting untouched. Seeded on first boot (see seed.py); an
# admin can add/edit/deactivate/remove entries via /model-catalog without a
# redeploy.

def _load_catalog(session: Session, kind: str) -> List[ModelCatalogEntry]:
    """Active catalog entries for a kind, in display order. Small dataset
    (well under 100 rows total across all kinds) — queried per-request."""
    return session.exec(
        select(ModelCatalogEntry)
        .where(ModelCatalogEntry.kind == kind, ModelCatalogEntry.is_active == True)
        .order_by(ModelCatalogEntry.sort_order)
    ).all()


def _catalog_entry_to_read(entry: ModelCatalogEntry) -> ModelCatalogEntryRead:
    return ModelCatalogEntryRead(
        id=entry.id, kind=entry.kind, model_id=entry.model_id, label=entry.label,
        maker_note=entry.maker_note, sort_order=entry.sort_order, is_active=entry.is_active,
        voices=json.loads(entry.voices) if entry.voices else None,
        text_field=entry.text_field, voice_field=entry.voice_field,
        extra_params=json.loads(entry.extra_params) if entry.extra_params else None,
        created_at=entry.created_at,
    )


@router.get("/model-catalog", response_model=ListResponse[ModelCatalogEntryRead])
def list_model_catalog(request: Request, kind: Optional[str] = None, session: Session = Depends(get_session)):
    """Admin-only: full catalog (including inactive rows) for the editor UI."""
    if not _is_admin(request, session):
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Admin access required"})
    stmt = select(ModelCatalogEntry)
    if kind:
        stmt = stmt.where(ModelCatalogEntry.kind == kind)
    entries = session.exec(stmt.order_by(ModelCatalogEntry.kind, ModelCatalogEntry.sort_order)).all()
    return ListResponse(
        data=[_catalog_entry_to_read(e) for e in entries],
        total=len(entries), limit=len(entries), offset=0,
    )


@router.post("/model-catalog", response_model=DataResponse[ModelCatalogEntryRead], status_code=201)
def create_model_catalog_entry(payload: ModelCatalogEntryCreate, request: Request, session: Session = Depends(get_session)):
    if not _is_admin(request, session):
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Admin access required"})
    dup = session.exec(
        select(ModelCatalogEntry).where(
            ModelCatalogEntry.kind == payload.kind, ModelCatalogEntry.model_id == payload.model_id
        )
    ).first()
    if dup:
        raise HTTPException(status_code=400, detail={"code": "duplicate_model", "message": "This model id is already in the catalog for this kind"})
    entry = ModelCatalogEntry(
        id=str(uuid.uuid4()), kind=payload.kind, model_id=payload.model_id, label=payload.label,
        maker_note=payload.maker_note, sort_order=payload.sort_order, is_active=payload.is_active,
        voices=json.dumps(payload.voices) if payload.voices else None,
        text_field=payload.text_field, voice_field=payload.voice_field,
        extra_params=json.dumps(payload.extra_params) if payload.extra_params else None,
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return DataResponse(data=_catalog_entry_to_read(entry))


@router.put("/model-catalog/{entry_id}", response_model=DataResponse[ModelCatalogEntryRead])
def update_model_catalog_entry(entry_id: str, payload: ModelCatalogEntryUpdate, request: Request, session: Session = Depends(get_session)):
    if not _is_admin(request, session):
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Admin access required"})
    entry = session.get(ModelCatalogEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Catalog entry not found"})
    for field in ("label", "maker_note", "sort_order", "is_active", "text_field", "voice_field"):
        val = getattr(payload, field, None)
        if val is not None:
            setattr(entry, field, val)
    if payload.voices is not None:
        entry.voices = json.dumps(payload.voices)
    if payload.extra_params is not None:
        entry.extra_params = json.dumps(payload.extra_params)
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return DataResponse(data=_catalog_entry_to_read(entry))


@router.delete("/model-catalog/{entry_id}", status_code=204)
def delete_model_catalog_entry(entry_id: str, request: Request, session: Session = Depends(get_session)):
    if not _is_admin(request, session):
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Admin access required"})
    entry = session.get(ModelCatalogEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Catalog entry not found"})
    session.delete(entry)
    session.commit()


# ─── Speech (fal.ai) ──────────────────────────────────────────────────────────
#
# Speech runs on fal.ai and shares the single fal API key configured for image
# generation (`load_fal_api_key`) — one fal account/key powers image + TTS + STT.
#   • TTS (read-aloud)  → fal.run/<TTS model>, returns an ephemeral audio URL we
#     download and stream back as audio/mpeg (same pattern as image generation).
#   • STT (dictation + video transcription) → fal.run/fal-ai/wizper. fal's model
#     endpoints reject data: URIs for file inputs like `audio_url` (they need a
#     real, fetchable URL), so we use the official `fal_client` SDK to upload the
#     audio to fal's storage first and pass back the resulting URL — this also
#     insulates us from fal's undocumented raw upload-endpoint details changing.
# The model ids below are sensible defaults; edit these constants to switch models.

DEFAULT_TTS_MODEL = "fal-ai/elevenlabs/tts/eleven-v3"
DEFAULT_STT_MODEL = "fal-ai/wizper"
DEFAULT_TTS_VOICE = "Aria"

# Deepgram realtime streaming STT — an alternative to the fal.ai/browser paths above,
# selectable per-user via `stt_provider`. Uses its own API key (Deepgram is unrelated
# to fal.ai/image gen) and a small hardcoded model list rather than the fal-only
# ModelCatalogEntry catalog, since Deepgram model ids aren't fal.run endpoint paths.
DEFAULT_DEEPGRAM_MODEL = "nova-3"
DEEPGRAM_STT_MODELS = [
    {"id": "nova-3", "label": "Nova 3 (recommended)"},
    {"id": "nova-2", "label": "Nova 2"},
]
_STT_PROVIDERS = {"auto", "deepgram", "fal"}

# Deepgram streaming TTS (Flux) — an alternative read-aloud provider to fal.ai,
# selectable per-user via `tts_provider`. Shares the same encrypted Deepgram key
# as realtime STT. Voice ids are Flux model ids (not fal.run endpoint paths), so
# — like DEEPGRAM_STT_MODELS — they're hardcoded rather than in the fal catalog.
# Flux (not Aura-2) is used because it's the only Deepgram TTS family that
# supports the `expressivity` register control (see DEEPGRAM_TTS_EXPRESSIVITY_*
# below and `_deepgram_tts()`); Aura-2's `/v1/speak` doesn't offer it.
DEFAULT_DEEPGRAM_TTS_MODEL = "flux-haley-en"
DEEPGRAM_TTS_MODELS = [
    # Featured — the strongest all-rounders in the catalog.
    {"id": "flux-hannah-en", "label": "Hannah — female, US (Flux)"},
    {"id": "flux-kit-en", "label": "Kit — male, British (Flux)"},
    {"id": "flux-alexis-en", "label": "Alexis — female, US (Flux)"},
    {"id": "flux-cliff-en", "label": "Cliff — male, US (Flux)"},
    {"id": "flux-sienna-en", "label": "Sienna — female, US (Flux)"},
    {"id": "flux-cole-en", "label": "Cole — male, US (Flux)"},
    {"id": "flux-brooke-en", "label": "Brooke — female, US (Flux)"},
    {"id": "flux-colin-en", "label": "Colin — male, British (Flux)"},
    {"id": "flux-gemma-en", "label": "Gemma — female, British (Flux)"},
    {"id": "flux-haley-en", "label": "Haley — female, US (Flux)"},
    {"id": "flux-heather-en", "label": "Heather — female, US (Flux)"},
    {"id": "flux-miles-en", "label": "Miles — male, US (Flux)"},
    {"id": "flux-sean-en", "label": "Sean — male, British (Flux)"},

    # More voices — additional accents, ages, and characters.
    {"id": "flux-bree-en", "label": "Bree — female, US (Flux)"},
    {"id": "flux-brittany-en", "label": "Brittany — female, US (Flux)"},
    {"id": "flux-bruce-en", "label": "Bruce — male, US (Flux)"},
    {"id": "flux-conor-en", "label": "Conor — male, British (Flux)"},
    {"id": "flux-donovan-en", "label": "Donovan — male, US (Flux)"},
    {"id": "flux-drew-en", "label": "Drew — male, US (Flux)"},
    {"id": "flux-elise-en", "label": "Elise — female, US (Flux)"},
    {"id": "flux-jack-en", "label": "Jack — male, British (Flux)"},
    {"id": "flux-kai-en", "label": "Kai — male, Singaporean (Flux)"},
    {"id": "flux-kelsey-en", "label": "Kelsey — female, US (Flux)"},
    {"id": "flux-maeve-en", "label": "Maeve — female, Irish (Flux)"},
    {"id": "flux-marcelo-en", "label": "Marcelo — male, Filipino (Flux)"},
    {"id": "flux-marcus-en", "label": "Marcus — male, US (Flux)"},
    {"id": "flux-meena-en", "label": "Meena — female, Indian (Flux)"},
    {"id": "flux-meghan-en", "label": "Meghan — female, US (Flux)"},
    {"id": "flux-naveen-en", "label": "Naveen — male, Indian (Flux)"},
    {"id": "flux-paige-en", "label": "Paige — female, US (Flux)"},
    {"id": "flux-priya-en", "label": "Priya — female, Indian (Flux)"},
    {"id": "flux-rufus-en", "label": "Rufus — male, British (Flux)"},
    {"id": "flux-sharon-en", "label": "Sharon — female, Australian (Flux)"},
    {"id": "flux-tanner-en", "label": "Tanner — male, British (Flux)"},
    {"id": "flux-wade-en", "label": "Wade — male, US (Flux)"},
    {"id": "flux-wes-en", "label": "Wes — male, US (Flux)"},
]
_DEEPGRAM_TTS_VOICE_IDS = {m["id"] for m in DEEPGRAM_TTS_MODELS}

# `expressivity`: a signed register offset from a Flux voice's tuned default —
# calm (-2) to animated (2). Deepgram rejects out-of-range/fractional values
# rather than clamping them, so we mirror that instead of silently coercing.
DEFAULT_DEEPGRAM_TTS_EXPRESSIVITY = 0
DEEPGRAM_TTS_EXPRESSIVITY_MIN = -2
DEEPGRAM_TTS_EXPRESSIVITY_MAX = 2

# `speed`: a Flux-only playback-rate multiplier, same non-clamping validation
# approach as expressivity above.
DEFAULT_DEEPGRAM_TTS_SPEED = 1.0
DEEPGRAM_TTS_SPEED_MIN = 0.85
DEEPGRAM_TTS_SPEED_MAX = 1.15
_TTS_PROVIDERS = {"auto", "deepgram", "fal"}

# Curated ElevenLabs voices offered in the read-aloud picker. Values are passed
# straight to fal's `voice` field — edit this list to expose different voices.
FAL_TTS_VOICES = [
    "Aria", "Roger", "Sarah", "Laura", "Charlie", "George", "Callum", "River",
    "Liam", "Charlotte", "Alice", "Matilda", "Will", "Jessica", "Eric", "Chris",
    "Brian", "Daniel", "Lily", "Bill",
]

# Curated TTS/STT model lists now live in ModelCatalogEntry (admin-editable via
# /model-catalog, seeded in seed.py) — see _load_catalog() above.

_SPEECH_CONFIG = "speech_gen_config"  # JSON: {tts_model, custom_tts_models, stt_model, stt_provider, deepgram_model, tts_provider, deepgram_tts_model, deepgram_tts_expressivity, deepgram_tts_speed, voice_mode_enabled}
_DEEPGRAM_KEY = "deepgram_api_key"     # encrypted; separate from fal's key

_TTS_MAX_CHARS = 2000
# Cap the downloaded audio so a hostile/broken upstream can't exhaust memory.
_MAX_AUDIO_BYTES = 25 * 1024 * 1024

# Floor on a response we are willing to call audio. An MP3 of a single spoken
# word runs to several KB, so anything under this is an empty body or a short
# error payload returned with a 2xx — which, passed on as audio, reaches ffmpeg
# as an undecodable file and fails a whole video render with a message about
# pixel formats. Catching it here keeps the error legible and, because both
# provider helpers check before returning, keeps it out of the disk cache.
_MIN_AUDIO_BYTES = 256


def load_speech_config(session: Session, user_id: str) -> Dict[str, Any]:
    """Per-user speech config with defaults. Returns tts_model and custom_tts_models."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _SPEECH_CONFIG)
    ).first()
    cfg: Dict[str, Any] = {}
    if row and row.value:
        try:
            cfg = json.loads(row.value) or {}
        except (ValueError, TypeError):
            cfg = {}
    custom = [m for m in (cfg.get("custom_tts_models") or []) if isinstance(m, dict) and m.get("id")]
    stt_provider = cfg.get("stt_provider") or "auto"
    if stt_provider not in _STT_PROVIDERS:
        stt_provider = "auto"
    tts_provider = cfg.get("tts_provider") or "auto"
    if tts_provider not in _TTS_PROVIDERS:
        tts_provider = "auto"
    # A voice persisted before the Aura-2 -> Flux TTS migration (or any other
    # unrecognised id) would otherwise be sent straight to Deepgram and fail.
    deepgram_tts_model = cfg.get("deepgram_tts_model") or DEFAULT_DEEPGRAM_TTS_MODEL
    if deepgram_tts_model not in _DEEPGRAM_TTS_VOICE_IDS:
        deepgram_tts_model = DEFAULT_DEEPGRAM_TTS_MODEL
    expressivity = cfg.get("deepgram_tts_expressivity", DEFAULT_DEEPGRAM_TTS_EXPRESSIVITY)
    if not isinstance(expressivity, int) or isinstance(expressivity, bool) or not (
        DEEPGRAM_TTS_EXPRESSIVITY_MIN <= expressivity <= DEEPGRAM_TTS_EXPRESSIVITY_MAX
    ):
        expressivity = DEFAULT_DEEPGRAM_TTS_EXPRESSIVITY
    speed = cfg.get("deepgram_tts_speed", DEFAULT_DEEPGRAM_TTS_SPEED)
    if not isinstance(speed, (int, float)) or isinstance(speed, bool) or not (
        DEEPGRAM_TTS_SPEED_MIN <= speed <= DEEPGRAM_TTS_SPEED_MAX
    ):
        speed = DEFAULT_DEEPGRAM_TTS_SPEED
    return {
        "tts_model": cfg.get("tts_model") or DEFAULT_TTS_MODEL,
        "custom_tts_models": custom,
        "stt_model": cfg.get("stt_model") or DEFAULT_STT_MODEL,
        "stt_provider": stt_provider,
        "deepgram_model": cfg.get("deepgram_model") or DEFAULT_DEEPGRAM_MODEL,
        "tts_provider": tts_provider,
        "deepgram_tts_model": deepgram_tts_model,
        "deepgram_tts_expressivity": expressivity,
        "deepgram_tts_speed": speed,
        # Per-user opt-in for Flux voice mode (only usable when the instance-wide
        # feature flag is also on and a Deepgram key is configured).
        "voice_mode_enabled": bool(cfg.get("voice_mode_enabled", False)),
    }


def get_voices_for_model(session: Session, model_id: str, custom_models: List[Dict[str, Any]]) -> List[str]:
    """Get available voices for a given TTS model."""
    # Check curated models
    for entry in _load_catalog(session, "tts"):
        if entry.model_id == model_id:
            try:
                return json.loads(entry.voices) if entry.voices else []
            except (ValueError, TypeError):
                return []
    # Check custom models
    for model in custom_models:
        if model.get("id") == model_id:
            return model.get("voices", [])
    # Fallback to default voices if model not found
    return FAL_TTS_VOICES


def build_tts_request_body(session: Session, model_id: str, text: str, voice: str) -> Dict[str, Any]:
    """Build the fal.run request body for a TTS model. Different fal.ai TTS
    endpoints use different input schemas (e.g. `text` vs `prompt`, `voice` vs
    `voice_id`, extra required fields) even though they're all curated here as
    one unified interface. Curated models declare `text_field`/`voice_field`/
    `extra_params` overrides; anything unlisted — including custom models,
    whose schema we don't know — uses the common `text`/`voice` shape."""
    entry = next((e for e in _load_catalog(session, "tts") if e.model_id == model_id), None)
    text_field = (entry.text_field if entry else None) or "text"
    voice_field = (entry.voice_field if entry else None) or "voice"
    body = {text_field: text, voice_field: voice}
    if entry and entry.extra_params:
        try:
            body.update(json.loads(entry.extra_params))
        except (ValueError, TypeError):
            pass
    return body


@router.get("/speech")
def get_speech_settings(request: Request, session: Session = Depends(get_session)):
    """Speech uses the shared fal.ai key; report models, config, and available voices."""
    user_id = _get_user_id(request)
    cfg = load_speech_config(session, user_id)
    available_voices = get_voices_for_model(session, cfg["tts_model"], cfg["custom_tts_models"])
    tts_models = [
        {"id": e.model_id, "label": e.label, "maker_note": e.maker_note,
         "voices": json.loads(e.voices) if e.voices else []}
        for e in _load_catalog(session, "tts")
    ]
    stt_models = [
        {"id": e.model_id, "label": e.label, "maker_note": e.maker_note}
        for e in _load_catalog(session, "stt")
    ]

    return {
        "has_fal_key": bool(load_fal_api_key(session, user_id)),
        "tts_models": tts_models,
        "custom_tts_models": cfg["custom_tts_models"],
        "tts_model": cfg["tts_model"],
        "voices": available_voices,
        "default_voice": DEFAULT_TTS_VOICE,
        "stt_models": stt_models,
        "stt_model": cfg["stt_model"],
        "has_deepgram_key": bool(load_deepgram_api_key(session, user_id)),
        "stt_provider": cfg["stt_provider"],
        "deepgram_model": cfg["deepgram_model"],
        "deepgram_models": DEEPGRAM_STT_MODELS,
        "tts_provider": cfg["tts_provider"],
        "deepgram_tts_model": cfg["deepgram_tts_model"],
        "deepgram_tts_models": DEEPGRAM_TTS_MODELS,
        "deepgram_tts_expressivity": cfg["deepgram_tts_expressivity"],
        "deepgram_tts_speed": cfg["deepgram_tts_speed"],
        "voice_mode_enabled": cfg["voice_mode_enabled"],
    }


async def _fal_stt_transcribe(api_key: str, model: str, audio_bytes: bytes, content_type: str, filename: str) -> httpx.Response:
    """Upload audio to fal's storage via the official fal_client SDK, then POST directly to
    fal's synchronous STT endpoint (rather than fal_client.run()) so the caller can read
    fal's billing headers (x-fal-request-id / x-fal-billable-units) off the response — same
    approach as the image-generation and TTS integrations. Raises HTTPException with the real
    upstream message if the upload step fails; HTTP-level failures from the transcription POST
    are surfaced via the returned response (`.is_success`/`.text`) for the caller to handle."""
    client = fal_client.AsyncClient(key=api_key)
    try:
        audio_url = await client.upload(audio_bytes, content_type, filename)
    except fal_client.FalClientHTTPError as e:
        raise HTTPException(status_code=502, detail={"code": "fal_error", "message": str(e)[:500]})
    except Exception as e:
        raise HTTPException(status_code=502, detail={"code": "fal_error", "message": f"fal.ai upload failed: {type(e).__name__}: {e}"[:500]})

    return await _post_upstream(
        f"https://fal.run/{model}",
        headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
        json_body={"audio_url": audio_url, "task": "transcribe"},
        timeout=120.0,
        provider_label="fal.ai",
    )


@router.post("/speech/transcribe")
async def transcribe_speech(
    request: Request,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    api_key = load_fal_api_key(session, user_id)
    if not api_key:
        raise HTTPException(status_code=400, detail={"code": "no_fal_key", "message": "fal.ai API key is not configured"})

    stt_model = load_speech_config(session, user_id)["stt_model"]
    audio_bytes = await file.read()
    content_type = file.content_type or "audio/webm"

    resp = await _fal_stt_transcribe(api_key, stt_model, audio_bytes, content_type, file.filename or "recording.webm")
    if not resp.is_success:
        raise HTTPException(status_code=502, detail={"code": "fal_error", "message": resp.text[:500]})
    try:
        body = resp.json()
    except ValueError:
        raise HTTPException(status_code=502, detail={"code": "fal_parse_error", "message": "Unexpected fal.ai response"})
    transcript = (body.get("text") or "").strip()

    cost, currency, request_id, cost_estimated = compute_fal_cost(session, user_id, stt_model, resp)

    # Record STT usage in audio seconds when Wizper returns chunk timestamps, else chars.
    try:
        seconds = None
        chunks = body.get("chunks") or []
        if chunks and isinstance(chunks[-1], dict):
            ts = chunks[-1].get("timestamp")
            if isinstance(ts, (list, tuple)) and len(ts) == 2 and ts[1] is not None:
                seconds = round(float(ts[1]))
        units, unit_type = (seconds, "seconds") if seconds else (len(transcript), "chars")
        _record_usage(
            session, user_id, "stt", stt_model, units, unit_type,
            provider="fal.ai", external_ref=request_id, cost=cost, currency=currency,
            cost_estimated=cost_estimated,
        )
    except Exception:
        pass

    return {"text": transcript}


class TTSRequest(BaseModel):
    text: str
    # The voice name; kept as `model` for backwards-compat with the frontend request shape.
    model: str = DEFAULT_TTS_VOICE


@router.get("/speech/voices")
def list_tts_voices():
    """Curated fal.ai (ElevenLabs) TTS voices available for read-aloud."""
    return {"voices": FAL_TTS_VOICES}


class SpeechConfigUpdate(BaseModel):
    tts_model: Optional[str] = None
    custom_tts_models: Optional[List[Dict[str, Any]]] = None
    stt_model: Optional[str] = None
    stt_provider: Optional[str] = None  # "auto" | "deepgram" | "fal"
    deepgram_model: Optional[str] = None
    tts_provider: Optional[str] = None  # "auto" | "deepgram" | "fal"
    deepgram_tts_model: Optional[str] = None
    # Calm (-2) to animated (2); Deepgram rejects out-of-range/fractional
    # values rather than clamping them, and so do we.
    deepgram_tts_expressivity: Optional[int] = Field(default=None, ge=DEEPGRAM_TTS_EXPRESSIVITY_MIN, le=DEEPGRAM_TTS_EXPRESSIVITY_MAX)
    # Playback-rate multiplier; same non-clamping convention as expressivity.
    deepgram_tts_speed: Optional[float] = Field(default=None, ge=DEEPGRAM_TTS_SPEED_MIN, le=DEEPGRAM_TTS_SPEED_MAX)
    voice_mode_enabled: Optional[bool] = None
    # Tri-state, same convention as ImageSettingsUpdate.api_key: omitted/None leaves
    # the stored key untouched; "" removes it; a non-empty value replaces it.
    deepgram_api_key: Optional[str] = None


@router.put("/speech/config")
def update_speech_config(
    payload: SpeechConfigUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    """Update user's speech configuration (TTS/STT model selection and custom models)."""
    user_id = _get_user_id(request)

    if payload.deepgram_api_key is not None:
        encrypted = encrypt_api_key(payload.deepgram_api_key) if payload.deepgram_api_key else ""
        _upsert_user_setting(session, user_id, _DEEPGRAM_KEY, json.dumps(encrypted))

    # Load existing config
    cfg = load_speech_config(session, user_id)

    # Update with provided values
    if payload.tts_model is not None:
        cfg["tts_model"] = payload.tts_model
    if payload.custom_tts_models is not None:
        cfg["custom_tts_models"] = payload.custom_tts_models
    if payload.stt_model is not None:
        cfg["stt_model"] = payload.stt_model
    if payload.stt_provider is not None and payload.stt_provider in _STT_PROVIDERS:
        cfg["stt_provider"] = payload.stt_provider
    if payload.deepgram_model is not None:
        cfg["deepgram_model"] = payload.deepgram_model
    if payload.tts_provider is not None and payload.tts_provider in _TTS_PROVIDERS:
        cfg["tts_provider"] = payload.tts_provider
    if payload.deepgram_tts_model is not None:
        cfg["deepgram_tts_model"] = payload.deepgram_tts_model
    if payload.deepgram_tts_expressivity is not None:
        cfg["deepgram_tts_expressivity"] = payload.deepgram_tts_expressivity
    if payload.deepgram_tts_speed is not None:
        cfg["deepgram_tts_speed"] = payload.deepgram_tts_speed
    if payload.voice_mode_enabled is not None:
        cfg["voice_mode_enabled"] = payload.voice_mode_enabled

    # Persist to database
    _upsert_user_setting(session, user_id, _SPEECH_CONFIG, json.dumps(cfg))
    session.commit()

    return {
        "tts_model": cfg["tts_model"],
        "custom_tts_models": cfg["custom_tts_models"],
        "stt_model": cfg["stt_model"],
        "stt_provider": cfg["stt_provider"],
        "deepgram_model": cfg["deepgram_model"],
        "tts_provider": cfg["tts_provider"],
        "deepgram_tts_model": cfg["deepgram_tts_model"],
        "deepgram_tts_expressivity": cfg["deepgram_tts_expressivity"],
        "deepgram_tts_speed": cfg["deepgram_tts_speed"],
        "voice_mode_enabled": cfg["voice_mode_enabled"],
        "has_deepgram_key": bool(load_deepgram_api_key(session, user_id)),
    }


# ─── Read-aloud TTS cache ─────────────────────────────────────────────────────
# Optional per-response cache: hash-named mp3 files so replaying a response (or
# re-synthesising an identical chunk) never re-bills the provider. Keyed by
# provider+voice+text and bounded by a simple oldest-first prune. Entirely
# best-effort — any filesystem error just falls through to a live synthesis.
_TTS_CACHE_DIR = Path(_MEDIA_ROOT) / "_tts_cache"
_TTS_CACHE_MAX_FILES = 2000


def _tts_cache_key(provider: str, voice: str, text: str) -> str:
    return hashlib.sha256(f"{provider}\x00{voice}\x00{text}".encode("utf-8")).hexdigest()


def _tts_cache_get(key: str) -> Optional[bytes]:
    try:
        path = _TTS_CACHE_DIR / f"{key}.mp3"
        if path.is_file():
            data = path.read_bytes()
            # Too small to be audio — an empty or error body cached before the
            # providers checked for that. Report a miss so the entry is
            # re-fetched and overwritten, rather than serving the same
            # undecodable bytes to every future render of the same note.
            if len(data) >= _MIN_AUDIO_BYTES:
                return data
    except Exception:
        pass
    return None


def _tts_cache_put(key: str, data: bytes) -> None:
    try:
        _TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (_TTS_CACHE_DIR / f"{key}.mp3").write_bytes(data)
        files = sorted(_TTS_CACHE_DIR.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
        for old in files[:-_TTS_CACHE_MAX_FILES]:
            try:
                old.unlink()
            except Exception:
                pass
    except Exception:
        pass


async def _deepgram_tts(
    api_key: str, voice_model: str, text: str,
    expressivity: int = DEFAULT_DEEPGRAM_TTS_EXPRESSIVITY,
    speed: float = DEFAULT_DEEPGRAM_TTS_SPEED,
) -> bytes:
    """Synthesise `text` via Deepgram's REST TTS (Flux) and return mp3 bytes.

    /v2/speak returns mp3 by default; we pin encoding=mp3 so the returned bytes
    are byte-for-byte compatible with the existing fal path (audio/mpeg blobs the
    frontend player already handles). `expressivity` and `speed` are Flux-only
    (Aura-2's /v1/speak doesn't support either) — a signed calm/animated
    register offset and a playback-rate multiplier, respectively. Raises
    HTTPException on any failure so the caller can decide whether to fall back
    to fal."""
    url = (
        f"https://api.deepgram.com/v2/speak?model={urllib.parse.quote(voice_model)}"
        f"&encoding=mp3&expressivity={int(expressivity)}&speed={speed:.2f}"
    )
    try:
        async with httpx.AsyncClient(timeout=120.0) as http:
            resp = await http.post(
                url,
                headers={"Authorization": f"Token {api_key}", "Content-Type": "application/json"},
                json={"text": text},
            )
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail={"code": "deepgram_error", "message": f"Deepgram request failed: {type(e).__name__}"})
    if not resp.is_success:
        raise HTTPException(status_code=502, detail={"code": "deepgram_error", "message": resp.text[:500]})
    data = resp.content
    if len(data) > _MAX_AUDIO_BYTES:
        raise HTTPException(status_code=502, detail={"code": "audio_too_large", "message": "Generated audio exceeds the size limit"})
    if len(data) < _MIN_AUDIO_BYTES:
        raise HTTPException(status_code=502, detail={
            "code": "audio_empty",
            "message": f"Deepgram returned {len(data)} bytes, which is not audio, for: {text[:80]!r}",
        })
    return data


async def _fal_tts(session: Session, user_id: str, api_key: str, text: str, voice_hint: Optional[str] = None) -> Tuple[bytes, str]:
    """Synthesise `text` via the user's selected fal.ai TTS model.

    Returns `(audio_bytes, media_type)` rather than a Response so non-HTTP
    callers — the article-to-video renderer runs in a worker thread — can reuse
    the same path as read-aloud."""
    speech_cfg = load_speech_config(session, user_id)
    tts_model = speech_cfg["tts_model"]
    available_voices = get_voices_for_model(session, tts_model, speech_cfg["custom_tts_models"])

    # Coerce unknown/legacy voices (e.g. a stale value persisted for a different
    # model) to one this model actually supports, so fal never rejects the voice.
    voice = (voice_hint or "").strip()
    if voice not in available_voices:
        voice = available_voices[0] if available_voices else DEFAULT_TTS_VOICE

    # Cache on the model as well as the voice — the same words in the same voice
    # sound different from a different model. Rendering a video re-reads whole
    # sections (a 480p preview then a 1080p final), and this is what keeps the
    # second pass from billing for the narration all over again.
    cache_key = _tts_cache_key(f"fal:{tts_model}", voice, text)
    cached = _tts_cache_get(cache_key)
    if cached is not None:
        return cached, "audio/mpeg"

    # 1) Ask fal to synthesise the audio (blocking synchronous endpoint).
    resp = await _post_upstream(
        f"https://fal.run/{tts_model}",
        headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
        json_body=build_tts_request_body(session, tts_model, text, voice),
        timeout=120.0,
        provider_label="fal.ai",
    )
    if not resp.is_success:
        raise HTTPException(status_code=502, detail={"code": "fal_error", "message": resp.text[:500]})

    try:
        body = resp.json()
        audio_url = body["audio"]["url"]
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=502, detail={"code": "fal_parse_error", "message": "Unexpected fal.ai response"})

    # 2) Download the generated audio (fal URLs are ephemeral) and stream it back.
    _require_safe_external_url(audio_url)
    try:
        async with httpx.AsyncClient(timeout=120.0) as http:
            audio_resp = await http.get(audio_url)
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail={"code": "download_failed", "message": f"Could not download audio: {type(e).__name__}"})
    if not audio_resp.is_success:
        raise HTTPException(status_code=502, detail={"code": "download_failed", "message": f"Audio download returned HTTP {audio_resp.status_code}"})
    data = audio_resp.content
    if len(data) > _MAX_AUDIO_BYTES:
        raise HTTPException(status_code=502, detail={"code": "audio_too_large", "message": "Generated audio exceeds the size limit"})
    if len(data) < _MIN_AUDIO_BYTES:
        raise HTTPException(status_code=502, detail={
            "code": "audio_empty",
            "message": f"fal.ai returned {len(data)} bytes, which is not audio, for: {text[:80]!r}",
        })

    cost, currency, request_id, cost_estimated = compute_fal_cost(session, user_id, tts_model, resp)
    _record_usage(
        session, user_id, "tts", tts_model, len(text), "chars",
        provider="fal.ai", external_ref=request_id, cost=cost, currency=currency,
        cost_estimated=cost_estimated,
    )
    media_type = (body.get("audio") or {}).get("content_type") or audio_resp.headers.get("content-type") or "audio/mpeg"
    if "mpeg" in media_type or "mp3" in media_type:
        _tts_cache_put(cache_key, data)
    return data, media_type


async def synthesize_tts_bytes(
    session: Session, user_id: str, text: str, *, voice: Optional[str] = None,
) -> Tuple[bytes, str]:
    """Synthesise one piece of text with the account's TTS settings.

    The shared core behind both read-aloud and the article-to-video renderer:
    it resolves the provider, honours the disk cache, records usage, and returns
    `(audio_bytes, media_type)`. Callers outside a request (the render worker
    runs on its own thread) drive it with `asyncio.run`.

    Raises HTTPException on failure — the HTTP endpoint surfaces that directly,
    and the worker turns it into a job error.
    """
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail={"code": "empty_text", "message": "No text to synthesize"})
    if len(text) > _TTS_MAX_CHARS:
        raise HTTPException(status_code=400, detail={"code": "text_too_long", "message": f"Text exceeds {_TTS_MAX_CHARS} characters"})

    speech_cfg = load_speech_config(session, user_id)
    tts_provider = speech_cfg["tts_provider"]
    deepgram_key = load_deepgram_api_key(session, user_id)
    fal_key = load_fal_api_key(session, user_id)

    # Resolve the effective provider. "auto" prefers Deepgram when its key is set,
    # otherwise fal.ai; explicit "deepgram"/"fal" are honoured as chosen.
    if tts_provider == "deepgram":
        use_deepgram = True
    elif tts_provider == "fal":
        use_deepgram = False
    else:  # auto
        use_deepgram = bool(deepgram_key)

    if use_deepgram and not deepgram_key:
        raise HTTPException(status_code=400, detail={"code": "no_deepgram_key", "message": "Deepgram API key is not configured"})
    if not use_deepgram and not fal_key:
        raise HTTPException(status_code=400, detail={"code": "no_fal_key", "message": "fal.ai API key is not configured"})

    # ── Deepgram (Flux) path ──────────────────────────────────────────────────
    if use_deepgram:
        dg_voice = speech_cfg["deepgram_tts_model"] or DEFAULT_DEEPGRAM_TTS_MODEL
        dg_expressivity = speech_cfg["deepgram_tts_expressivity"]
        dg_speed = speech_cfg["deepgram_tts_speed"]
        # Expressivity and speed both change the audio itself, so both are part
        # of the cache key.
        cache_key = _tts_cache_key(f"deepgram:{dg_expressivity}:{dg_speed}", dg_voice, text)
        cached = _tts_cache_get(cache_key)
        if cached is not None:
            return cached, "audio/mpeg"
        try:
            data = await _deepgram_tts(deepgram_key, dg_voice, text, dg_expressivity, dg_speed)
        except HTTPException:
            # Under "auto", degrade gracefully to fal rather than failing the
            # read-aloud outright; an explicit "deepgram" choice surfaces the error.
            if tts_provider == "auto" and fal_key:
                logger.warning("Deepgram TTS failed for user %s; falling back to fal.ai", user_id)
                return await _fal_tts(session, user_id, fal_key, text, voice_hint=voice)
            raise
        _tts_cache_put(cache_key, data)
        _record_usage(
            session, user_id, "tts", dg_voice, len(text), "chars",
            provider="deepgram", cost=None, cost_estimated=True,
        )
        return data, "audio/mpeg"

    # ── fal.ai path ───────────────────────────────────────────────────────────
    return await _fal_tts(session, user_id, fal_key, text, voice_hint=voice)


# Mirrors MAX_CHUNK_CHARS in the frontend's useTextToSpeech hook. Chunk text
# has to match that hook's byte for byte or the disk cache above misses and an
# export right after a listen pays for the same audio twice.
_EXPORT_CHUNK_CHARS = 1500

# One narrate call fans out into a TTS request per chunk, so unlike /speech/tts
# it needs a ceiling of its own. ~50k characters is a little under an hour of
# speech — far past any note anyone reads aloud in one go.
_NARRATE_MAX_CHARS = 50_000


def _pack_export_chunks(text: str) -> List[Chunk]:
    """Split text for export exactly as `packSpeechChunks` does client-side.

    Same order of operations as the hook: strip emoji, collapse runs of spaces
    and tabs (never newlines — the paragraph trigger is made of those), split on
    pause markup, then hard-split anything still over the per-request budget on
    a word boundary. Those forced splits carry no pause; only the final piece of
    a segment keeps the pause the segment actually asked for.

    This is the only split the frontend produces: `chunkTextForPlayback`'s
    ramped sizes only gate whether a segment enters the re-split branch, and
    that branch cuts at `MAX_CHUNK_CHARS` regardless, so playback and export
    chunk text identically today. `speechChunks.test.ts` asserts that, because
    if the ramp is ever made to bite, Insert Mode would stop hitting the cache
    here and start paying for the same audio twice.
    """
    cleaned = re.sub(r"[ \t]+", " ", strip_emoji(text or ""))
    packed: List[Chunk] = []
    for segment in parse_pause_markup(cleaned):
        rest = segment.text
        while len(rest) > _EXPORT_CHUNK_CHARS:
            cut = rest.rfind(" ", 0, _EXPORT_CHUNK_CHARS)
            if cut <= 0:
                cut = _EXPORT_CHUNK_CHARS
            packed.append(Chunk(rest[:cut].strip(), 0))
            rest = rest[cut:].strip()
        if rest:
            packed.append(Chunk(rest, segment.pause_after_ms))
    return packed


@router.post("/speech/narrate")
async def narrate_speech(
    payload: TTSRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Synthesise a whole passage as one MP3, with its pauses held as silence.

    `/speech/tts` synthesises one chunk; the caller is on its own for the gaps
    between them. Live playback can hold those gaps with a timer, but an
    exported or inserted file cannot — concatenating the chunks client-side
    produced audio with every pause missing, which is what this endpoint exists
    to fix. Splitting and stitching both happen here because ffmpeg is already
    installed for the video renderer and is the only thing on either side that
    can lay real silence between two clips.
    """
    user_id = _get_user_id(request)
    if len(payload.text or "") > _NARRATE_MAX_CHARS:
        raise HTTPException(status_code=400, detail={
            "code": "text_too_long",
            "message": f"Text exceeds {_NARRATE_MAX_CHARS:,} characters",
        })

    chunks = _pack_export_chunks(payload.text)
    if not chunks:
        raise HTTPException(status_code=400, detail={"code": "empty_text", "message": "No text to synthesize"})

    pieces: List[Tuple[bytes, int]] = []
    for chunk in chunks:
        data, _media_type = await synthesize_tts_bytes(session, user_id, chunk.text, voice=payload.model)
        pieces.append((data, chunk.pause_after_ms))

    # Nothing to lay silence between, or no ffmpeg to lay it with: hand back the
    # plain concatenation rather than failing an export over a missing pause.
    if len(pieces) > 1 and ffmpeg_available():
        try:
            joined = await run_in_threadpool(stitch_chunks_to_mp3, pieces)
            if joined:
                return Response(content=joined, media_type="audio/mpeg")
        except FFmpegError:
            logger.warning("narrate: ffmpeg join failed, returning gapless audio", exc_info=True)

    return Response(content=b"".join(audio for audio, _ in pieces), media_type="audio/mpeg")


@router.post("/speech/tts")
async def synthesize_speech(
    payload: TTSRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    data, media_type = await synthesize_tts_bytes(session, user_id, payload.text, voice=payload.model)
    return Response(content=data, media_type=media_type)


@router.get("/usage")
def get_usage(request: Request, days: int = 30, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    days = max(1, min(days, 365))
    since = datetime.utcnow() - timedelta(days=days)

    events = session.exec(
        select(UsageEvent).where(
            UsageEvent.user_id == user_id,
            UsageEvent.created_at >= since,
        )
    ).all()

    totals: Dict[str, Dict[str, Any]] = {}
    providers: Dict[str, Dict[str, Any]] = {}
    by_day: Dict[tuple, Dict[str, float]] = {}
    for ev in events:
        # Aggregate by kind (tts / stt / ai / image) — powers the summary cards.
        t = totals.setdefault(ev.kind, {"kind": ev.kind, "count": 0, "units": 0, "unit_type": ev.unit_type, "cost": 0.0})
        t["count"] += 1
        t["units"] += ev.units
        if ev.cost is not None:
            t["cost"] += ev.cost
            if ev.currency and not t.get("currency"):
                t["currency"] = ev.currency
        if not t["unit_type"]:
            t["unit_type"] = ev.unit_type

        # Aggregate by provider — powers the cost breakdown. Legacy rows have no
        # provider column; fall back to the kind so they still bucket sensibly.
        pkey = ev.provider or ev.kind
        p = providers.setdefault(pkey, {"provider": pkey, "count": 0, "units": 0, "cost": 0.0, "estimated": False})
        p["count"] += 1
        p["units"] += ev.units
        if ev.cost is not None:
            p["cost"] += ev.cost
            if ev.currency and not p.get("currency"):
                p["currency"] = ev.currency
        if ev.cost_estimated:
            p["estimated"] = True

        # Daily time series (requests + units + cost) — powers the trend chart.
        day = ev.created_at.date().isoformat()
        d = by_day.setdefault((day, ev.kind), {"count": 0, "units": 0, "cost": 0.0})
        d["count"] += 1
        d["units"] += ev.units
        if ev.cost is not None:
            d["cost"] += ev.cost

    # Round accumulated costs so floating-point noise doesn't leak into the UI.
    for t in totals.values():
        t["cost"] = round(t["cost"], 4)
    for p in providers.values():
        p["cost"] = round(p["cost"], 4)

    recent = sorted(events, key=lambda e: e.created_at, reverse=True)[:50]

    return {
        "days": days,
        "totals_by_kind": list(totals.values()),
        "by_provider": sorted(providers.values(), key=lambda x: x["cost"], reverse=True),
        "by_day": [
            {"date": day, "kind": kind, "count": v["count"], "units": v["units"], "cost": round(v["cost"], 6)}
            for (day, kind), v in sorted(by_day.items())
        ],
        "recent": [
            {
                "kind": e.kind,
                "provider": e.provider,
                "model": e.model,
                "units": e.units,
                "unit_type": e.unit_type,
                "cost": e.cost,
                "currency": e.currency,
                "cost_estimated": e.cost_estimated,
                "created_at": e.created_at.replace(tzinfo=None).isoformat() + "Z",
            }
            for e in recent
        ],
    }


# ─── Image Generation / fal.ai ────────────────────────────────────────────────

_FAL_KEY = "fal_api_key"              # encrypted; image generation key (fal.run)
_FAL_ADMIN_KEY = "fal_admin_api_key"  # encrypted; billing/usage/pricing (api.fal.ai/v1) scope
_FAL_CONFIG = "image_gen_config"      # plain JSON: default_model / custom_models / image_size
_FAL_PRICE_CACHE = "fal_price_cache"  # plain JSON: {fetched_at, prices: {endpoint_id: {...}}}

_FAL_USAGE_URL = "https://api.fal.ai/v1/models/usage"
_FAL_BILLING_URL = "https://api.fal.ai/v1/account/billing"
_FAL_PRICE_TTL_SECONDS = 6 * 3600

DEFAULT_FAL_MODEL = "fal-ai/flux/dev"
DEFAULT_IMAGE_SIZE = "landscape_4_3"

# Curated fal.ai text-to-image endpoints now live in ModelCatalogEntry (admin-editable
# via /model-catalog, seeded in seed.py) — see _load_catalog() above. Users may still
# add their own model ids on top of these (stored in the per-user image_gen_config).

# fal image_size presets (the models also accept a {width,height} object, but the app
# only exposes the named presets to keep the UI simple).
FAL_IMAGE_SIZES = [
    "square_hd", "square",
    "portrait_4_3", "portrait_16_9",
    "landscape_4_3", "landscape_16_9",
]

# Most fal text-to-image endpoints accept the named presets above verbatim —
# FLUX.1/.2, Recraft V3, SD 3.5, Fast SDXL, Qwen Image, Seedream, Ideogram V3,
# Z-Image, and GPT Image 2 (whose schema is the standard preset union plus
# "auto"). The exceptions below speak a different size dialect and 422 on the
# presets, so their requests need translating.

# GPT Image 1.x endpoints proxy OpenAI's own `image_size` enum — only
# "1024x1024", "1536x1024" or "1024x1536". Matched by prefix so 1.5 / 1-mini /
# subpath variants added as custom models get the same treatment.
_OPENAI_IMAGE_SIZE_PREFIXES = ("fal-ai/gpt-image-1",)
_OPENAI_IMAGE_SIZE_MAP = {
    "square_hd": "1024x1024",
    "square": "1024x1024",
    "landscape_4_3": "1536x1024",
    "landscape_16_9": "1536x1024",
    "portrait_4_3": "1024x1536",
    "portrait_16_9": "1024x1536",
}

# These endpoints have no `image_size` at all — they take an `aspect_ratio`
# string instead (FLUX1.1 [pro] ultra, FLUX Kontext text-to-image, Google's
# nano-banana / Gemini image models, Krea 2).
_ASPECT_RATIO_MODEL_PREFIXES = (
    "fal-ai/flux-pro/v1.1-ultra",
    "fal-ai/flux-pro/kontext",
)
_ASPECT_RATIO_MAP = {
    "square_hd": "1:1",
    "square": "1:1",
    "landscape_4_3": "4:3",
    "landscape_16_9": "16:9",
    "portrait_4_3": "3:4",
    "portrait_16_9": "9:16",
}
# Krea 2 doesn't offer 3:4 — 4:5 is the nearest portrait step in its enum.
_KREA_ASPECT_RATIO_MAP = {**_ASPECT_RATIO_MAP, "portrait_4_3": "4:5"}

# Curated ids that were seeded pointing at the wrong fal endpoint. The catalog
# rows are rewritten by a startup migration; this map additionally repairs the
# per-user config blobs (default_model / custom_models) that still reference
# the old ids.
FAL_MODEL_ID_RENAMES = {
    # Image-editing endpoint (requires image_url) — text-to-image is a subpath.
    "fal-ai/flux-pro/kontext": "fal-ai/flux-pro/kontext/text-to-image",
    # Not a valid endpoint id; Krea 2 Large lives under krea/v2.
    "fal-ai/krea-2": "fal-ai/krea/v2/large/text-to-image",
}


def resolve_fal_size_params(model: str, image_size: str) -> Dict[str, str]:
    """Request-body params expressing the named `image_size` preset in whatever
    size dialect the target fal endpoint speaks (fal presets, OpenAI WxH sizes,
    or an `aspect_ratio` string). Reused by the images router."""
    if model.startswith(_OPENAI_IMAGE_SIZE_PREFIXES):
        return {"image_size": _OPENAI_IMAGE_SIZE_MAP.get(image_size, "1024x1024")}
    if "krea" in model:
        return {"aspect_ratio": _KREA_ASPECT_RATIO_MAP.get(image_size, "1:1")}
    if model.startswith(_ASPECT_RATIO_MODEL_PREFIXES) or "nano-banana" in model:
        return {"aspect_ratio": _ASPECT_RATIO_MAP.get(image_size, "1:1")}
    return {"image_size": image_size}


def _upsert_user_setting(session: Session, user_id: str, key: str, serialised_value: str) -> None:
    """Insert or update a single per-user setting row. Caller commits."""
    existing = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == key)
    ).first()
    if existing:
        existing.value = serialised_value
        session.add(existing)
    else:
        session.add(UserSetting(user_id=user_id, key=key, value=serialised_value))


def load_fal_api_key(session: Session, user_id: str) -> Optional[str]:
    """Decrypted fal.ai API key for a user, or None when unset. Reused by the images router."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _FAL_KEY)
    ).first()
    if not row or not row.value:
        return None
    try:
        stored = json.loads(row.value)
    except (ValueError, TypeError):
        return None
    if not stored:
        return None
    try:
        return decrypt_api_key(stored)
    except Exception:
        return None


def load_deepgram_api_key(session: Session, user_id: str) -> Optional[str]:
    """Decrypted Deepgram API key for a user, or None when unset. Mirrors load_fal_api_key."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _DEEPGRAM_KEY)
    ).first()
    if not row or not row.value:
        return None
    try:
        stored = json.loads(row.value)
    except (ValueError, TypeError):
        return None
    if not stored:
        return None
    try:
        return decrypt_api_key(stored)
    except Exception:
        return None


def load_fal_admin_key(session: Session, user_id: str) -> Optional[str]:
    """Decrypted fal.ai admin/platform key (billing scope), or None when unset."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _FAL_ADMIN_KEY)
    ).first()
    if not row or not row.value:
        return None
    try:
        stored = json.loads(row.value)
    except (ValueError, TypeError):
        return None
    if not stored:
        return None
    try:
        return decrypt_api_key(stored)
    except Exception:
        return None


def load_fal_billing_key(session: Session, user_id: str) -> Optional[str]:
    """Key used for fal's platform (billing/usage) APIs: the admin key if set, else the
    generation key as a fallback (which may lack billing scope and get rejected)."""
    return load_fal_admin_key(session, user_id) or load_fal_api_key(session, user_id)


def _read_fal_price_cache(session: Session, user_id: str) -> Dict[str, Any]:
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _FAL_PRICE_CACHE)
    ).first()
    if row and row.value:
        try:
            return json.loads(row.value) or {}
        except (ValueError, TypeError):
            return {}
    return {}


def _prices_from_summary(summary_items: Any) -> Dict[str, Dict[str, Any]]:
    """Build {endpoint_id: {unit, unit_price, currency}} from a fal usage `summary` array."""
    prices: Dict[str, Dict[str, Any]] = {}
    for it in summary_items or []:
        if not isinstance(it, dict):
            continue
        eid = it.get("endpoint_id")
        unit_price = it.get("unit_price")
        if eid and isinstance(unit_price, (int, float)):
            prices[eid] = {
                "unit": it.get("unit"),
                "unit_price": unit_price,
                "currency": it.get("currency") or "USD",
            }
    return prices


def get_cached_fal_price(session: Session, user_id: str, model: str) -> Optional[Dict[str, Any]]:
    """Cached {unit, unit_price, currency} for a model endpoint, or None if not cached yet."""
    prices = _read_fal_price_cache(session, user_id).get("prices") or {}
    return prices.get(model)


def compute_fal_cost(
    session: Session, user_id: str, model: str, resp: httpx.Response
) -> Tuple[Optional[float], Optional[str], Optional[str], Optional[bool]]:
    """Exact-cost attribution for a fal.ai synchronous-endpoint response.

    Primary path: multiplies fal's reported billed quantity (`x-fal-billable-units`) by
    the endpoint's cached per-unit price. This is fal's explicitly-named billing field,
    so cost_estimated=False.

    Fallback path: endpoints billed by "compute seconds" (confirmed live against
    fal-ai/wizper) don't send `x-fal-billable-units` on a successful response — only
    `x-fal-raw-time` (job wall-clock seconds). When the cached price's `unit` mentions
    "compute second", that's used as the billable quantity instead. This is inferred
    (not fal's named billing field), so cost_estimated=True.

    Returns (cost, currency, request_id, cost_estimated); all None when nothing can be
    computed — price not cached yet, or fal sent neither header (never raises)."""
    request_id = resp.headers.get("x-fal-request-id")
    billable_raw = resp.headers.get("x-fal-billable-units")
    cost: Optional[float] = None
    currency: Optional[str] = None
    cost_estimated: Optional[bool] = None
    price = get_cached_fal_price(session, user_id, model)
    if price:
        quantity_raw: Optional[str] = None
        if billable_raw is not None:
            quantity_raw = billable_raw
            cost_estimated = False
        elif "compute second" in (price.get("unit") or "").lower():
            quantity_raw = resp.headers.get("x-fal-raw-time")
            if quantity_raw is not None:
                cost_estimated = True
        if quantity_raw is not None:
            try:
                cost = round(float(quantity_raw) * float(price["unit_price"]), 6)
                currency = price.get("currency")
            except (ValueError, TypeError, KeyError):
                cost = None
                cost_estimated = None
    return cost, currency, request_id, cost_estimated


async def _fetch_fal_usage_summary(billing_key: str, days: int) -> Optional[Dict[str, Any]]:
    """Call fal's usage API (expand=summary) and return the parsed body, or None on any
    failure. fal caps the window at ~90 days."""
    days = max(1, min(days, 90))
    end = datetime.utcnow().date()
    start = end - timedelta(days=days)
    try:
        async with httpx.AsyncClient(timeout=20.0) as http:
            resp = await http.get(
                _FAL_USAGE_URL,
                headers={"Authorization": f"Key {billing_key}"},
                params={"start_time": start.isoformat(), "end_time": end.isoformat(), "expand": "summary"},
            )
    except httpx.RequestError:
        return None
    if not resp.is_success:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _refresh_fal_prices(session: Session, user_id: str, summary_items: Any) -> Dict[str, Dict[str, Any]]:
    """Persist a fresh price map derived from a usage summary. Returns the price map."""
    prices = _prices_from_summary(summary_items)
    if prices:
        _upsert_user_setting(session, user_id, _FAL_PRICE_CACHE, json.dumps({
            "fetched_at": datetime.utcnow().isoformat(),
            "prices": prices,
        }))
        session.commit()
    return prices


def load_fal_config(session: Session, user_id: str) -> Dict[str, Any]:
    """Per-user image-generation config, with defaults filled in. Reused by the images router."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _FAL_CONFIG)
    ).first()
    cfg: Dict[str, Any] = {}
    if row and row.value:
        try:
            cfg = json.loads(row.value) or {}
        except (ValueError, TypeError):
            cfg = {}
    custom = [str(m).strip() for m in (cfg.get("custom_models") or []) if str(m).strip()]
    custom = [FAL_MODEL_ID_RENAMES.get(m, m) for m in custom]
    default_model = cfg.get("default_model") or DEFAULT_FAL_MODEL
    return {
        "default_model": FAL_MODEL_ID_RENAMES.get(default_model, default_model),
        "custom_models": custom,
        "image_size": cfg.get("image_size") or DEFAULT_IMAGE_SIZE,
    }


def allowed_fal_models(session: Session, config: Dict[str, Any]) -> set:
    """The set of model ids a user is allowed to generate with (curated + their custom ids)."""
    curated_ids = {e.model_id for e in _load_catalog(session, "image")}
    return curated_ids | set(config.get("custom_models") or [])


@router.get("/images")
def get_image_settings(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    api_key = load_fal_api_key(session, user_id)
    admin_key = load_fal_admin_key(session, user_id)
    cfg = load_fal_config(session, user_id)
    curated_models = [
        {"id": e.model_id, "label": e.label, "maker_note": e.maker_note}
        for e in _load_catalog(session, "image")
    ]
    return {
        "has_api_key": bool(api_key),
        "has_admin_key": bool(admin_key),
        "curated_models": curated_models,
        "image_sizes": FAL_IMAGE_SIZES,
        "custom_models": cfg["custom_models"],
        "default_model": cfg["default_model"],
        "image_size": cfg["image_size"],
    }


class ImageSettingsUpdate(BaseModel):
    # `api_key` / `admin_api_key` are tri-state: omitted / None leaves the stored key
    # untouched (so saving config never wipes a key); "" removes it; a non-empty value
    # replaces it.
    api_key: Optional[str] = None
    admin_api_key: Optional[str] = None
    default_model: Optional[str] = None
    custom_models: Optional[List[str]] = None
    image_size: Optional[str] = None


@router.put("/images")
def update_image_settings(
    payload: ImageSettingsUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)

    if payload.api_key is not None:
        encrypted = encrypt_api_key(payload.api_key) if payload.api_key else ""
        _upsert_user_setting(session, user_id, _FAL_KEY, json.dumps(encrypted))

    if payload.admin_api_key is not None:
        encrypted = encrypt_api_key(payload.admin_api_key) if payload.admin_api_key else ""
        _upsert_user_setting(session, user_id, _FAL_ADMIN_KEY, json.dumps(encrypted))

    cfg = load_fal_config(session, user_id)
    if payload.default_model is not None:
        cfg["default_model"] = payload.default_model or DEFAULT_FAL_MODEL
    if payload.custom_models is not None:
        cfg["custom_models"] = [m.strip() for m in payload.custom_models if m and m.strip()]
    if payload.image_size is not None and payload.image_size in FAL_IMAGE_SIZES:
        cfg["image_size"] = payload.image_size
    _upsert_user_setting(session, user_id, _FAL_CONFIG, json.dumps({
        "default_model": cfg["default_model"],
        "custom_models": cfg["custom_models"],
        "image_size": cfg["image_size"],
    }))

    session.commit()
    return get_image_settings(request, session)


def _extract_fal_balance(body: Any) -> Dict[str, Any]:
    """Best-effort pull of a balance/credit figure from fal's billing response. fal's
    account API schema isn't publicly documented for automated fetch, so we scan a set
    of likely keys and degrade gracefully when none are present."""
    out: Dict[str, Any] = {}
    if isinstance(body, dict):
        for key in ("balance", "credits", "available_credits", "credit_balance", "remaining_credits", "amount"):
            val = body.get(key)
            if isinstance(val, (int, float)):
                out["balance"] = val
                break
        currency = body.get("currency") or body.get("unit")
        if isinstance(currency, str):
            out["currency"] = currency
    return out


@router.get("/images/usage")
async def get_image_usage(request: Request, days: int = 30, session: Session = Depends(get_session)):
    """fal.ai account spend + (best-effort) remaining balance. Uses the admin/billing key
    (falling back to the generation key). Also refreshes the per-model price cache from the
    usage summary. Returns {available: false, note} when unavailable so the UI can fall back
    to the local per-image totals from /api/settings/usage."""
    user_id = _get_user_id(request)
    billing_key = load_fal_billing_key(session, user_id)
    has_admin = bool(load_fal_admin_key(session, user_id))
    if not billing_key:
        return {"available": False, "has_admin_key": has_admin, "note": "No fal.ai API key configured."}

    body = await _fetch_fal_usage_summary(billing_key, days)
    if body is None:
        note = (
            "Could not read fal.ai usage. The account/usage API needs an admin-scoped key."
            if not has_admin else "Could not reach fal.ai usage API."
        )
        return {"available": False, "has_admin_key": has_admin, "note": note}

    summary = body.get("summary") or []
    prices = _refresh_fal_prices(session, user_id, summary)
    total = sum((it.get("cost") or 0) for it in summary if isinstance(it, dict))
    currency = next((it.get("currency") for it in summary if isinstance(it, dict) and it.get("currency")), "USD")

    result: Dict[str, Any] = {
        "available": True,
        "has_admin_key": has_admin,
        "days": max(1, min(days, 90)),
        "currency": currency,
        "total_spend": round(total, 4),
        "by_endpoint": [
            {
                "endpoint_id": it.get("endpoint_id"),
                "cost": it.get("cost"),
                "unit": it.get("unit"),
                "unit_price": it.get("unit_price"),
                "quantity": it.get("quantity"),
                "currency": it.get("currency"),
            }
            for it in summary if isinstance(it, dict)
        ],
        "prices": prices,
    }

    # Remaining balance is best-effort: many fal accounts are pay-as-you-go (no prepaid
    # credit), in which case the billing endpoint exposes no balance figure.
    try:
        async with httpx.AsyncClient(timeout=15.0) as http:
            bresp = await http.get(
                _FAL_BILLING_URL,
                headers={"Authorization": f"Key {billing_key}"},
                params={"credits": "true"},
            )
        if bresp.is_success:
            bal = _extract_fal_balance(bresp.json())
            if "balance" in bal:
                result["balance"] = bal["balance"]
                result["balance_currency"] = bal.get("currency") or currency
    except Exception:
        pass

    return result


@router.get("/images/pricing")
async def get_image_pricing(request: Request, session: Session = Depends(get_session)):
    """Per-model unit prices (from fal's usage summary), used to show cost estimates. Served
    from cache, refreshed when stale and a billing key is available."""
    user_id = _get_user_id(request)
    cache = _read_fal_price_cache(session, user_id)
    fetched_at = cache.get("fetched_at")
    stale = True
    if fetched_at:
        try:
            stale = (datetime.utcnow() - datetime.fromisoformat(fetched_at)).total_seconds() > _FAL_PRICE_TTL_SECONDS
        except (ValueError, TypeError):
            stale = True

    if stale:
        billing_key = load_fal_billing_key(session, user_id)
        if billing_key:
            body = await _fetch_fal_usage_summary(billing_key, days=90)
            if body is not None:
                prices = _refresh_fal_prices(session, user_id, body.get("summary") or [])
                if prices:
                    return {"prices": prices, "fetched_at": datetime.utcnow().isoformat()}

    return {"prices": cache.get("prices") or {}, "fetched_at": cache.get("fetched_at")}


# ─── Themes ───────────────────────────────────────────────────────────────────


@router.get("/themes", response_model=ListResponse[ThemeRead])
def list_themes(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    global_themes = session.exec(select(Theme).where(Theme.is_global == True)).all()
    personal_themes = session.exec(select(Theme).where(Theme.user_id == user_id, Theme.is_global == False)).all()
    all_themes = list(global_themes) + list(personal_themes)
    return ListResponse(
        data=[ThemeRead.model_validate(t) for t in all_themes],
        total=len(all_themes),
        limit=len(all_themes),
        offset=0,
    )


@router.post("/themes", response_model=DataResponse[ThemeRead], status_code=201)
def create_theme(payload: ThemeCreate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    is_global = payload.is_global and _is_admin(request, session)
    theme = Theme(
        id=str(uuid.uuid4()),
        name=payload.name,
        user_id=None if is_global else user_id,
        is_global=is_global,
        mode=payload.mode,
        bg_type=payload.bg_type,
        bg_color1=payload.bg_color1,
        bg_color2=payload.bg_color2,
        bg_image_url=payload.bg_image_url,
        bg_image_mode=payload.bg_image_mode,
        bg_blur=payload.bg_blur,
        glass_opacity=payload.glass_opacity,
        glass_blur=payload.glass_blur,
        shadow_size=payload.shadow_size,
        shadow_blur=payload.shadow_blur,
    )
    session.add(theme)
    session.commit()
    session.refresh(theme)
    return DataResponse(data=ThemeRead.model_validate(theme))


@router.put("/themes/{theme_id}", response_model=DataResponse[ThemeRead])
def update_theme(theme_id: str, payload: ThemeUpdate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    theme = session.get(Theme, theme_id)
    if not theme:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Theme not found"})
    is_admin = _is_admin(request, session)
    if theme.is_global and not is_admin:
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Only admins can edit global themes"})
    if not theme.is_global and theme.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Theme not found"})

    for field in ["name", "mode", "bg_type", "bg_color1", "bg_color2", "bg_image_url",
                  "bg_image_mode", "bg_blur", "glass_opacity", "glass_blur", "shadow_size", "shadow_blur"]:
        val = getattr(payload, field, None)
        if val is not None:
            setattr(theme, field, val)

    if payload.is_global is not None and is_admin:
        theme.is_global = payload.is_global
        if payload.is_global:
            theme.user_id = None
        elif theme.user_id is None:
            theme.user_id = user_id

    session.add(theme)
    session.commit()
    session.refresh(theme)
    return DataResponse(data=ThemeRead.model_validate(theme))


@router.delete("/themes/{theme_id}", status_code=204)
def delete_theme(theme_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    theme = session.get(Theme, theme_id)
    if not theme:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Theme not found"})
    is_admin = _is_admin(request, session)
    if theme.is_global and not is_admin:
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Only admins can delete global themes"})
    if not theme.is_global and theme.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Theme not found"})
    session.delete(theme)
    session.commit()


@router.post("/themes/{theme_id}/activate", response_model=DataResponse[ThemeRead])
def activate_theme(theme_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    theme = session.get(Theme, theme_id)
    if not theme:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Theme not found"})
    if not theme.is_global and theme.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Theme not found"})

    existing = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == "active_theme_id")
    ).first()
    serialised = json.dumps(theme_id)
    if existing:
        existing.value = serialised
        session.add(existing)
    else:
        session.add(UserSetting(user_id=user_id, key="active_theme_id", value=serialised))
    session.commit()
    return DataResponse(data=ThemeRead.model_validate(theme))


@router.delete("/themes/{theme_id}/activate", status_code=204)
def deactivate_theme(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    existing = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == "active_theme_id")
    ).first()
    if existing:
        session.delete(existing)
        session.commit()


# ─── Web search (per-user) ────────────────────────────────────────────────────
#
# Which backend the AI assistant searches the web with. Anthropic models search
# through Anthropic's own server-side tool (see `proxy_anthropic`) and never come
# here; no other provider the app talks to has such a tool, so for DeepSeek, OpenAI,
# Ollama and custom endpoints the app runs the search itself — against the backend
# configured here — and feeds the hits back to the model as conversation text.
#
# The key is encrypted at rest (same Fernet scheme as the AI/fal/Deepgram keys) and
# never returned to the browser; the GET reports only whether one is set. The
# default backend (DuckDuckGo) needs no key at all, so search works out of the box.

_WEB_SEARCH_CONFIG = "web_search_config"   # JSON: {"provider": "...", "base_url": "..."} — non-secret
_WEB_SEARCH_KEY = "web_search_api_key"     # encrypted; only the keyed backends use it


def _load_web_search_prefs(session: Session, user_id: str) -> Dict[str, str]:
    """The user's stored {provider, base_url}, defaulted for a user who never set them."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _WEB_SEARCH_CONFIG)
    ).first()
    cfg: Dict[str, Any] = {}
    if row and row.value:
        try:
            cfg = json.loads(row.value) or {}
        except (ValueError, TypeError):
            cfg = {}
    provider = str(cfg.get("provider") or WEB_SEARCH_DEFAULT_PROVIDER)
    if provider not in WEB_SEARCH_PROVIDERS:
        provider = WEB_SEARCH_DEFAULT_PROVIDER
    return {"provider": provider, "base_url": (cfg.get("base_url") or "").strip()}


def load_web_search_api_key(session: Session, user_id: str) -> Optional[str]:
    """Decrypted web-search API key for a user, or None when unset. Mirrors load_fal_api_key."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _WEB_SEARCH_KEY)
    ).first()
    if not row or not row.value:
        return None
    try:
        stored = json.loads(row.value)
    except (ValueError, TypeError):
        return None
    if not stored:
        return None
    try:
        return decrypt_api_key(stored)
    except Exception:
        return None


def load_web_search_config(session: Session, user_id: str) -> Dict[str, Any]:
    """Everything needed to run one search: provider, api_key, base_url. Reused by the
    search router, which is where the assistant's `web_search` action lands."""
    prefs = _load_web_search_prefs(session, user_id)
    return {**prefs, "api_key": load_web_search_api_key(session, user_id) or ""}


def web_search_configured(session: Session, user_id: str) -> bool:
    """Whether the user's chosen backend has everything it needs to run."""
    cfg = load_web_search_config(session, user_id)
    spec = WEB_SEARCH_PROVIDERS[cfg["provider"]]
    if spec.needs_api_key and not cfg["api_key"]:
        return False
    if spec.needs_base_url and not cfg["base_url"]:
        return False
    return True


def _web_search_payload(session: Session, user_id: str) -> Dict[str, Any]:
    prefs = _load_web_search_prefs(session, user_id)
    return {
        **prefs,
        "has_api_key": bool(load_web_search_api_key(session, user_id)),
        "configured": web_search_configured(session, user_id),
        # The backend catalogue travels with the settings so the picker (and its
        # "needs a key / needs a URL" hints) never drifts from app/web_search.py.
        "providers": [
            {
                "id": key,
                "label": spec.label,
                "needs_api_key": spec.needs_api_key,
                "needs_base_url": spec.needs_base_url,
            }
            for key, spec in WEB_SEARCH_PROVIDERS.items()
        ],
    }


class WebSearchSettingsUpdate(BaseModel):
    provider: Optional[str] = None
    base_url: Optional[str] = None
    # `api_key` is tri-state, same convention as the fal/Deepgram keys and the Substack
    # cookie: omitted / None leaves the stored key untouched; "" clears it; a non-empty
    # value replaces it.
    api_key: Optional[str] = None


class WebSearchTestRequest(BaseModel):
    # All optional: a value tests what the user just typed (before saving), an omitted
    # one falls back to the stored setting (re-check a saved configuration).
    provider: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None


@router.get("/web-search", response_model=Dict[str, Any])
def get_web_search_settings(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    return _web_search_payload(session, user_id)


@router.put("/web-search", response_model=Dict[str, Any])
def update_web_search_settings(
    payload: WebSearchSettingsUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    prefs = _load_web_search_prefs(session, user_id)

    if payload.provider is not None:
        provider = payload.provider.strip()
        if provider not in WEB_SEARCH_PROVIDERS:
            raise HTTPException(
                status_code=400,
                detail={"code": "unknown_provider", "message": f"Unknown web search backend “{provider}”"},
            )
        prefs["provider"] = provider

    if payload.base_url is not None:
        base_url = payload.base_url.strip().rstrip("/")
        if base_url:
            # Same posture as a custom AI provider's base URL: https only, public host.
            _require_safe_external_url(base_url)
        prefs["base_url"] = base_url

    if payload.provider is not None or payload.base_url is not None:
        _upsert_user_setting(session, user_id, _WEB_SEARCH_CONFIG, json.dumps(prefs))

    if payload.api_key is not None:
        encrypted = encrypt_api_key(payload.api_key) if payload.api_key else ""
        _upsert_user_setting(session, user_id, _WEB_SEARCH_KEY, json.dumps(encrypted))

    session.commit()
    return _web_search_payload(session, user_id)


@router.post("/web-search/test", response_model=Dict[str, Any])
async def test_web_search(
    payload: WebSearchTestRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Run a throwaway query against the backend. Always HTTP 200 with
    {success, message} (mirrors /ai-providers/test and /substack/test)."""
    user_id = _get_user_id(request)
    stored = load_web_search_config(session, user_id)
    provider = (payload.provider or stored["provider"]).strip()
    if provider not in WEB_SEARCH_PROVIDERS:
        return {"success": False, "message": f"Unknown web search backend “{provider}”."}

    api_key = payload.api_key or (stored["api_key"] if provider == stored["provider"] else "")
    base_url = (payload.base_url or "").strip() or (stored["base_url"] if provider == stored["provider"] else "")

    try:
        results = await search_web(
            provider=provider,
            query="what is the current date",
            api_key=api_key,
            base_url=base_url,
            count=3,
        )
    except SearchError as e:
        return {"success": False, "message": e.message}
    except Exception:
        logger.exception("web search test failed")
        return {"success": False, "message": "The search failed unexpectedly. Check the server logs."}

    label = WEB_SEARCH_PROVIDERS[provider].label
    if not results:
        return {"success": False, "message": f"{label} answered, but returned no results."}
    return {
        "success": True,
        "message": f"Connected — {label} returned {len(results)} result(s), e.g. “{results[0].title}”.",
    }


# ─── Substack publishing (per-user) ───────────────────────────────────────────
#
# Push a note to the user's Substack publication as a DRAFT. Auth is cookie-only:
# Substack blocks scripted email/password logins behind a captcha, so the user
# pastes their browser session-cookie string. The cookie is encrypted at rest
# (same Fernet scheme as the AI/fal/Deepgram keys) and never returned to the
# browser — the GET reports only booleans. The publication URL is non-secret.
# The actual publish (synchronous `python-substack` calls + image uploads) runs in
# a threadpool; all library specifics live in app/substack_publish.py.

_SUBSTACK_CONFIG = "substack_config"   # JSON: {"publication_url": "..."} — non-secret
_SUBSTACK_COOKIE = "substack_cookie"   # encrypted session-cookie string


def _load_substack_publication_url(session: Session, user_id: str) -> str:
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _SUBSTACK_CONFIG)
    ).first()
    if not row or not row.value:
        return ""
    try:
        cfg = json.loads(row.value) or {}
    except (ValueError, TypeError):
        return ""
    return (cfg.get("publication_url") or "").strip()


def load_substack_cookie(session: Session, user_id: str) -> Optional[str]:
    """Decrypted Substack session cookie for a user, or None when unset. Mirrors load_fal_api_key."""
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _SUBSTACK_COOKIE)
    ).first()
    if not row or not row.value:
        return None
    try:
        stored = json.loads(row.value)
    except (ValueError, TypeError):
        return None
    if not stored:
        return None
    try:
        return decrypt_api_key(stored)
    except Exception:
        return None


def _substack_settings_payload(session: Session, user_id: str) -> Dict[str, Any]:
    publication_url = _load_substack_publication_url(session, user_id)
    has_cookie = bool(load_substack_cookie(session, user_id))
    return {
        "publication_url": publication_url,
        "has_cookie": has_cookie,
        "configured": bool(publication_url and has_cookie),
    }


class SubstackSettingsUpdate(BaseModel):
    publication_url: Optional[str] = None
    # `cookie` is tri-state, same convention as the fal/Deepgram keys: omitted / None
    # leaves the stored cookie untouched; "" clears it; a non-empty value replaces it.
    cookie: Optional[str] = None


class SubstackPublishRequest(BaseModel):
    title: str
    markdown: str
    subtitle: Optional[str] = None
    tags: Optional[List[str]] = None


class SubstackTestRequest(BaseModel):
    # Both optional: a non-empty value tests what the user just typed (before saving);
    # an omitted/empty value falls back to the stored setting (re-check the saved cookie).
    publication_url: Optional[str] = None
    cookie: Optional[str] = None


@router.get("/substack", response_model=Dict[str, Any])
def get_substack_settings(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    return _substack_settings_payload(session, user_id)


@router.put("/substack", response_model=Dict[str, Any])
def update_substack_settings(
    payload: SubstackSettingsUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)

    if payload.publication_url is not None:
        url = payload.publication_url.strip()
        if url:
            _require_safe_external_url(url)  # https + public host (also guards SSRF)
        _upsert_user_setting(session, user_id, _SUBSTACK_CONFIG, json.dumps({"publication_url": url}))

    if payload.cookie is not None:
        encrypted = encrypt_api_key(payload.cookie) if payload.cookie else ""
        _upsert_user_setting(session, user_id, _SUBSTACK_COOKIE, json.dumps(encrypted))

    session.commit()
    return _substack_settings_payload(session, user_id)


@router.post("/substack/publish", response_model=Dict[str, Any])
async def publish_to_substack(
    payload: SubstackPublishRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Create a Substack draft from the note's rendered Markdown. Returns the draft id/URL."""
    user_id = _get_user_id(request)
    publication_url = _load_substack_publication_url(session, user_id)
    cookie = load_substack_cookie(session, user_id)
    if not publication_url or not cookie:
        raise HTTPException(
            status_code=400,
            detail={"code": "substack_unconfigured", "message": "Add your Substack publication URL and session cookie in Settings → Publishing first."},
        )

    try:
        draft_id = await run_in_threadpool(
            create_substack_draft,
            publication_url=publication_url,
            cookie=cookie,
            title=payload.title,
            markdown=payload.markdown,
            subtitle=payload.subtitle or "",
            tags=payload.tags,
            media_dir=_MEDIA_ROOT,
        )
    except SubstackError as e:
        raise HTTPException(status_code=502, detail={"code": "substack_failed", "message": str(e)})

    draft_url = f"{publication_url.rstrip('/')}/publish/post/{draft_id}"
    return {"draft_id": draft_id, "draft_url": draft_url}


@router.post("/substack/test", response_model=Dict[str, Any])
async def test_substack(
    payload: SubstackTestRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Validate a cookie + publication URL without creating a draft. Always HTTP 200
    with {success, message} (mirrors /ai-providers/test)."""
    user_id = _get_user_id(request)
    publication_url = (payload.publication_url or "").strip() or _load_substack_publication_url(session, user_id)
    cookie = payload.cookie or load_substack_cookie(session, user_id)
    if not publication_url or not cookie:
        return {"success": False, "message": "Enter a publication URL and session cookie first."}
    try:
        await run_in_threadpool(test_substack_connection, publication_url=publication_url, cookie=cookie)
        return {"success": True, "message": "Connected — your cookie is valid and the publication was found."}
    except SubstackError as e:
        return {"success": False, "message": str(e)}
