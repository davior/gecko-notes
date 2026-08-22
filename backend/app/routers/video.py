"""Article-to-video rendering endpoints.

Renders are long — minutes, not seconds — so this is a job API, not a
request/response one: POST creates a row and returns immediately, and the client
polls. That also survives a page reload, which is why progress is polled rather
than streamed: `GET /jobs?active=1` lets the UI rebuild its state after a
refresh, which a dropped SSE stream cannot.
"""

import json
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlmodel import Session, select

from app.database import get_session
from app.models import Note, User, VideoRenderJob
from app.routers.media import MEDIA_DIR
from app.schemas import (
    DataResponse, ListResponse, VideoEstimateRead, VideoRenderJobRead, VideoRenderRequest,
)
from app.video import ffmpeg as F
from app.video import worker
from app.video.options import RenderOptions
from app.video.renderer import estimate

router = APIRouter()

ACTIVE_STATUSES = ("queued", "processing")


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _media_url(user_id: str, filename: Optional[str]) -> Optional[str]:
    return f"/media/{user_id}/{filename}" if filename else None


def _auto_insert(job: VideoRenderJob) -> bool:
    try:
        return bool((json.loads(job.options or "{}") or {}).get("insert_into_note", True))
    except (ValueError, TypeError):
        return True


def _to_read(job: VideoRenderJob) -> VideoRenderJobRead:
    return VideoRenderJobRead(
        id=job.id,
        note_id=job.note_id,
        status=job.status,
        stage=job.stage or "",
        progress=job.progress or 0,
        detail=job.detail or "",
        quality=job.quality or "full",
        note_title=job.note_title or "",
        result_url=_media_url(job.user_id, job.result_filename),
        subtitle_url=_media_url(job.user_id, job.subtitle_filename),
        thumbnail_url=_media_url(job.user_id, job.thumbnail_filename),
        duration_seconds=job.duration_seconds,
        size_bytes=job.size_bytes,
        error_message=job.error_message,
        created_at=job.created_at,
        auto_insert=_auto_insert(job),
        inserted=bool(job.inserted),
    )


def _owned_note(session: Session, note_id: str, user_id: str) -> Note:
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    return note


def _parse_options(raw: dict) -> RenderOptions:
    try:
        return RenderOptions.model_validate(raw or {})
    except ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_options", "message": f"Invalid render options: {exc.error_count()} problem(s)"},
        )


@router.post("/jobs", response_model=DataResponse[VideoRenderJobRead], status_code=201)
def create_job(payload: VideoRenderRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    if not F.ffmpeg_available():
        raise HTTPException(
            status_code=503,
            detail={"code": "ffmpeg_missing", "message": "ffmpeg is not installed on the server"},
        )

    note = _owned_note(session, payload.note_id, user_id)
    options = _parse_options(payload.options)

    # One render per note at a time: a second one would only queue behind the
    # first, and two progress bars for the same note is confusing rather than useful.
    existing = session.exec(
        select(VideoRenderJob).where(
            VideoRenderJob.user_id == user_id,
            VideoRenderJob.note_id == payload.note_id,
            VideoRenderJob.status.in_(ACTIVE_STATUSES),
        )
    ).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail={"code": "already_rendering", "message": "This note is already being rendered"},
        )

    now = datetime.utcnow()
    job = VideoRenderJob(
        id=str(uuid.uuid4()),
        user_id=user_id,
        note_id=note.id,
        note_title=note.title or "Untitled",
        status="queued",
        stage="Queued",
        options=json.dumps(options.model_dump()),
        quality="preview" if payload.quality == "preview" else "full",
        created_at=now,
        updated_at=now,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    worker.enqueue(job.id)
    return DataResponse(data=_to_read(job))


@router.get("/jobs", response_model=ListResponse[VideoRenderJobRead])
def list_jobs(
    request: Request,
    note_id: Optional[str] = None,
    active: int = 0,
    limit: int = 20,
    session: Session = Depends(get_session),
):
    """Recent jobs for the caller. `active=1` is what the UI polls on mount to
    pick a render back up after a page reload."""
    user_id = _get_user_id(request)
    query = select(VideoRenderJob).where(VideoRenderJob.user_id == user_id)
    if note_id:
        query = query.where(VideoRenderJob.note_id == note_id)
    if active:
        query = query.where(VideoRenderJob.status.in_(ACTIVE_STATUSES))
    capped = max(1, min(100, limit))
    query = query.order_by(VideoRenderJob.created_at.desc()).limit(capped)
    rows = [_to_read(j) for j in session.exec(query).all()]
    return ListResponse(data=rows, total=len(rows), limit=capped, offset=0)


@router.get("/jobs/{job_id}", response_model=DataResponse[VideoRenderJobRead])
def get_job(job_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    job = session.get(VideoRenderJob, job_id)
    if not job or job.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found"})
    return DataResponse(data=_to_read(job))


@router.delete("/jobs/{job_id}", response_model=DataResponse[VideoRenderJobRead])
def cancel_job(job_id: str, request: Request, session: Session = Depends(get_session)):
    """Cancel a queued or running render. A running one stops at its next
    segment boundary and its scratch directory is removed."""
    user_id = _get_user_id(request)
    job = session.get(VideoRenderJob, job_id)
    if not job or job.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found"})

    if job.status in ACTIVE_STATUSES:
        worker.cancel(job_id)
        job.status = "cancelled"
        job.stage = ""
        job.detail = "Cancelled"
        job.updated_at = datetime.utcnow()
        session.add(job)
        session.commit()
        session.refresh(job)
    return DataResponse(data=_to_read(job))


@router.post("/estimate", response_model=DataResponse[VideoEstimateRead])
def estimate_render(payload: VideoRenderRequest, request: Request, session: Session = Depends(get_session)):
    """Segment the note without rendering, so the dialog can show how many
    segments and how much narration a render would involve before it is paid for."""
    user_id = _get_user_id(request)
    note = _owned_note(session, payload.note_id, user_id)
    options = _parse_options(payload.options)
    user = session.get(User, user_id)

    shots, chars, seconds, warnings = estimate(
        user_id=user_id,
        media_dir=MEDIA_DIR,
        note_content=note.content or "[]",
        note_title=note.title or "Untitled",
        author=(user.username if user else "") or "",
        options=options,
    )
    return DataResponse(data=VideoEstimateRead(
        shots=shots, narration_chars=chars,
        estimated_seconds=round(seconds, 1), warnings=warnings,
    ))
