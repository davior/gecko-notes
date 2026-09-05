"""One assistant turn, from the request to the last edit.

A job API, not a request/response one, for the same reason video rendering is: the
work takes minutes and the panel that used to do it is unmounted the moment the user
leaves the note. POST creates a row and returns; the header polls `/api/activity`.

Planning used to be the exception — "it is fast, it streams into the chat" — and that
held for everything except the requests people actually care about. Write me an essay,
restructure these six notes: the model spends longer producing the plan than the run
spends executing it, and that was the one stretch a user could not walk away from. So
the turn starts here, not at Approve:

    POST   /runs               ask for something          -> planning
    POST   /runs/{id}/approve  yes, do that               -> running
    GET    /runs/{id}/preview  what it is saying so far
    GET    /runs/{id}/plan     the plan waiting on a decision
    GET    /runs?awaiting=1    turns parked for one
    DELETE /runs/{id}          stop

The browser still assembles the request body — cache breakpoints and all — and ships
it with the turn. See app/assistant/provider.py for why that half stayed put.
"""

import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from app.assistant import worker
from app.assistant.executor import touched_note_ids
from app.database import get_session
from app.jobs.runner import ACTIVE_STATUSES, set_fields
from app.models import AssistantRunJob, Note
from app.schemas import DataResponse, ListResponse, ActivityJobRead

router = APIRouter()

# A plan is capped when it is parsed (MAX_PLAN_ACTIONS); this is the backstop for a
# request that did not come from our own UI.
MAX_ACTIONS = 50

# Parked waiting for a person. Deliberately outside ACTIVE_STATUSES: see the note on
# AssistantRunJob for everything that follows from that.
AWAITING = "awaiting_approval"


class AssistantTurnRequest(BaseModel):
    """Everything a turn needs to run without a browser.

    `prompt_ctx` is the request body the browser assembled plus how to reach the
    provider; `exec_ctx` is which ids the plan may target; `turn_ctx` is the rest of
    what only a browser knows — the label map, whether plan mode is on, how this
    provider searches, whether the user is talking rather than typing.
    """

    prompt_ctx: Dict[str, Any] = {}
    exec_ctx: Dict[str, Any] = {}
    turn_ctx: Dict[str, Any] = {}
    note_id: Optional[str] = None
    session_id: Optional[str] = None


class ApproveRequest(BaseModel):
    """Which of the plan's steps to run.

    `action_indices` is the review modal's checkboxes. Omitted means all of them;
    `respond` actions are kept regardless, because the model's reply is not a step the
    user is choosing between.
    """

    action_indices: Optional[List[int]] = None


class PreviewRead(BaseModel):
    phase: str
    stage: str
    status: str
    text: str


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _job_for(session: Session, user_id: str, run_id: str) -> AssistantRunJob:
    job = session.get(AssistantRunJob, run_id)
    if not job or job.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Run not found"})
    return job


def _refuse_second_turn(session: Session, user_id: str, payload: AssistantTurnRequest) -> None:
    """One turn at a time per note, and per conversation.

    Two turns against one document would race over it, and two progress bars for one
    note is confusing rather than useful. The session arm matters just as much and was
    missing before: a turn started from the list view has no note at all, so the note
    check on its own let a whole class of them through.

    A parked plan does not block a new turn — the user may well ask for something else
    instead of approving it — because it is holding nothing while it waits.
    """
    clauses = []
    if payload.note_id:
        clauses.append(AssistantRunJob.note_id == payload.note_id)
    if payload.session_id:
        clauses.append(AssistantRunJob.session_id == payload.session_id)

    for clause in clauses:
        existing = session.exec(
            select(AssistantRunJob).where(
                AssistantRunJob.user_id == user_id,
                clause,
                AssistantRunJob.status.in_(ACTIVE_STATUSES),
            )
        ).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail={"code": "already_running", "message": "This note already has a turn running"},
            )


