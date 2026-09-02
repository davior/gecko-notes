"""What kinds of background job exist, and how each one is read and cancelled.

The activity API is a union over every job table, and this is the only place that
knows what those tables are. Adding a kind is one `JobKind` entry: give it a table,
a way to turn a row into an `ActivityJobRead`, and a cancel function if it has one.
Nothing else — endpoint, store or indicator — needs to change.

Serialisation lives here rather than in each kind's router so that importing the
registry never pulls in a router (and its dependencies) just to read a row.
"""

import json
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Type

from sqlmodel import Session, select

from app.jobs.runner import ACTIVE_STATUSES, is_stale
from app.models import AssistantRunJob, TranscriptionJob, VideoRenderJob
from app.schemas import ActivityJobRead


class JobKind:
    """One row in the union: a table, a serializer, and how to stop it."""

    def __init__(
        self,
        key: str,
        model: Type[Any],
        to_activity: Callable[[Any], ActivityJobRead],
        cancel: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.key = key
        self.model = model
        self.to_activity = to_activity
        self.cancel = cancel

    @property
    def cancellable(self) -> bool:
        return self.cancel is not None


def _media_url(user_id: str, filename: Optional[str]) -> Optional[str]:
    return f"/media/{user_id}/{filename}" if filename else None


# ─── video renders ───────────────────────────────────────────────────────────


def _video_to_activity(job: VideoRenderJob) -> ActivityJobRead:
    try:
        options = json.loads(job.options or "{}") or {}
    except (ValueError, TypeError):
        options = {}

    return ActivityJobRead(
        id=job.id,
        kind="video",
        status=job.status,
        stage=job.stage or "",
        progress=job.progress or 0,
        detail=job.detail or "",
        title=job.note_title or "Video",
        note_id=job.note_id,
        note_title=job.note_title or "",
        # A render appends to the note only when it finishes; it does not hold the
        # document open, so the editor stays editable while it runs.
        locks_note=False,
        result_url=_media_url(job.user_id, job.result_filename),
        error_message=job.error_message,
        created_at=job.created_at,
        meta={
            "quality": job.quality or "full",
            "subtitle_url": _media_url(job.user_id, job.subtitle_filename),
            "thumbnail_url": _media_url(job.user_id, job.thumbnail_filename),
            "duration_seconds": job.duration_seconds,
            "size_bytes": job.size_bytes,
            # The editor reads these two to decide whether to drop a finished
            # render into the open document, and to avoid inserting it twice.
            "auto_insert": bool(options.get("insert_into_note", True)),
            "inserted": bool(job.inserted),
        },
    )


# ─── assistant runs ──────────────────────────────────────────────────────────


def _assistant_to_activity(job: AssistantRunJob) -> ActivityJobRead:
    try:
        touched = json.loads(job.touched_note_ids or "[]") or []
    except (ValueError, TypeError):
        touched = []

    return ActivityJobRead(
        id=job.id,
        kind="assistant",
        status=job.status,
        stage=job.stage or "",
        progress=job.progress or 0,
        detail=job.detail or "",
        title=job.note_title or "Assistant",
        note_id=job.note_id,
        note_title=job.note_title or "",
        # Unlike a render, a run rewrites the document itself — so the editor holds
        # every note it may touch read-only while it works. Two things end that: the
        # run finishing, and its heartbeat stopping (which releases the note
        # immediately rather than waiting for the sweeper, because a lock nobody can
        # clear is worse than no lock).
        locks_note=job.status in ACTIVE_STATUSES and not is_stale(job),
        error_message=job.error_message,
        created_at=job.created_at,
        meta={
            "session_id": job.session_id,
            # Every note this run may write, not just the one it is anchored to: a
            # plan can edit several, and each of them locks.
            "touched_note_ids": touched,
        },
    )


def _cancel_assistant(job_id: str) -> None:
    from app.assistant import worker as assistant_worker

    assistant_worker.cancel(job_id)


def _cancel_video(job_id: str) -> None:
    # Imported lazily: the video worker pulls in ffmpeg helpers and the renderer,
    # which the activity API has no reason to load just to list a row.
    from app.video import worker as video_worker

    video_worker.cancel(job_id)


# ─── transcriptions ──────────────────────────────────────────────────────────


def _transcription_to_activity(job: TranscriptionJob) -> ActivityJobRead:
    return ActivityJobRead(
        id=job.id,
        kind="transcription",
        status=job.status,
        stage=job.stage or "",
        progress=job.progress or 0,
        detail=job.detail or "",
        title=job.note_title or job.source_filename or "Transcript",
        note_id=job.note_id,
        note_title=job.note_title or "",
        # A transcript is appended to the note, not a rewrite of it, so there is no
        # reason to hold the document read-only while it runs.
        locks_note=False,
        result_url=_media_url(job.user_id, job.result_filename),
        error_message=job.error_message,
        created_at=job.created_at,
        meta={"source_filename": job.source_filename},
    )


def _cancel_transcription(job_id: str) -> None:
    from app.routers import transcription

    transcription.cancel(job_id)


KINDS: Dict[str, JobKind] = {
    "assistant": JobKind("assistant", AssistantRunJob, _assistant_to_activity, _cancel_assistant),
    "video": JobKind("video", VideoRenderJob, _video_to_activity, _cancel_video),
    "transcription": JobKind(
        "transcription", TranscriptionJob, _transcription_to_activity, _cancel_transcription
    ),
}


# ─── queries over the union ──────────────────────────────────────────────────


def list_jobs(
    session: Session,
    user_id: str,
    *,
    active_only: bool = False,
    limit: int = 25,
) -> List[ActivityJobRead]:
    """Recent jobs for one user across every kind, newest first.

    `active_only` is what the header polls on mount to pick work back up after a
    reload; the unfiltered form is what it polls while something is running, so it
    can see a job reach "done" instead of simply vanishing from the active list.
    """
    collected: List[ActivityJobRead] = []

    for kind in KINDS.values():
        query = select(kind.model).where(kind.model.user_id == user_id)
        if active_only:
            query = query.where(kind.model.status.in_(ACTIVE_STATUSES))
        query = query.order_by(kind.model.created_at.desc()).limit(limit)
        collected.extend(kind.to_activity(row) for row in session.exec(query).all())

    # created_at is required on every job table, but a row missing one must not
    # blow up the sort by comparing a datetime against a string.
    collected.sort(key=lambda job: job.created_at or datetime.min, reverse=True)
    return collected[:limit]


def note_lock_holder(session: Session, user_id: str, note_id: str) -> Optional[Any]:
    """The live job holding `note_id` read-only, if any.

    Derived from job rows rather than stored on the note, which is what makes a lock
    impossible to strand: cancelling a run — or its heartbeat simply stopping —
    releases the note at once, with no lock state to clean up and nothing to
    coordinate with the worker thread.
    """
    for kind in KINDS.values():
        if not hasattr(kind.model, "touched_note_ids"):
            continue
        rows = session.exec(
            select(kind.model).where(
                kind.model.user_id == user_id,
                kind.model.status.in_(ACTIVE_STATUSES),
            )
        ).all()
        for row in rows:
            if is_stale(row):
                continue
            try:
                touched = json.loads(row.touched_note_ids or "[]") or []
            except (ValueError, TypeError):
                continue
            if note_id in touched:
                return row
    return None


def get_job(
    session: Session, user_id: str, kind_key: str, job_id: str
) -> Optional[ActivityJobRead]:
    kind = KINDS.get(kind_key)
    if not kind:
        return None
    row = session.get(kind.model, job_id)
    if not row or row.user_id != user_id:
        return None
    return kind.to_activity(row)
