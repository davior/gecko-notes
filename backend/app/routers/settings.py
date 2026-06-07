import ipaddress
import json
import urllib.parse
import uuid
from datetime import datetime, timedelta
import httpx
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import encrypt_api_key, decrypt_api_key
from app.database import get_session
from app.models import AIProvider, AppSetting, User, UsageEvent, UserSetting, SystemPrompt, Theme
from app.schemas import (
    AIProviderCreate, AIProviderUpdate, AIProviderRead, AIProviderTest,
    DataResponse, ListResponse, SettingsUpdate,
    SystemPromptCreate, SystemPromptUpdate, SystemPromptRead,
    ThemeCreate, ThemeUpdate, ThemeRead,
)

router = APIRouter()


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
) -> None:
    """Record an external-API usage event. Best-effort: never breaks the request."""
    try:
        session.add(UsageEvent(
            id=str(uuid.uuid4()),
            user_id=user_id,
            kind=kind,
            model=model or "",
            units=int(units or 0),
            unit_type=unit_type or "",
            created_at=datetime.utcnow(),
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

    for field in ["name", "provider_type", "base_url", "model", "enabled", "is_active"]:
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

class AnthropicProxyRequest(BaseModel):
    provider_id: str
    model: str
    max_tokens: int
    messages: List[Dict[str, Any]]
    system: Optional[str] = None
    temperature: Optional[float] = None
    prefill: Optional[str] = None


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

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": decrypt_api_key(provider.api_key),
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=body,
        )

    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    data = response.json()
    try:
        usage = data.get("usage") or {}
        tokens = int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0))
        if tokens:
            _record_usage(session, user_id, "ai", payload.model, tokens, "tokens")
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

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{base}/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {decrypt_api_key(provider.api_key)}",
                "content-type": "application/json",
            },
            json=body,
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
    if payload.temperature is not None:
        body["options"] = {"temperature": payload.temperature}

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            f"{base}/api/chat",
            headers={"content-type": "application/json"},
            json=body,
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
            f"https://api.deepgram.com/v1/speak?model={payload.model}",
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
        t = totals.setdefault(ev.kind, {"kind": ev.kind, "count": 0, "units": 0, "unit_type": ev.unit_type})
        t["count"] += 1
        t["units"] += ev.units
        if not t["unit_type"]:
            t["unit_type"] = ev.unit_type
        day = ev.created_at.date().isoformat()
        by_day[(day, ev.kind)] = by_day.get((day, ev.kind), 0) + ev.units

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
                "created_at": e.created_at.replace(tzinfo=None).isoformat() + "Z",
            }
            for e in recent
        ],
    }


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
