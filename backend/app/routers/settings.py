import json
import uuid
import httpx
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.models import AIProvider, AppSetting
from app.schemas import (
    AIProviderCreate, AIProviderUpdate, AIProviderRead, AIProviderTest,
    DataResponse, ListResponse, SettingsUpdate
)

router = APIRouter()


# ─── App Settings ────────────────────────────────────────────────────────────

@router.get("", response_model=Dict[str, Any])
def get_settings(session: Session = Depends(get_session)):
    rows = session.exec(select(AppSetting)).all()
    result = {}
    for row in rows:
        try:
            result[row.key] = json.loads(row.value)
        except Exception:
            result[row.key] = row.value
    return result


@router.put("", response_model=Dict[str, Any])
def update_settings(payload: SettingsUpdate, session: Session = Depends(get_session)):
    for key, value in payload.settings.items():
        existing = session.get(AppSetting, key)
        serialised = json.dumps(value)
        if existing:
            existing.value = serialised
            session.add(existing)
        else:
            session.add(AppSetting(key=key, value=serialised))
    session.commit()

    rows = session.exec(select(AppSetting)).all()
    result = {}
    for row in rows:
        try:
            result[row.key] = json.loads(row.value)
        except Exception:
            result[row.key] = row.value
    return result


# ─── AI Providers ─────────────────────────────────────────────────────────────

@router.get("/ai-providers", response_model=ListResponse[AIProviderRead])
def list_ai_providers(session: Session = Depends(get_session)):
    providers = session.exec(select(AIProvider)).all()
    return ListResponse(
        data=[AIProviderRead.model_validate(p) for p in providers],
        total=len(providers),
        limit=len(providers),
        offset=0,
    )


@router.post("/ai-providers", response_model=DataResponse[AIProviderRead], status_code=201)
def create_ai_provider(payload: AIProviderCreate, session: Session = Depends(get_session)):
    provider = AIProvider(
        id=str(uuid.uuid4()),
        name=payload.name,
        provider_type=payload.provider_type,
        api_key=payload.api_key,
        base_url=payload.base_url,
        model=payload.model,
        enabled=payload.enabled,
        is_active=payload.is_active,
    )
    if payload.is_active:
        # Deactivate all others
        others = session.exec(select(AIProvider)).all()
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
    session: Session = Depends(get_session),
):
    provider = session.get(AIProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})

    for field in ["name", "provider_type", "api_key", "base_url", "model", "enabled", "is_active"]:
        val = getattr(payload, field, None)
        if val is not None:
            setattr(provider, field, val)

    if payload.is_active:
        others = session.exec(select(AIProvider)).all()
        for o in others:
            if o.id != provider_id:
                o.is_active = False
                session.add(o)

    session.add(provider)
    session.commit()
    session.refresh(provider)
    return DataResponse(data=AIProviderRead.model_validate(provider))


@router.delete("/ai-providers/{provider_id}", status_code=204)
def delete_ai_provider(provider_id: str, session: Session = Depends(get_session)):
    provider = session.get(AIProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    session.delete(provider)
    session.commit()


@router.post("/ai-providers/{provider_id}/activate", response_model=DataResponse[AIProviderRead])
def activate_ai_provider(provider_id: str, session: Session = Depends(get_session)):
    provider = session.get(AIProvider, provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})

    all_providers = session.exec(select(AIProvider)).all()
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
                # 400 may mean bad request but the key is valid
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


# ─── Anthropic Proxy ──────────────────────────────────────────────────────────

class AnthropicProxyRequest(BaseModel):
    provider_id: str
    model: str
    max_tokens: int
    messages: List[Dict[str, Any]]
    system: Optional[str] = None


@router.post("/ai-providers/proxy/anthropic")
async def proxy_anthropic(payload: AnthropicProxyRequest, session: Session = Depends(get_session)):
    provider = session.get(AIProvider, payload.provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "AI provider not found"})
    if provider.provider_type != "anthropic":
        raise HTTPException(status_code=400, detail={"code": "invalid_provider", "message": "Provider is not Anthropic type"})

    body: Dict[str, Any] = {
        "model": payload.model,
        "max_tokens": payload.max_tokens,
        "messages": payload.messages,
    }
    if payload.system:
        body["system"] = payload.system

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
