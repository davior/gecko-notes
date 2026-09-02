"""Running an approved AI-assistant plan.

A job API, not a request/response one, for the same reason video rendering is: a plan
that writes an essay takes minutes, and the panel that used to run it in the browser
is unmounted the moment the user leaves the note. POST creates a row and returns; the
header polls `/api/activity`.

Planning stays in the browser. It is fast, it streams into the chat, and the review
modal is a conversation with the user. Only what happens after Approve lands here.
"""

import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from app.assistant import worker
from app.database import get_session
from app.jobs.runner import ACTIVE_STATUSES
from app.models import AssistantRunJob, Note
from app.schemas import DataResponse, ListResponse, ActivityJobRead

router = APIRouter()

# A plan is capped client-side (MAX_PLAN_ACTIONS); this is the backstop for a request
# that did not come from our own UI.
MAX_ACTIONS = 50


class AssistantRunRequest(BaseModel):
    """The approved plan, plus everything needed to write and apply it without a browser."""

    plan: Dict[str, Any]
    # Provider routing and the request body the browser already assembled, with one
    # follow-up pair per deferred step. See app/assistant/provider.py for why the
    # body is shipped rather than rebuilt.
    prompt_ctx: Dict[str, Any] = {}
    # The PlanExecContext minus the live editor: which ids this plan may target.
    exec_ctx: Dict[str, Any] = {}
    note_id: Optional[str] = None
    session_id: Optional[str] = None


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _touched_note_ids(payload: AssistantRunRequest) -> List[str]:
    """Every note this run might write, so the editor knows what to hold read-only.

    Derived from the plan's targets rather than trusting a client-supplied list, and
    intersected with the ids the run is allowed to touch — a note the plan names but
    the context does not contain would be refused by the executor anyway.
    """
    allowed = set(payload.exec_ctx.get("valid_note_ids") or [])
    current = payload.exec_ctx.get("current_note_id")
    touched = set()
    for action in payload.plan.get("actions") or []:
        for key in ("noteId", "parentId"):
            value = action.get(key)
            if not isinstance(value, str):
                continue
            if value in allowed:
                touched.add(value)
            elif value.lower() in ("current", "this", "thisnote", "this_note") and current:
                touched.add(current)
            elif len(allowed) == 1:
                # Mirrors the executor's single-note fallback.
                touched.update(allowed)
    if payload.note_id:
        touched.add(payload.note_id)
    return sorted(touched)


@router.post("/runs", response_model=DataResponse[ActivityJobRead], status_code=201)
def create_run(payload: AssistantRunRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)

    actions = payload.plan.get("actions")
    if not isinstance(actions, list) or not actions:
        raise HTTPException(
            status_code=400,
            detail={"code": "empty_plan", "message": "The plan has no actions to run"},
        )
    if len(actions) > MAX_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail={"code": "plan_too_large", "message": f"A plan may have at most {MAX_ACTIONS} actions"},
        )

    note_title = ""
    if payload.note_id:
        note = session.get(Note, payload.note_id)
        if not note or note.user_id != user_id:
            raise HTTPException(
                status_code=404, detail={"code": "not_found", "message": "Note not found"}
            )
        note_title = note.title or "Untitled"

        # One run per note at a time: a second would race the first over the same
        # document, and two progress bars for one note is confusing rather than useful.
        existing = session.exec(
            select(AssistantRunJob).where(
                AssistantRunJob.user_id == user_id,
                AssistantRunJob.note_id == payload.note_id,
                AssistantRunJob.status.in_(ACTIVE_STATUSES),
            )
        ).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail={"code": "already_running", "message": "This note already has a plan running"},
            )

    now = datetime.utcnow()
    job = AssistantRunJob(
        id=str(uuid.uuid4()),
        user_id=user_id,
        note_id=payload.note_id,
        session_id=payload.session_id,
        note_title=note_title,
        status="queued",
        stage="Queued",
        plan=json.dumps(payload.plan),
        prompt_ctx=json.dumps(payload.prompt_ctx),
        exec_ctx=json.dumps(payload.exec_ctx),
        touched_note_ids=json.dumps(_touched_note_ids(payload)),
        created_at=now,
        updated_at=now,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    worker.enqueue(job.id)

    from app.jobs.registry import KINDS

    return DataResponse(data=KINDS["assistant"].to_activity(job))


@router.get("/runs", response_model=ListResponse[ActivityJobRead])
def list_runs(
    request: Request,
    active: int = 0,
    limit: int = 20,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    from app.jobs.registry import KINDS

    query = select(AssistantRunJob).where(AssistantRunJob.user_id == user_id)
    if active:
        query = query.where(AssistantRunJob.status.in_(ACTIVE_STATUSES))
    capped = max(1, min(100, limit))
    query = query.order_by(AssistantRunJob.created_at.desc()).limit(capped)

    rows = [KINDS["assistant"].to_activity(row) for row in session.exec(query).all()]
    return ListResponse(data=rows, total=len(rows), limit=capped, offset=0)


@router.get("/runs/{run_id}", response_model=DataResponse[ActivityJobRead])
def get_run(run_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    from app.jobs.registry import KINDS

    job = session.get(AssistantRunJob, run_id)
    if not job or job.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Run not found"})
    return DataResponse(data=KINDS["assistant"].to_activity(job))


@router.delete("/runs/{run_id}", response_model=DataResponse[ActivityJobRead])
def cancel_run(run_id: str, request: Request, session: Session = Depends(get_session)):
    """Stop a run. `DELETE /api/activity/assistant/{id}` does the same thing; this
    exists so the assistant has a complete API of its own."""
    from app.routers.activity import cancel_activity

    return cancel_activity("assistant", run_id, request, session)