@router.post("/runs", response_model=DataResponse[ActivityJobRead], status_code=201)
def create_run(payload: AssistantTurnRequest, request: Request, session: Session = Depends(get_session)):
    """Start a turn. It begins by planning; what happens next is its own decision."""
    user_id = _get_user_id(request)

    if not (payload.prompt_ctx or {}).get("base_body"):
        raise HTTPException(
            status_code=400,
            detail={"code": "no_request", "message": "The turn carries nothing to send"},
        )

    note_title = ""
    if payload.note_id:
        note = session.get(Note, payload.note_id)
        if not note or note.user_id != user_id:
            raise HTTPException(
                status_code=404, detail={"code": "not_found", "message": "Note not found"}
            )
        note_title = note.title or "Untitled"

    _refuse_second_turn(session, user_id, payload)

    now = datetime.utcnow()
    job = AssistantRunJob(
        id=str(uuid.uuid4()),
        user_id=user_id,
        note_id=payload.note_id,
        session_id=payload.session_id,
        note_title=note_title,
        status="queued",
        phase="planning",
        stage="Queued",
        prompt_ctx=json.dumps(payload.prompt_ctx),
        exec_ctx=json.dumps(payload.exec_ctx),
        turn_ctx=json.dumps(payload.turn_ctx),
        # Nothing, because there is no plan yet to say what needs holding — and the
        # note this was asked from is not a good enough guess: most turns never write
        # it. The worker sets the real set the moment it has a plan.
        touched_note_ids="[]",
        created_at=now,
        updated_at=now,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    worker.enqueue(job.id)

    from app.jobs.registry import KINDS

    return DataResponse(data=KINDS["assistant"].to_activity(job))


@router.post("/runs/{run_id}/approve", response_model=DataResponse[ActivityJobRead])
def approve_run(
    run_id: str,
    payload: ApproveRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Run a plan that was waiting for a decision.

    The same row picks back up in its running phase, so the turn stays one line in the
    indicator and one thing to stop. This is where the note locks again.
    """
    user_id = _get_user_id(request)
    job = _job_for(session, user_id, run_id)

    if job.status != AWAITING:
        raise HTTPException(
            status_code=409,
            detail={"code": "not_awaiting", "message": "This turn is not waiting for approval"},
        )

    actions = _plan_of(job).get("actions") or []
    if payload.action_indices is not None:
        keep = set(payload.action_indices)
        # A `respond` action is the model's reply, not a step the user is choosing
        # between, so it survives whatever was ticked.
        actions = [a for i, a in enumerate(actions) if i in keep or a.get("type") == "respond"]
    if len(actions) > MAX_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail={"code": "plan_too_large", "message": f"A plan may have at most {MAX_ACTIONS} actions"},
        )
    if not any(a.get("type") != "respond" for a in actions):
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_plan", "message": "Nothing was selected to run"},
        )

    approved = {"actions": actions}
    set_fields(
        session, job,
        plan=json.dumps(approved),
        status="queued",
        phase="running",
        stage="Queued",
        detail="",
        touched_note_ids=json.dumps(
            touched_note_ids(approved, _json_of(job.exec_ctx, {}))
        ),
    )
    worker.enqueue(job.id)

    from app.jobs.registry import KINDS

    return DataResponse(data=KINDS["assistant"].to_activity(job))


@router.get("/runs/{run_id}/preview", response_model=DataResponse[PreviewRead])
def get_preview(run_id: str, request: Request, session: Session = Depends(get_session)):
    """The reply as it arrives.

    Its own endpoint rather than a field on the activity row: this grows to tens of
    kilobytes, and the header polls every job of every kind every two seconds. Only the
    panel showing this turn wants it, and only while it is being written.
    """
    user_id = _get_user_id(request)
    job = _job_for(session, user_id, run_id)
    return DataResponse(data=PreviewRead(
        phase=job.phase or "running",
        stage=job.stage or "",
        status=job.status,
        text=job.preview or "",
    ))


@router.get("/runs/{run_id}/plan", response_model=DataResponse[Dict[str, Any]])
def get_plan(run_id: str, request: Request, session: Session = Depends(get_session)):
    """The plan a parked turn is waiting on, with what the review modal needs to render
    it: the names for the ids it mentions, and any notes a search turned up."""
    user_id = _get_user_id(request)
    job = _job_for(session, user_id, run_id)
    turn_ctx = _json_of(job.turn_ctx, {})
    plan = _plan_of(job)
    return DataResponse(data={
        "plan": plan,
        "label_map": turn_ctx.get("label_map") or {},
        "found_note_ids": turn_ctx.get("found_note_ids") or [],
        "search_label": turn_ctx.get("search_label") or "",
        "session_id": job.session_id,
        "note_id": job.note_id,
        # Which notes approving would rewrite. The parked row itself holds nothing —
        # that is the point of `awaiting_approval` — so this is information, not a
        # lock: it lets the review modal warn when one of these has been edited since
        # the plan was asked for, before the edits are overwritten rather than after.
        # Derived here so the rule for what counts as a rewrite lives in one place.
        "would_touch_note_ids": touched_note_ids(plan, _json_of(job.exec_ctx, {})),
    })


@router.get("/runs", response_model=ListResponse[ActivityJobRead])
def list_runs(
    request: Request,
    active: int = 0,
    awaiting: int = 0,
    limit: int = 20,
    session: Session = Depends(get_session),
):
    """Recent turns. `awaiting=1` is how the panel finds a plan left waiting: a reload
    loses the store, and `/api/activity?active=1` deliberately does not list something
    that is holding nothing."""
    user_id = _get_user_id(request)
    from app.jobs.registry import KINDS

    query = select(AssistantRunJob).where(AssistantRunJob.user_id == user_id)
    if awaiting:
        query = query.where(AssistantRunJob.status == AWAITING)
    elif active:
        query = query.where(AssistantRunJob.status.in_(ACTIVE_STATUSES))
    capped = max(1, min(100, limit))
    query = query.order_by(AssistantRunJob.created_at.desc()).limit(capped)

    rows = [KINDS["assistant"].to_activity(row) for row in session.exec(query).all()]
    return ListResponse(data=rows, total=len(rows), limit=capped, offset=0)


@router.get("/runs/{run_id}", response_model=DataResponse[ActivityJobRead])
def get_run(run_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    from app.jobs.registry import KINDS

    return DataResponse(data=KINDS["assistant"].to_activity(_job_for(session, user_id, run_id)))


@router.delete("/runs/{run_id}", response_model=DataResponse[ActivityJobRead])
def cancel_run(run_id: str, request: Request, session: Session = Depends(get_session)):
    """Stop a turn, at whatever phase it has reached.

    A parked plan is dropped here too: declining it is a decision, and cancel_activity
    only knows how to stop something that is running.
    """
    user_id = _get_user_id(request)
    job = _job_for(session, user_id, run_id)

    if job.status == AWAITING:
        from app.assistant.worker import append_to_session
        from app.jobs.registry import KINDS

        set_fields(session, job, status="cancelled", phase="running", stage="", detail="Cancelled")
        # The chat is still showing "Plan ready — open the note to review it". Left
        # alone that reads as a plan still waiting, which it no longer is.
        try:
            append_to_session(session, job, "_Plan cancelled._")
        except Exception:  # bookkeeping must not fail the cancel
            pass
        return DataResponse(data=KINDS["assistant"].to_activity(job))

    from app.routers.activity import cancel_activity

    return cancel_activity("assistant", run_id, request, session)


def _plan_of(job: AssistantRunJob) -> Dict[str, Any]:
    plan = _json_of(job.plan, {"actions": []})
    return plan if isinstance(plan, dict) else {"actions": []}


def _json_of(raw: str, fallback: Any) -> Any:
    try:
        value = json.loads(raw or "")
    except (ValueError, TypeError):
        return fallback
    return value if value is not None else fallback
