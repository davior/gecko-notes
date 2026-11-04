"""Phase one by tool calls: the turn planned through Gecko Suite's chat with Notes' tools.

The text plan (`planner.run_planning`) asks for JSON in prose, digs it out, resolves the
searches it asks for and asks again. Here the model calls tools instead: it looks things
up as it goes and records each change as it decides on it, and `run_agent` (shared with
GAM and GVC through `gecko-suite-client`) runs the rounds. What comes out is the same
`{"actions": [...]}` plan, handed to the same `_decide`, so approval, the deferred-body
writer and the executor neither know nor care which planner ran.

Used only when the person has switched it on and `AI_BACKEND=suite` (see `wanted`): the
tool loop needs the suite's one tool-call shape across vendors, and local mode keeps the
text plan until that code is removed (M8). The model is the one picked in Notes' own
panel, named to the suite by vendor and model name.
"""

from __future__ import annotations

import base64
import logging
from contextlib import closing
from typing import Any, Callable, Dict, List

from gecko_suite_client import Image, SuiteChat, SuiteError, ToolSpec, run_agent
from gecko_suite_client.agent import Stopped
from sqlmodel import Session

from app import suite
from app.assistant.provider import PromptContext
from app.assistant.retrieve import RetrievalContext
from app.assistant.tools import (
    Proposal,
    handlers,
    history_pairs,
    prompt_text,
    system_blocks,
    tool_specs,
)
from app.models import AIProvider, AssistantRunJob

logger = logging.getLogger(__name__)

# How often one turn may search, per tool. The text plan allowed a few retrieval rounds;
# a model that keeps searching past this is told to carry on without it.
CAPS = {"find_notes": 6, "read_note": 12, "web_search": 5}


def wanted(turn_ctx: Dict[str, Any]) -> bool:
    """Whether this turn is planned by tool calls.

    Only with the suite (the per-person switch is ignored in local mode, where the text
    plan is the only planner), only when the browser sent the neutral context the tool
    path builds its own prompt from, and only when every attachment is an image: the
    suite's chat carries images, not the PDFs the text plan can send to Anthropic.
    """
    tool_ctx = turn_ctx.get("tool_ctx")
    if not (suite.enabled() and turn_ctx.get("tool_mode") and isinstance(tool_ctx, dict)):
        return False
    return all(str(a.get("media_type", "")).startswith("image/") for a in tool_ctx.get("attachments") or [])


def run_tool_planning(
    session: Session,
    job_id: str,
    *,
    check_cancelled: Callable[[], None],
    report: Callable[[str, int, str], None],
    is_cancelled: Callable[[], bool],
):
    from app.assistant.planner import Cancelled, PlanningResult, _decide, _load, _Preview

    job = session.get(AssistantRunJob, job_id)
    if not job:
        return PlanningResult(False)
    user_id = job.user_id
    ctx = PromptContext(_load(job.prompt_ctx, {}))
    exec_ctx: Dict[str, Any] = _load(job.exec_ctx, {})
    turn_ctx: Dict[str, Any] = _load(job.turn_ctx, {})
    tool_ctx: Dict[str, Any] = turn_ctx.get("tool_ctx") or {}

    provider = session.get(AIProvider, ctx.provider_id)
    if not provider or provider.user_id != user_id:
        raise RuntimeError("The AI provider for this turn no longer exists. Pick another and ask again.")

    proposal = Proposal(exec_ctx, dict(turn_ctx.get("label_map") or {}))
    retrieval = RetrievalContext(
        current_folder_id=exec_ctx.get("current_folder_id"),
        folder_names=turn_ctx.get("folder_names") or {},
        use_summaries=bool(turn_ctx.get("use_summaries")),
    )
    # Search runs through the suite in this mode for every vendor, so the tool is offered
    # whenever the panel would have offered search at all.
    web_search = turn_ctx.get("web_search_mode") in ("native", "action")
    voice = bool(turn_ctx.get("voice"))

    preview = _Preview(job_id)
    report("Planning", 1, "")
    check_cancelled()

    images = [Image(str(a.get("media_type")), base64.b64decode(str(a.get("data") or "")), str(a.get("name") or ""))
              for a in tool_ctx.get("attachments") or []]
    subject = f"notes:note:{exec_ctx['current_note_id']}" if exec_ctx.get("current_note_id") else None

    steps = {"n": 0}

    def on_step(kind: str, text: str) -> None:
        # Searching and recording show as progress through planning's share of the bar.
        steps["n"] += 1
        report("Planning", min(30, 2 + steps["n"] * 2), text[:120])

    try:
        with closing(suite.chat_client(user_id)) as connection:
            chat = SuiteChat(connection, app=suite.APP, vendor=provider.provider_type, model_name=ctx.model,
                             subject_ref=subject)
            conversation = chat.conversation(
                system=system_blocks(reference_block=str(tool_ctx.get("reference_block") or ""), voice=voice),
                tools=[ToolSpec(s["name"], s["description"], s["parameters"]) for s in tool_specs(web_search=web_search)],
                history=history_pairs(tool_ctx.get("history") or []),
                prompt=prompt_text(current_note_text=tool_ctx.get("current_note_text"),
                                   user_request=str(tool_ctx.get("user_request") or "")),
                images=images,
            )
            outcome = run_agent(
                conversation,
                handlers=handlers(session, user_id, proposal, retrieval, web_search=web_search),
                caps=CAPS,
                cancelled=is_cancelled,
                on_step=on_step,
                on_delta=preview,
            )
    except Stopped as exc:
        raise Cancelled() from exc
    except SuiteError as exc:
        # The suite's sentences are written to be shown ("No anthropic provider with a key
        # is set up in Gecko Suite"), so the turn fails with it rather than a stack trace.
        raise RuntimeError(exc.message) from exc
    preview.flush()

    reply = (outcome.reply or "").strip()
    if outcome.cut_short:
        reply = f"{reply}\n\n_{outcome.cut_short}_".strip()
    actions: List[Dict[str, Any]] = [*([{"type": "respond", "text": reply}] if reply else []), *proposal.actions]
    if not actions:
        actions = [{"type": "respond", "text": "(no response)"}]

    check_cancelled()
    return _decide(
        session, job_id, {"actions": actions}, reply,
        exec_ctx=proposal.exec_ctx,
        label_map=proposal.label_map,
        found_note_ids=proposal.found_note_ids,
        search_label=proposal.search_label,
        plan_mode=bool(turn_ctx.get("plan_mode")) or voice,
    )
