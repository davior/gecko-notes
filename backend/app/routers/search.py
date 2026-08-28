"""The AI assistant's web search endpoint.

The assistant asks for a search by emitting a `web_search` action in its plan; the
frontend runs it through here and feeds the hits back into the conversation. That
path exists because only Anthropic can search inside the model call — every other
provider (DeepSeek, OpenAI-compatible, Ollama) has no search tool, so the app has to
do the searching. See app/web_search.py for the backends and why.

Searches are per-user: the backend and its credentials come from that user's own
settings, and each search is recorded as a usage event so the cost of a keyed
backend is visible in the usage dashboard alongside tokens, speech and images.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session
from typing import Any, Dict, Optional

from app.database import get_session
from app.limiter import limiter
from app.routers.settings import (
    _record_usage,
    load_web_search_config,
)
from app.web_search import PROVIDERS, SearchError, search_web

router = APIRouter()

logger = logging.getLogger(__name__)


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


class WebSearchRequest(BaseModel):
    query: str
    # Capped server-side (app.web_search.MAX_RESULTS); the model may ask for more.
    count: Optional[int] = None


@router.post("/web", response_model=Dict[str, Any])
@limiter.limit("30/minute")
async def run_web_search(
    payload: WebSearchRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Search the web with the user's configured backend and return normalised hits.

    A search that the user's configuration can't run (missing key, unreachable
    instance, a throttled scraper) is a 4xx/5xx with the reason in `detail.message`,
    which the assistant surfaces to the model as a failed-search note rather than
    pretending the web is unreachable in principle.
    """
    user_id = _get_user_id(request)
    config = load_web_search_config(session, user_id)

    try:
        results = await search_web(
            provider=config["provider"],
            query=payload.query,
            api_key=config["api_key"],
            base_url=config["base_url"],
            count=payload.count,
        )
    except SearchError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": e.message})
    except Exception:
        logger.exception("web search failed")
        raise HTTPException(
            status_code=502,
            detail={"code": "search_failed", "message": "The web search failed unexpectedly."},
        )

    provider = config["provider"]
    # Best-effort accounting; never breaks the search itself.
    _record_usage(
        session, user_id, "search", provider, 1, "searches", provider=provider,
    )

    return {
        "provider": provider,
        "provider_label": PROVIDERS[provider].label,
        "query": payload.query.strip(),
        "results": [r.as_dict() for r in results],
    }
