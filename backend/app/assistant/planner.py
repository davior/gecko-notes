"""Phase one: turning the user's request into a plan.

This used to happen in the browser, and the reasoning for leaving it there — "it is
fast, it streams into the chat, and the review modal is a conversation with the user" —
held for everything except the requests people actually care about. Write me an essay,
restructure these six notes: the model spends longer producing the plan than the run
spends executing it, and the whole of that was the one stretch a user could not walk
away from, because the panel's unmount cleanup aborts the request.

So planning runs here, and the turn is one job from the first token to the last edit.

Three things make it more than "call the provider and parse":

  A turn that searches has to resolve the search and ask again, and the notes it finds
  have to widen `valid_note_ids` — the executor refuses ids that were not in context,
  which would include the very notes the model just went looking for.

  The reply has to be watched as it arrives. A four-minute call that shows nothing is
  the complaint this change exists to answer, so the text is written onto the job row
  as it streams and the panel polls for it.

  What happens next is a decision, not a step: a plan that only talks is finished and
  gets posted to the chat; a plan with edits either waits for approval or runs straight
  on, and only the second holds the note.

`base_body` is never rebuilt. Every round appends to it — the searches asked for, then
what they returned — so the cached prefix survives the whole turn.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from sqlmodel import Session

from app.assistant.continuation import (
    MAX_TURN_CONTINUATIONS,
    continuation_body,
    finalize_plan_text,
    is_stalled_turn,
)
from app.assistant.executor import touched_note_ids
from app.assistant.plan_parse import RETRIEVAL_TYPES, is_respond_only, parse_plan, respond_text
from app.assistant.provider import PromptContext, call_provider
from app.assistant.retrieve import (
    MAX_RETRIEVAL_ROUNDS,
    RetrievalContext,
    run_retrieval_round,
)
from app.database import engine
from app.jobs.runner import set_fields as _set
from app.models import AssistantRunJob

logger = logging.getLogger(__name__)

# How much of the progress bar planning owns. The rest is writing, then applying.
PLANNING_SHARE = 35

# How often the streaming reply is written to the job row. Each flush is a database
# commit, and the panel polls no faster than this anyway.
PREVIEW_INTERVAL_SECONDS = 1.0

# A reply longer than this is already at the model's output cap; the preview stops
# growing rather than turning a chat bubble into a memory problem.
MAX_PREVIEW_CHARS = 60_000

# Said in the chat when a plan comes back needing a decision and nobody is looking.
AWAITING_NOTICE = "_Plan ready — open the note to review it._"


class Cancelled(Exception):
    """Raised at a checkpoint when the turn has been stopped."""


class PlanningResult:
    """What planning decided.

    `run_now` is the only caller-visible question: carry straight on into writing and
    applying, or stop here. Everything else has already been written to the row.
    """

    __slots__ = ("run_now",)

    def __init__(self, run_now: bool) -> None:
        self.run_now = run_now


class _Preview:
    """The reply so far, written onto the job row as it streams.

    Throttled because every flush is a commit; reset between rounds because each
    planning call is a fresh reply, and showing the previous round's text under a new
    one reads as the model repeating itself.
    """

    def __init__(self, job_id: str, interval: float = PREVIEW_INTERVAL_SECONDS) -> None:
        self.job_id = job_id
        self.interval = interval
        self.buffer = ""
        self._last = 0.0

    def __call__(self, chunk: str) -> None:
        if len(self.buffer) < MAX_PREVIEW_CHARS:
            self.buffer += chunk
        now = time.monotonic()
        if now - self._last < self.interval:
            return
        self._last = now
        self.flush()

    def reset(self) -> None:
        self.buffer = ""
        self._last = 0.0
        self.flush()

    def flush(self) -> None:
        with Session(engine) as session:
            row = session.get(AssistantRunJob, self.job_id)
            if row:
                _set(session, row, preview=self.buffer[:MAX_PREVIEW_CHARS])


def _load(raw: str, fallback: Any) -> Any:
    try:
        value = json.loads(raw or "")
    except (ValueError, TypeError):
        return fallback
    return value if value is not None else fallback


def _one_call(
    session: Session,
    user_id: str,
    ctx: PromptContext,
    turns: List[Dict[str, Any]],
    preview: _Preview,
    check_cancelled: Callable[[], None],
) -> str:
    """One planning call, finished if the provider left it open.

    A continuation only ever appends to the body, so the cached prefix still hits; its
    deltas go to the same preview as the first round's, which is what the browser did
    too — the live bubble shows the stalled commentary and then the real reply.
    """
    check_cancelled()
    preview.reset()
    body = ctx.body_for({"messages": turns})
    data = call_provider(session, user_id, ctx, body, preview)

    for _ in range(MAX_TURN_CONTINUATIONS):
        if not is_stalled_turn(data):
            break
        check_cancelled()
        data = call_provider(session, user_id, ctx, continuation_body(body, data), preview)

    preview.flush()
    return finalize_plan_text(data)


def run_planning(
    session: Session,
    job_id: str,
    *,
    check_cancelled: Callable[[], None],
    report: Callable[[str, int, str], None],
) -> PlanningResult:
    """Plan the turn, and decide what happens to it.

    Returns run_now=True only when the plan has real work and the user asked not to be
    shown it first — the one path where the note stays locked from the request all the
    way through to the last edit.
    """
    job = session.get(AssistantRunJob, job_id)
    if not job:
        return PlanningResult(False)

    user_id = job.user_id
    ctx = PromptContext(_load(job.prompt_ctx, {}))
    exec_ctx: Dict[str, Any] = _load(job.exec_ctx, {})
    turn_ctx: Dict[str, Any] = _load(job.turn_ctx, {})
    label_map: Dict[str, str] = dict(turn_ctx.get("label_map") or {})

    retrieval_ctx = RetrievalContext(
        current_folder_id=exec_ctx.get("current_folder_id"),
        folder_names=turn_ctx.get("folder_names") or {},
        use_summaries=bool(turn_ctx.get("use_summaries")),
    )
    # Anthropic searches inside its own model call, so the action is never offered
    # there and running it here would repeat a search the model already did.
    web_search_enabled = turn_ctx.get("web_search_mode") == "action"

    preview = _Preview(job_id)
    turns: List[Dict[str, Any]] = []
    found_note_ids: List[str] = []
    search_label = ""
    plan: Dict[str, Any] = {"actions": []}
    raw = ""

    report("Planning", 1, "")

    for round_index in range(MAX_RETRIEVAL_ROUNDS + 1):
        raw = _one_call(session, user_id, ctx, turns, preview, check_cancelled)
        plan = parse_plan(raw)

        retrieval = [a for a in plan.get("actions") or [] if a.get("type") in RETRIEVAL_TYPES]
        if not retrieval or round_index == MAX_RETRIEVAL_ROUNDS:
            break

        check_cancelled()
        report(
            "Planning",
            _planning_progress(round_index),
            f"searching (round {round_index + 1})",
        )
        result = run_retrieval_round(
            session, user_id, retrieval, retrieval_ctx,
            web_search_enabled=web_search_enabled,
        )
        turns.extend(result.turns)
        # The executor refuses ids that were not in context, so a note the search just
        # found has to be added or the very next action against it would be skipped.
        for note_id in result.found_note_ids:
            if note_id not in found_note_ids:
                found_note_ids.append(note_id)
        label_map.update(result.found_labels)
        search_label = result.search_label or search_label

    if found_note_ids:
        exec_ctx["valid_note_ids"] = list(
            dict.fromkeys([*(exec_ctx.get("valid_note_ids") or []), *found_note_ids])
        )

    # Retrieval actions are resolved above and never executed. One can also survive
    # here when the model asked for a search it was never offered, so this doubles as
    # the guard for that.
    leftover = [a for a in plan.get("actions") or [] if a.get("type") in RETRIEVAL_TYPES]
    actions = [a for a in plan.get("actions") or [] if a.get("type") not in RETRIEVAL_TYPES]
    if leftover and not actions:
        actions = [{"type": "respond", "text": _nothing_found(leftover)}]
    plan = {"actions": actions}

    check_cancelled()
    return _decide(
        session, job_id, plan, raw,
        exec_ctx=exec_ctx,
        label_map=label_map,
        found_note_ids=found_note_ids,
        search_label=search_label,
        plan_mode=bool(turn_ctx.get("plan_mode")) or bool(turn_ctx.get("voice")),
    )


def _planning_progress(round_index: int) -> int:
    """Spread the planning share across the rounds a turn is allowed."""
    step = PLANNING_SHARE / (MAX_RETRIEVAL_ROUNDS + 1)
    return max(1, int(step * (round_index + 1)))


def _nothing_found(leftover: List[Dict[str, Any]]) -> str:
    """What to say when the searches were the whole plan and turned up nothing."""
    if all(a.get("type") == "find_notes" for a in leftover):
        return "_(No matching notes found.)_"
    return (
        "_(The search didn't turn up an answer — try rephrasing, or check "
        "Settings → AI → Assistant for web search.)_"
    )


def _decide(
    session: Session,
    job_id: str,
    plan: Dict[str, Any],
    raw: str,
    *,
    exec_ctx: Dict[str, Any],
    label_map: Dict[str, str],
    found_note_ids: List[str],
    search_label: str,
    plan_mode: bool,
) -> PlanningResult:
    """Write the plan to the row and pick the turn's next state."""
    row = session.get(AssistantRunJob, job_id)
    if not row:
        return PlanningResult(False)
    # The preview has been writing through its own session, so this one's copy is
    # stale — and clearing a field it still believes is empty emits no UPDATE at all,
    # leaving the half-written reply on the row under the finished plan.
    session.refresh(row)

    turn_ctx = _load(row.turn_ctx, {})
    turn_ctx["label_map"] = label_map
    if found_note_ids:
        turn_ctx["found_note_ids"] = found_note_ids
    if search_label:
        turn_ctx["search_label"] = search_label

    shared = {
        "plan": json.dumps(plan),
        "plan_raw": raw[:MAX_PREVIEW_CHARS],
        "exec_ctx": json.dumps(exec_ctx),
        "turn_ctx": json.dumps(turn_ctx),
        "preview": "",
    }

    # A plan that only talks is already finished: there is nothing to approve and
    # nothing to apply, so the answer goes into the chat and the turn ends. This is
    # what makes an ordinary question behave like an ordinary question.
    if is_respond_only(plan):
        _set(
            session, row,
            status="done", phase="running", stage="", progress=100, detail="",
            touched_note_ids="[]",
            **shared,
        )
        _append_answer(session, row, respond_text(plan))
        return PlanningResult(False)

    if plan_mode:
        # Parked, not running: `awaiting_approval` is outside ACTIVE_STATUSES, so the
        # note unlocks, the sweeper leaves it alone, and a restart does not requeue it.
        _set(
            session, row,
            status="awaiting_approval", phase="awaiting_approval",
            stage="Awaiting approval", progress=PLANNING_SHARE, detail="",
            touched_note_ids="[]",
            **shared,
        )
        _append_answer(session, row, _awaiting_message(plan))
        return PlanningResult(False)

    # Plan mode off: straight on into the run, without ever releasing the note. The
    # lock set at the start of the turn covered only the open note; now that the plan
    # exists, it covers everything the plan will write.
    _set(
        session, row,
        status="processing", phase="running", stage="Writing",
        progress=PLANNING_SHARE, detail="",
        touched_note_ids=json.dumps(touched_note_ids(plan, exec_ctx, row.note_id)),
        **shared,
    )
    # The model's reply is already written — it is sitting in the plan's respond
    # actions — so it goes into the chat now rather than waiting minutes for the run
    # to finish. build_result_summary deliberately does not repeat it.
    _append_answer(session, row, respond_text(plan))
    return PlanningResult(True)


def _awaiting_message(plan: Dict[str, Any]) -> str:
    """What the chat says while a plan waits for a decision.

    The model's own reply comes first when it wrote one: it answered the question, and
    that answer should not be held hostage to the edits it also proposed.
    """
    return "\n\n".join(part for part in (respond_text(plan), AWAITING_NOTICE) if part)


def _append_answer(session: Session, job: AssistantRunJob, text: str) -> None:
    from app.assistant.worker import append_to_session

    if not text.strip():
        return
    try:
        append_to_session(session, job, text)
    except Exception:
        # A finished turn must not be turned into a failure by bookkeeping.
        logger.exception("Could not write the reply for turn %s into its session", job.id)


__all__ = ["run_planning", "PlanningResult", "PLANNING_SHARE", "AWAITING_NOTICE"]
