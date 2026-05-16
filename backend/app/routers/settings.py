import json
import uuid
import httpx
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.models import AIProvider, AppSetting, UserSetting, SystemPrompt
from app.schemas import (
    AIProviderCreate, AIProviderUpdate, AIProviderRead, AIProviderTest,
    DataResponse, ListResponse, SettingsUpdate,
    SystemPromptCreate, SystemPromptUpdate, SystemPromptRead,
)

router = APIRouter()


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


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
    provider = AIProvider(
        id=str(uuid.uuid4()),
        name=payload.name,
        provider_type=payload.provider_type,
        api_key=payload.api_key,
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

    for field in ["name", "provider_type", "api_key", "base_url", "model", "enabled", "is_active"]:
        val = getattr(payload, field, None)
        if val is not None:
            setattr(provider, field, val)

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
async def test_ai_provider(payload: AIProviderTest):
    """Test connection to an AI provider by sending a minimal request."""
    try:
        if payload.provider_type == "anthropic":
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": payload.api_key,
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
            base = payload.base_url or "https://api.openai.com"
            base = base.rstrip("/")
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{base}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {payload.api_key}",
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
            base = payload.base_url or "http://localhost:11434"
            base = base.rstrip("/")
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{base}/api/tags")
            if response.status_code == 200:
                return {"success": True, "message": "Ollama reachable"}
            return {"success": False, "message": f"HTTP {response.status_code}"}

        else:
            return {"success": False, "message": "Unknown provider type"}

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


# ─── Anthropic Proxy ──────────────────────────────────────────────────────────

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
                "x-api-key": provider.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=body,
        )

    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    return response.json()
