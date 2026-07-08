import ipaddress
import json
import logging
import urllib.parse
import uuid
from datetime import datetime, timedelta
import httpx
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple, Union
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import encrypt_api_key, decrypt_api_key
from app.database import get_session, engine
from app.models import AIProvider, AppSetting, User, UsageEvent, UserSetting, SystemPrompt, Theme
from app.schemas import (
    AIProviderCreate, AIProviderUpdate, AIProviderRead, AIProviderTest,
    DataResponse, ListResponse, SettingsUpdate,
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


def _record_usage(
    session: Session,
    user_id: str,
    kind: str,
    model: str,
    units: int,
    unit_type: str,
    external_ref: Optional[str] = None,
    cost: Optional[float] = None,
    currency: Optional[str] = None,
) -> None:
    """Record an external-API usage event. Best-effort: never breaks the request.

    `external_ref`/`cost`/`currency` are optional cost attribution (populated for image
    generation); older callers omit them and get null columns."""
    try:
        session.add(UsageEvent(
            id=str(uuid.uuid4()),
            user_id=user_id,
            kind=kind,
            model=model or "",
            units=int(units or 0),
            unit_type=unit_type or "",
            created_at=datetime.utcnow(),
            external_ref=external_ref,
            cost=cost,
            currency=currency,
        ))
        session.commit()
    except Exception:
        session.rollback()


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

    for field in ["name", "provider_type", "base_url", "model", "max_tokens", "enabled", "is_active"]:
        val = getattr(payload, field, None)
        if val is not None:
            setattr(provider, field, val)
    if payload.api_key:
        if payload.provider_type in ("openai", "custom") and payload.base_url:
            _require_safe_external_url(payload.base_url)
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

    try:
        if payload.provider_type == "anthropic":
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
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

        elif payload.provider_type in ("openai", "custom"):
            base = (base_url or "https://api.openai.com").rstrip("/")
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
    """
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await client.post(url, headers=headers, json=json_body)
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
) -> Dict[str, Any]:
    """Blocking wrapper over :func:`_iter_anthropic_events`: drain the stream and
    return the reassembled message dict, so the non-streaming proxy is unchanged."""
    message: Dict[str, Any] = {}
    async for kind, val in _iter_anthropic_events(
        url, headers=headers, json_body=json_body, read_timeout=read_timeout
    ):
        if kind == "final":
            message = val
    return message


class AnthropicProxyRequest(BaseModel):
    provider_id: str
    model: str
    max_tokens: int
    messages: List[Dict[str, Any]]
    system: Optional[Union[str, List[Dict[str, Any]]]] = None
    temperature: Optional[float] = None
    prefill: Optional[str] = None
    tools: Optional[List[Dict[str, Any]]] = None


@router.post("/ai-providers/proxy/anthropic")
async def proxy_anthropic(payload: AnthropicProxyRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type != "anthropic":
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not Anthropic type"})

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
    if payload.temperature is not None:
        body["temperature"] = payload.temperature
    if payload.tools:
        body["tools"] = payload.tools

    uses_web_search = payload.tools and any(
        t.get("type", "").startswith("web_search") for t in payload.tools
    )
    beta_flags = "pdfs-2024-09-25"
    if uses_web_search:
        beta_flags += ",web-search-2025-03-05"

    # Stream the completion rather than blocking on one big POST: a large note plus
    # web-search latency easily exceeds a fixed total timeout, and a non-streaming
    # request returns nothing until it's fully generated, so it fails with a
    # ReadTimeout. Streaming keeps SSE events flowing (deltas + pings), so the
    # timeout only bounds the gap between events. We reassemble the final message
    # so the response shape is unchanged for the caller.
    data = await _stream_anthropic_message(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": decrypt_api_key(provider.api_key),
            "anthropic-version": "2023-06-01",
            "anthropic-beta": beta_flags,
            "content-type": "application/json",
        },
        json_body=body,
        read_timeout=120.0,
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
            _record_usage(session, user_id, "ai", payload.model, total, "tokens")
        logger.info(
            "anthropic usage model=%s input=%d output=%d cache_read=%d cache_write=%d",
            payload.model, inp, out, cache_read, cache_write,
        )
    except Exception:
        pass
    return data


class OpenAIProxyRequest(BaseModel):
    provider_id: str
    model: str
    max_tokens: int
    messages: List[Dict[str, Any]]
    temperature: Optional[float] = None


@router.post("/ai-providers/proxy/openai")
async def proxy_openai(
    payload: OpenAIProxyRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type not in ("openai", "custom"):
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not OpenAI-compatible"})

    base = (provider.base_url or "https://api.openai.com").rstrip("/")
    body: Dict[str, Any] = {
        "model": payload.model,
        "max_tokens": payload.max_tokens,
        "messages": payload.messages,
    }
    if payload.temperature is not None:
        body["temperature"] = payload.temperature

    response = await _post_upstream(
        f"{base}/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {decrypt_api_key(provider.api_key)}",
            "content-type": "application/json",
        },
        json_body=body,
        timeout=60.0,
        provider_label="the OpenAI-compatible API",
    )

    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    data = response.json()
    try:
        usage = data.get("usage") or {}
        tokens = int(usage.get("total_tokens", 0))
        if tokens:
            _record_usage(session, user_id, "ai", payload.model, tokens, "tokens")
    except Exception:
        pass
    return data


class OllamaProxyRequest(BaseModel):
    provider_id: str
    model: str
    messages: List[Dict[str, Any]]
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


@router.post("/ai-providers/proxy/ollama")
async def proxy_ollama(
    payload: OllamaProxyRequest,
    request: Request,
    session: Session = Depends(get_session),
):
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
        "stream": False,
    }
    # Ollama's output cap is options.num_predict (its equivalent of max_tokens).
    options: Dict[str, Any] = {}
    if payload.temperature is not None:
        options["temperature"] = payload.temperature
    if payload.max_tokens is not None:
        options["num_predict"] = payload.max_tokens
    if options:
        body["options"] = options

    response = await _post_upstream(
        f"{base}/api/chat",
        headers={"content-type": "application/json"},
        json_body=body,
        timeout=60.0,
        provider_label="Ollama",
    )

    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    data = response.json()
    try:
        tokens = int(data.get("prompt_eval_count", 0)) + int(data.get("eval_count", 0))
        if tokens:
            _record_usage(session, user_id, "ai", payload.model, tokens, "tokens")
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


def _record_anthropic_usage(user_id: str, model: str, data: Dict[str, Any]) -> None:
    """Mirror the usage accounting in proxy_anthropic, using a fresh Session."""
    try:
        usage = data.get("usage") or {}
        inp = int(usage.get("input_tokens", 0) or 0)
        out = int(usage.get("output_tokens", 0) or 0)
        cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
        cache_write = int(usage.get("cache_creation_input_tokens", 0) or 0)
        total = inp + out + cache_read + cache_write
        if total:
            with Session(engine) as s:
                _record_usage(s, user_id, "ai", model, total, "tokens")
        logger.info(
            "anthropic stream usage model=%s input=%d output=%d cache_read=%d cache_write=%d",
            model, inp, out, cache_read, cache_write,
        )
    except Exception:
        pass


@router.post("/ai-providers/proxy/anthropic/stream")
async def proxy_anthropic_stream(payload: AnthropicProxyRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    provider = session.get(AIProvider, payload.provider_id)
    if not provider or provider.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type != "anthropic":
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not Anthropic type"})

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
    if payload.temperature is not None:
        body["temperature"] = payload.temperature
    if payload.tools:
        body["tools"] = payload.tools

    uses_web_search = payload.tools and any(
        t.get("type", "").startswith("web_search") for t in payload.tools
    )
    beta_flags = "pdfs-2024-09-25"
    if uses_web_search:
        beta_flags += ",web-search-2025-03-05"

    headers = {
        "x-api-key": decrypt_api_key(provider.api_key),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": beta_flags,
        "content-type": "application/json",
    }
    model = payload.model

    async def gen():
        try:
            async for kind, val in _iter_anthropic_events(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json_body=body,
                read_timeout=120.0,
            ):
                if kind == "delta":
                    yield _sse("delta", {"text": val})
                else:
                    _record_anthropic_usage(user_id, model, val)
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
    if provider.provider_type not in ("openai", "custom"):
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not OpenAI-compatible"})

    base = (provider.base_url or "https://api.openai.com").rstrip("/")
    body: Dict[str, Any] = {
        "model": payload.model,
        "max_tokens": payload.max_tokens,
        "messages": payload.messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if payload.temperature is not None:
        body["temperature"] = payload.temperature
    headers = {
        "Authorization": f"Bearer {decrypt_api_key(provider.api_key)}",
        "content-type": "application/json",
    }
    url = f"{base}/v1/chat/completions"
    model = payload.model

    async def gen():
        full = ""
        finish_reason = None
        usage = None
        timeout = httpx.Timeout(120.0, connect=10.0, write=30.0, pool=10.0)
        try:
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
                                yield _sse("delta", {"text": piece})
                            if ch0.get("finish_reason"):
                                finish_reason = ch0["finish_reason"]
                        if evt.get("usage"):
                            usage = evt["usage"]
            final = {
                "choices": [{"message": {"role": "assistant", "content": full}, "finish_reason": finish_reason}],
                "usage": usage or {},
            }
            try:
                tokens = int((usage or {}).get("total_tokens", 0) or 0)
                if tokens:
                    with Session(engine) as s:
                        _record_usage(s, user_id, "ai", model, tokens, "tokens")
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
        "stream": True,
    }
    options: Dict[str, Any] = {}
    if payload.temperature is not None:
        options["temperature"] = payload.temperature
    if payload.max_tokens is not None:
        options["num_predict"] = payload.max_tokens
    if options:
        body["options"] = options
    url = f"{base}/api/chat"
    model = payload.model

    async def gen():
        full = ""
        done_reason = None
        prompt_eval = 0
        eval_count = 0
        timeout = httpx.Timeout(120.0, connect=10.0, write=30.0, pool=10.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                # Ollama streams newline-delimited JSON (not SSE) — one object per line.
                async with client.stream("POST", url, headers={"content-type": "application/json"}, json=body) as response:
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
                            yield _sse("delta", {"text": piece})
                        if evt.get("done"):
                            done_reason = evt.get("done_reason")
                            prompt_eval = int(evt.get("prompt_eval_count", 0) or 0)
                            eval_count = int(evt.get("eval_count", 0) or 0)
            final = {
                "message": {"role": "assistant", "content": full},
                "done_reason": done_reason,
                "prompt_eval_count": prompt_eval,
                "eval_count": eval_count,
            }
            try:
                tokens = prompt_eval + eval_count
                if tokens:
                    with Session(engine) as s:
                        _record_usage(s, user_id, "ai", model, tokens, "tokens")
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


# ─── Speech / Deepgram ────────────────────────────────────────────────────────

_DEEPGRAM_KEY = "deepgram_api_key"

# Curated set of Deepgram Aura / Aura-2 English voices exposed in the UI.
_TTS_VOICES = {
    "aura-2-thalia-en",
    "aura-2-andromeda-en",
    "aura-2-apollo-en",
    "aura-2-arcas-en",
    "aura-2-aries-en",
    "aura-asteria-en",
    "aura-luna-en",
    "aura-stella-en",
    "aura-orion-en",
    "aura-zeus-en",
}

_TTS_MAX_CHARS = 2000


@router.get("/speech")
def get_speech_settings(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _DEEPGRAM_KEY)
    ).first()
    has_key = bool(row and row.value and json.loads(row.value))
    return {"deepgram_api_key": "***" if has_key else ""}


class SpeechSettingsUpdate(BaseModel):
    deepgram_api_key: str


@router.put("/speech")
def update_speech_settings(
    payload: SpeechSettingsUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    encrypted = encrypt_api_key(payload.deepgram_api_key) if payload.deepgram_api_key else ""
    existing = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _DEEPGRAM_KEY)
    ).first()
    serialised = json.dumps(encrypted)
    if existing:
        existing.value = serialised
        session.add(existing)
    else:
        session.add(UserSetting(user_id=user_id, key=_DEEPGRAM_KEY, value=serialised))
    session.commit()
    return {"deepgram_api_key": "***" if payload.deepgram_api_key else ""}


@router.post("/speech/transcribe")
async def transcribe_speech(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form("nova-2"),
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _DEEPGRAM_KEY)
    ).first()
    if not row or not row.value:
        raise HTTPException(status_code=400, detail={"code": "no_deepgram_key", "message": "Deepgram API key is not configured"})

    api_key = decrypt_api_key(json.loads(row.value))
    audio_bytes = await file.read()
    content_type = file.content_type or "audio/webm"

    async with httpx.AsyncClient(timeout=120.0) as http:
        response = await http.post(
            f"https://api.deepgram.com/v1/listen?model={model}&smart_format=true",
            headers={
                "Authorization": f"Token {api_key}",
                "Content-Type": content_type,
            },
            content=audio_bytes,
        )

    if not response.is_success:
        raise HTTPException(status_code=502, detail={"code": "deepgram_error", "message": response.text})

    body = response.json()
    try:
        transcript = body["results"]["channels"][0]["alternatives"][0]["transcript"]
    except (KeyError, IndexError):
        raise HTTPException(status_code=502, detail={"code": "deepgram_parse_error", "message": "Unexpected Deepgram response"})

    # Record STT usage by audio duration (how Deepgram bills), falling back to chars.
    try:
        duration = body.get("metadata", {}).get("duration")
        if duration is not None:
            _record_usage(session, user_id, "stt", model, round(float(duration)), "seconds")
        else:
            _record_usage(session, user_id, "stt", model, len(transcript), "chars")
    except Exception:
        pass

    return {"text": transcript}


class TTSRequest(BaseModel):
    text: str
    model: str = "aura-2-thalia-en"
    speed: float = 1.0


@router.get("/speech/voices")
def list_tts_voices():
    """Curated Deepgram TTS voices available for read-aloud."""
    return {"voices": sorted(_TTS_VOICES)}


@router.post("/speech/tts")
async def synthesize_speech(
    payload: TTSRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    row = session.exec(
        select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _DEEPGRAM_KEY)
    ).first()
    if not row or not row.value:
        raise HTTPException(status_code=400, detail={"code": "no_deepgram_key", "message": "Deepgram API key is not configured"})

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail={"code": "empty_text", "message": "No text to synthesize"})
    if len(text) > _TTS_MAX_CHARS:
        raise HTTPException(status_code=400, detail={"code": "text_too_long", "message": f"Text exceeds {_TTS_MAX_CHARS} characters"})
    if payload.model not in _TTS_VOICES:
        raise HTTPException(status_code=400, detail={"code": "invalid_voice", "message": "Unknown TTS voice"})

    api_key = decrypt_api_key(json.loads(row.value))

    async with httpx.AsyncClient(timeout=120.0) as http:
        response = await http.post(
            f"https://api.deepgram.com/v1/speak?model={payload.model}&speed={payload.speed}",
            headers={
                "Authorization": f"Token {api_key}",
                "Content-Type": "application/json",
            },
            json={"text": text},
        )

    if not response.is_success:
        raise HTTPException(status_code=502, detail={"code": "deepgram_error", "message": response.text})

    _record_usage(session, user_id, "tts", payload.model, len(text), "chars")
    return Response(content=response.content, media_type="audio/mpeg")


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
    by_day: Dict[tuple, int] = {}
    for ev in events:
        t = totals.setdefault(ev.kind, {"kind": ev.kind, "count": 0, "units": 0, "unit_type": ev.unit_type, "cost": 0.0})
        t["count"] += 1
        t["units"] += ev.units
        if ev.cost is not None:
            t["cost"] += ev.cost
            if ev.currency and not t.get("currency"):
                t["currency"] = ev.currency
        if not t["unit_type"]:
            t["unit_type"] = ev.unit_type
        day = ev.created_at.date().isoformat()
        by_day[(day, ev.kind)] = by_day.get((day, ev.kind), 0) + ev.units

    # Round the accumulated cost so floating-point noise doesn't leak into the UI.
    for t in totals.values():
        t["cost"] = round(t["cost"], 4)

    recent = sorted(events, key=lambda e: e.created_at, reverse=True)[:50]

    return {
        "days": days,
        "totals_by_kind": list(totals.values()),
        "by_day": [
            {"date": day, "kind": kind, "units": units}
            for (day, kind), units in sorted(by_day.items())
        ],
        "recent": [
            {
                "kind": e.kind,
                "model": e.model,
                "units": e.units,
                "unit_type": e.unit_type,
                "cost": e.cost,
                "currency": e.currency,
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

# Curated fal.ai text-to-image endpoints surfaced in the UI. Users may add their own
# model ids on top of these (stored in the per-user config). The frontend uses the
# labels; the backend uses the ids as the allow-list for the generate endpoint.
FAL_CURATED_MODELS = [
    {"id": "fal-ai/flux/schnell", "label": "FLUX.1 [schnell] — fastest, low cost"},
    {"id": "fal-ai/flux/dev", "label": "FLUX.1 [dev] — high quality"},
    {"id": "fal-ai/flux-pro/v1.1", "label": "FLUX1.1 [pro] — top quality"},
    {"id": "fal-ai/recraft-v3", "label": "Recraft V3 — styles, text, vectors"},
    {"id": "fal-ai/stable-diffusion-v35-large", "label": "Stable Diffusion 3.5 Large"},
]
FAL_CURATED_MODEL_IDS = frozenset(m["id"] for m in FAL_CURATED_MODELS)

# fal image_size presets (the models also accept a {width,height} object, but the app
# only exposes the named presets to keep the UI simple).
FAL_IMAGE_SIZES = [
    "square_hd", "square",
    "portrait_4_3", "portrait_16_9",
    "landscape_4_3", "landscape_16_9",
]


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
    return {
        "default_model": cfg.get("default_model") or DEFAULT_FAL_MODEL,
        "custom_models": custom,
        "image_size": cfg.get("image_size") or DEFAULT_IMAGE_SIZE,
    }


def allowed_fal_models(config: Dict[str, Any]) -> set:
    """The set of model ids a user is allowed to generate with (curated + their custom ids)."""
    return set(FAL_CURATED_MODEL_IDS) | set(config.get("custom_models") or [])


@router.get("/images")
def get_image_settings(request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    api_key = load_fal_api_key(session, user_id)
    admin_key = load_fal_admin_key(session, user_id)
    cfg = load_fal_config(session, user_id)
    return {
        "has_api_key": bool(api_key),
        "has_admin_key": bool(admin_key),
        "curated_models": FAL_CURATED_MODELS,
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

def _is_admin(request: Request, session: Session) -> bool:
    user_id = _get_user_id(request)
    user = session.get(User, user_id)
    return bool(user and user.is_admin)


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
