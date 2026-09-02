"""One generation call, over whichever protocol the provider speaks.

Two things are deliberately *not* reimplemented here.

The request body is not built. The browser assembled it when the plan was approved —
including the four `cache_control` breakpoints whose exact order and placement decide
whether the prompt cache hits — and shipped it with the job. This module appends a
step's two follow-up messages and sends it. Re-deriving the body server-side would
mean a second copy of `ai.ts`'s layout rules for three protocols, with nothing to
check it against.

The upstream call is not rebuilt either: it goes through the same proxy handlers the
browser posts to. They already resolve the endpoint, apply the provider's stored
extra params (top-level for Anthropic and OpenAI, nested under `options` with
`num_predict` for Ollama — the differences are exactly the kind of detail a
reimplementation gets subtly wrong), and record usage. Calling them directly means a
generated body is billed and attributed identically whether the browser or a worker
asked for it.

Reading the reply is small because generation never searches: `generatePlanContent`
sets `enableWebSearch: false`, so no `server_tool_use` blocks can appear and none of
the stalled-turn recovery in `ai.ts` applies. What is left is joining the text.
"""

import copy
import logging
from types import SimpleNamespace
from typing import Any, Dict, List

from sqlmodel import Session

logger = logging.getLogger(__name__)

# Matches TRUNCATION_NOTICE in services/ai.ts, so a body cut short reads the same
# whichever side generated it.
TRUNCATION_NOTICE = "\n\n_(Response truncated — the model hit its output limit.)_"


class PromptContext:
    """What the browser shipped: how to reach the provider, and what to send."""

    def __init__(self, raw: Dict[str, Any]) -> None:
        self.protocol: str = raw.get("protocol") or "anthropic"
        self.provider_id: str = raw.get("provider_id") or ""
        self.model: str = raw.get("model") or ""
        self.max_tokens: int = int(raw.get("max_tokens") or 4096)
        self.base_body: Dict[str, Any] = raw.get("base_body") or {}
        self.steps: List[Dict[str, Any]] = raw.get("steps") or []

    def body_for(self, step: Dict[str, Any]) -> Dict[str, Any]:
        """The base body with this step's follow-up messages appended.

        Everything before them — system blocks, history, the live note — is untouched,
        so every step reads the same cached prefix, which is the whole point of
        generating them in parallel.
        """
        body = copy.copy(self.base_body)
        body["messages"] = [
            *(self.base_body.get("messages") or []),
            *(step.get("messages") or []),
        ]
        return body


class _WorkerRequest:
    """Just enough of a Request for the proxy handlers, which read only the user id."""

    def __init__(self, user_id: str) -> None:
        self.state = SimpleNamespace(user_id=user_id)


# ─── reading a reply ─────────────────────────────────────────────────────────


def extract_text(protocol: str, data: Dict[str, Any]) -> str:
    """The generated body, out of whatever shape the provider returned."""
    if protocol == "anthropic":
        text, stop = _anthropic_text(data), data.get("stop_reason")
    elif protocol == "ollama":
        text = ((data.get("message") or {}).get("content")) or ""
        stop = data.get("done_reason")
    else:  # openai-compatible
        choices = data.get("choices") or []
        first = choices[0] if choices else {}
        text = ((first.get("message") or {}).get("content")) or ""
        stop = first.get("finish_reason")

    text = str(text or "")
    return text + TRUNCATION_NOTICE if stop in ("max_tokens", "length") else text


def _anthropic_text(data: Dict[str, Any]) -> str:
    """Join the text blocks.

    Adjacent text blocks are one continuous passage — Anthropic splits a paragraph at
    each citation — so they concatenate; a gap where some other block sat is a real
    break and gets a blank line. Without that, prose from either side of an
    interruption runs together mid-word.
    """
    parts: List[str] = []
    gap = False
    for block in data.get("content") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "text":
            if parts:
                gap = True
            continue
        if gap and parts:
            parts.append("\n\n")
            gap = False
        parts.append(str(block.get("text") or ""))
    return "".join(parts)


# ─── making the call ─────────────────────────────────────────────────────────


async def _send(session: Session, user_id: str, ctx: PromptContext, body: Dict[str, Any]) -> Dict[str, Any]:
    """Hand one already-built body to the proxy handler for its protocol."""
    from app.routers.settings import (
        AnthropicProxyRequest,
        OllamaProxyRequest,
        OpenAIProxyRequest,
        proxy_anthropic,
        proxy_ollama,
        proxy_openai,
    )

    payload = {**body, "provider_id": ctx.provider_id, "model": ctx.model}
    request = _WorkerRequest(user_id)

    if ctx.protocol == "anthropic":
        payload.setdefault("max_tokens", ctx.max_tokens)
        return await proxy_anthropic(AnthropicProxyRequest(**payload), request, session)
    if ctx.protocol == "ollama":
        payload.setdefault("max_tokens", ctx.max_tokens)
        return await proxy_ollama(OllamaProxyRequest(**payload), request, session)
    payload.setdefault("max_tokens", ctx.max_tokens)
    return await proxy_openai(OpenAIProxyRequest(**payload), request, session)


def call_provider_text(
    session: Session, user_id: str, ctx: PromptContext, step: Dict[str, Any]
) -> str:
    """Generate one step's body. Synchronous — this runs on a worker thread.

    Follows `_tts_caller`'s bridge pattern (video/worker.py): the upstream helpers are
    async, and `asyncio.run` is how a worker thread reaches them.
    """
    import asyncio

    data = asyncio.run(_send(session, user_id, ctx, ctx.body_for(step)))
    return extract_text(ctx.protocol, data)
