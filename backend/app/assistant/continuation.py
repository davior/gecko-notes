"""Finishing a planning turn the provider left open.

`provider.py` says generation never needs any of this, and that is still true — it
sets `enableWebSearch: false`, so no `server_tool_use` block can appear. Planning is
the opposite case: it is the turn that searches, so the recovery `ai.ts` grew for it
has to come across with it.

The problem, verbatim from `ai.ts`: Anthropic's own web search completes inside a
single Messages call — the model searches, reads the hits, and the turn ends with
`end_turn`. DeepSeek's Anthropic-compatible endpoint does not. Once the model has
spent the tool's `max_uses` budget its reply comes back with `stop_reason: "tool_use"`,
and every outstanding call is a `server_tool_use` the PROVIDER already answered, the
last couple with a `max_uses_exceeded` error. Nothing is left for a client to run, so
the turn is simply unfinished: the plan JSON was never written. What the user sees is
the model's between-search commentary ("I'll create the note now…") with no plan behind
it, or — when it searched without writing any text — an empty reply.

So the turn is finished here: replay what the model has, ask for the reply it never got
to, and withhold the search tool so the round that stalled cannot start again.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional

# A provider that stalls twice in a row will stall forever, and every attempt costs a
# full round trip on an already-slow turn.
MAX_TURN_CONTINUATIONS = 2

# The user turn that asks for the answer the stalled turn never produced. It states
# that the budget is spent, because a model whose last searches failed with
# `max_uses_exceeded` otherwise just tries to search again.
FINISH_TURN_REQUEST = (
    "Your web searching for this turn is over — the search budget is spent and no further "
    "searches are available. Do not describe what you are about to do and do not apologise. "
    "Answer the request above now, in exactly the response format your instructions require."
)

# How many hits from one search to replay into the continuation: enough to cite from,
# few enough that several searches don't crowd out the note being worked on.
REPLAYED_HITS_PER_SEARCH = 5

# Appended when the model stops at its output cap, so the user knows the reply is
# incomplete. Matches TRUNCATION_NOTICE in services/ai.ts — the conversation one, which
# is worded for a person reading the chat, not provider.py's terser generation notice.
TRUNCATION_NOTICE = (
    "\n\n---\n*This response was cut off due to length. You can ask me to continue, "
    "or request the information in smaller parts.*"
)


def _blocks(data: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [b for b in ((data or {}).get("content") or []) if isinstance(b, dict)]


def is_stalled_turn(data: Optional[Dict[str, Any]]) -> bool:
    """True when a reply stopped on tool use that leaves us nothing to do.

    Every pending call is a `server_tool_use` the provider ran itself. A client-side
    `tool_use` block is the opposite case, handled in `extract_plan_text`, which reads
    a plan out of it.
    """
    if (data or {}).get("stop_reason") != "tool_use":
        return False
    blocks = _blocks(data)
    return any(b.get("type") == "server_tool_use" for b in blocks) and not any(
        b.get("type") == "tool_use" for b in blocks
    )


def stalled_turn_as_text(data: Optional[Dict[str, Any]]) -> str:
    """Fold a stalled turn back into the conversation as ordinary text: what the model
    managed to say, plus the hits it already has so it needn't (and can't) search again.

    Deliberately NOT a replay of the raw blocks. `thinking` signatures and
    server_tool_use/result pairing are exactly what a compatible-but-not-identical
    gateway validates differently, and a rejected continuation would turn a recoverable
    stall into a hard error. Handing search results back as conversation text is what
    the app already does for providers with no native tool (see web_search.py).
    """
    blocks = _blocks(data)
    parts = [
        text for text in
        ((b.get("text") or "").strip() for b in blocks if b.get("type") == "text")
        if text
    ]

    # Pair each search with what it returned: the query is on the `server_tool_use`
    # block, the hits on the `web_search_tool_result` that follows it.
    searches: List[str] = []
    query = ""
    for block in blocks:
        if block.get("type") == "server_tool_use":
            block_input = block.get("input")
            asked = block_input.get("query") if isinstance(block_input, dict) else None
            query = asked if isinstance(asked, str) else ""
        elif block.get("type") == "web_search_tool_result":
            content = block.get("content")
            hits = content if isinstance(content, list) else []
            lines = []
            for hit in hits:
                if not isinstance(hit, dict):
                    continue
                url = hit.get("url")
                if not isinstance(url, str) or not url:
                    continue
                title = hit.get("title")
                lines.append(f"- {title if isinstance(title, str) and title else url} — {url}")
                if len(lines) == REPLAYED_HITS_PER_SEARCH:
                    break
            if lines:
                searches.append("\n".join([f"Search “{query}”:", *lines]))

    if searches:
        parts.append("\n\n".join(["Web search results already gathered this turn:", *searches]))

    # An assistant turn may not be empty, and a model that searched without writing a
    # word leaves nothing else to send back.
    return "\n\n".join(parts) or "(searching)"


def continuation_body(
    body: Dict[str, Any], data: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """The follow-up request that finishes a stalled turn.

    `tools` is dropped so the search loop that stalled cannot restart; everything
    before the two appended messages is the original body untouched, so its
    prompt-cache breakpoints still hit.
    """
    nxt = copy.copy(body)
    nxt["messages"] = [
        *(body.get("messages") or []),
        {"role": "assistant", "content": stalled_turn_as_text(data)},
        {"role": "user", "content": FINISH_TURN_REQUEST},
    ]
    nxt.pop("tools", None)
    return nxt


def extract_plan_text(data: Optional[Dict[str, Any]]) -> str:
    """The plan text out of an Anthropic reply.

    Text blocks are joined: adjacent ones are a single passage — Anthropic splits a
    paragraph at each citation — so they concatenate, while a gap where a tool call ran
    is a real break and gets a blank line. Without that, commentary from either side of
    a search runs together mid-word ("…as a new note.I have everything I need").

    If the model misfired a *described* plan action as a native `tool_use` block instead
    of emitting the JSON envelope, the plan is recovered from it. Not gated on empty
    text: with web search, Claude writes running commentary even when the real action
    lives in a tool_use block, so gating would drop the commentary.
    """
    import json

    blocks = _blocks(data)
    text = ""
    gap = False
    for block in blocks:
        if block.get("type") != "text":
            if text:
                gap = True
            continue
        chunk = block.get("text")
        if not chunk:
            continue
        if text and gap:
            text += "\n\n"
        text += chunk
        gap = False

    if (data or {}).get("stop_reason") == "tool_use":
        actions = []
        for block in blocks:
            if block.get("type") != "tool_use":
                continue
            block_input = block.get("input")
            if not isinstance(block_input, dict):
                continue
            action = dict(block_input)
            if not action.get("type") and block.get("name"):
                action["type"] = block["name"]
            actions.append(action)
        if actions:
            text = json.dumps({"actions": actions}, ensure_ascii=False, separators=(",", ":"))

    return text


def finalize_plan_text(protocol: str, data: Optional[Dict[str, Any]]) -> str:
    """The reply as the parser should see it, truncation notice included.

    The protocol is not optional here, and reading it out of the wrong shape is not a
    crash — it is silence. This shipped calling `extract_plan_text` unconditionally,
    which walks `data["content"]`; an OpenAI-compatible reply keeps its text at
    `choices[0].message.content` and an Ollama one at `message.content`, so on either of
    those every planning call read as empty. `parse_plan("")` then returned its
    "(no response)" fallback, the turn looked respond-only, and it finished successfully
    having said nothing and created nothing. Nothing errored, so nothing said so.

    `provider.extract_text` reads all three shapes and is what the deferred-body path
    uses; this cannot simply call it, because the two carry different truncation
    notices — that one is worded for a note body, and this text lands in the chat.
    """
    if protocol == "anthropic":
        # Only this shape can carry a plan inside a tool_use block, or split one reply
        # across several text blocks.
        text, truncated = extract_plan_text(data), (data or {}).get("stop_reason") == "max_tokens"
    elif protocol == "ollama":
        text = ((data or {}).get("message") or {}).get("content")
        truncated = (data or {}).get("done_reason") == "length"
    else:  # openai-compatible
        choices = (data or {}).get("choices") or []
        first = choices[0] if choices else {}
        text = (first.get("message") or {}).get("content")
        truncated = first.get("finish_reason") == "length"

    text = str(text or "")
    return text + TRUNCATION_NOTICE if truncated else text


__all__ = [
    "MAX_TURN_CONTINUATIONS",
    "FINISH_TURN_REQUEST",
    "TRUNCATION_NOTICE",
    "is_stalled_turn",
    "stalled_turn_as_text",
    "continuation_body",
    "extract_plan_text",
    "finalize_plan_text",
]
