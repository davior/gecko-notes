"""Everything the app is currently working on, in one place.

Long-running work used to be invisible the moment you navigated away from the view
that started it. Each kind had its own endpoint, its own polling, and its own
corner of the UI — so a render was visible in the header but a transcription died
with the component that started it.

This is the union over every job table (see `jobs/registry.py`), so the header can
show one list and poll for it in one request no matter how many kinds exist. The
per-kind endpoints stay where they are: `/api/video/jobs` still creates renders and
still returns the richer video shape its dialog needs. This is for reading and
stopping, not starting — starting a job is specific to the kind, and stays so.

Polled rather than streamed, for the reason `routers/video.py` already gives: a
dropped SSE stream cannot rebuild the UI's state after a page reload, and
`GET /api/activity?active=1` can.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session

from app.database import get_session
from app.jobs import registry
from app.jobs.runner import ACTIVE_STATUSES, set_fields
from app.schemas import DataResponse, ListResponse, ActivityJobRead

router = APIRouter()


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _kind_or_404(kind: str) -> registry.JobKind:
    found = registry.KINDS.get(kind)
    if not found:
        raise HTTPException(
            status_code=404,
            detail={"code": "unknown_kind", "message": f"No such job kind: {kind}"},
        )
    return found


@router.get("", response_model=ListResponse[ActivityJobRead])
def list_activity(
    request: Request,
    active: int = 0,
    limit: int = 25,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    capped = max(1, min(100, limit))
    jobs = registry.list_jobs(
        session, user_id, active_only=bool(active), limit=capped
    )
    return ListResponse(data=jobs, total=len(jobs), limit=capped, offset=0)


@router.get("/{kind}/{job_id}", response_model=DataResponse[ActivityJobRead])
def get_activity(
    kind: str,
    job_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    _kind_or_404(kind)
    job = registry.get_job(session, user_id, kind, job_id)
    if not job:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "Job not found"}
        )
    return DataResponse(data=job)


@router.delete("/{kind}/{job_id}", response_model=DataResponse[ActivityJobRead])
def cancel_activity(
    kind: str,
    job_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Stop a job, and stop it from the caller's point of view immediately.

    The row is marked cancelled here rather than waiting for the worker to notice,
    so anything derived from "is this job still active" — the indicator now, a
    locked note later — is released at once even if the worker is stuck inside a
    slow upstream call. Asking the worker to unwind is the second step, and the
    kind decides where its checkpoints are.
    """
    user_id = _get_user_id(request)
    job_kind = _kind_or_404(kind)

    row = session.get(job_kind.model, job_id)
    if not row or row.user_id != user_id:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "Job not found"}
        )

    if row.status in ACTIVE_STATUSES:
        if not job_kind.cancellable:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "not_cancellable",
                    "message": f"A {kind} job cannot be cancelled once it has started",
                },
            )
        fields = {"status": "cancelled"}
        if hasattr(row, "stage"):
            fields["stage"] = ""
        if hasattr(row, "detail"):
            fields["detail"] = "Cancelled"
        set_fields(session, row, **fields)
        job_kind.cancel(job_id)  # type: ignore[misc]
        session.refresh(row)

    return DataResponse(data=job_kind.to_activity(row))
