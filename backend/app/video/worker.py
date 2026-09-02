"""The render queue.

The queue, worker threads, cancellation and restart recovery are `jobs/runner.py`
now — this file is what a render actually *is*: segmenting the note, narrating it,
encoding, and filing the result. The reasoning for running it on threads rather
than FastAPI's BackgroundTasks moved with the machinery and is documented there.

Concurrency defaults to one and is settable with RENDER_MAX_CONCURRENCY.
"""

import asyncio
import json
import logging
import os
import shutil
import threading
import uuid
from datetime import datetime, timedelta
from typing import Optional, Set

from sqlmodel import Session, select

from app.database import engine
from app.jobs.runner import JobQueue, int_env, progress_reporter
from app.jobs.runner import readable_error as _readable_error
from app.jobs.runner import set_fields as _set
from app.models import Note, NoteAsset, User, VideoRenderJob
from app.video import ffmpeg as F
from app.video.options import RenderOptions
from app.video.renderer import RenderCancelled, WORK_ROOT_NAME, render

logger = logging.getLogger(__name__)


MEDIA_DIR = os.getenv("MEDIA_DIR") or ""
MAX_CONCURRENCY = int_env("RENDER_MAX_CONCURRENCY", 1)
MAX_SHOTS = int_env("VIDEO_MAX_SHOTS", 200)
MAX_NARRATION_CHARS = int_env("VIDEO_MAX_NARRATION_CHARS", 60_000)
RETENTION_DAYS = int_env("VIDEO_JOB_RETENTION_DAYS", 14)


def cancel(job_id: str) -> None:
    """Ask a render to stop. A queued one never starts; a running one unwinds at
    its next progress checkpoint, which is between shots."""
    _renders.cancel(job_id)


def is_cancelled(job_id: str) -> bool:
    return _renders.is_cancelled(job_id)


def enqueue(job_id: str) -> None:
    _renders.enqueue(job_id)


def _media_dir() -> str:
    # Read lazily: MEDIA_DIR is resolved the same way in four modules and the
    # env var is set by compose, so import order must not matter.
    from app.routers.media import MEDIA_DIR as resolved
    return resolved


def _tts_caller(user_id: str):
    """A sync `text -> mp3 bytes` callable for the renderer.

    Wraps the same synthesis core the read-aloud endpoint uses, including its
    disk cache — which is what makes a preview render followed by a full render
    bill for the narration only once. Each call opens its own session because
    this runs on a worker thread, not in a request.
    """
    from app.routers.settings import synthesize_tts_bytes

    def call(text: str) -> bytes:
        with Session(engine) as session:
            data, _media_type = asyncio.run(synthesize_tts_bytes(session, user_id, text))
            return data

    return call


def _attach_to_note(session: Session, job: VideoRenderJob, url: str) -> bool:
    """Append the finished video to its note as a playable block.

    Done here rather than in the browser so the result is not lost when the tab
    is closed, the laptop sleeps, or the network drops mid-render — a render
    takes minutes and nobody should have to sit and watch it.

    The note is re-read at this moment rather than reused from the start of the
    job, and the block is appended rather than the document rewritten, so edits
    made while the render was running survive. An editor still open on the note
    checks for this URL before inserting, so the block lands exactly once either
    way.
    """
    note = session.get(Note, job.note_id)
    if not note or note.user_id != job.user_id:
        return False
    try:
        blocks = json.loads(note.content or "[]")
    except (ValueError, TypeError):
        return False
    if not isinstance(blocks, list):
        return False
    if any(
        isinstance(b, dict) and isinstance(b.get("props"), dict) and b["props"].get("url") == url
        for b in blocks
    ):
        return True  # already there — an open editor got to it first

    blocks.append({
        "id": str(uuid.uuid4()),
        "type": "videoFile",
        "props": {"url": url, "name": f"Video — {note.title or 'note'}"},
        "children": [],
    })
    note.content = json.dumps(blocks)
    note.modified_at = datetime.utcnow()
    session.add(note)
    session.commit()
    return True


def _register_exports(session: Session, job: VideoRenderJob, result, note_title: str) -> None:
    """File a finished render, its subtitles and its poster in the note's Assets.

    Registered whether or not the video was inserted into the note, which is the point:
    a render the user chose not to embed would otherwise be invisible and, worse, would
    be deleted by _sweep_old_artifacts once it aged past the retention window.
    """
    from app.asset_utils import ORIGIN_EXPORT, register_asset

    label = note_title or "note"
    artifacts = (
        (result.video_filename, f"Video — {label}"),
        (result.subtitle_filename, f"Subtitles — {label}"),
        (result.thumbnail_filename, f"Thumbnail — {label}"),
    )
    for filename, display_name in artifacts:
        if not filename:
            continue
        try:
            register_asset(
                session,
                user_id=job.user_id,
                note_id=job.note_id,
                url=f"/media/{job.user_id}/{filename}",
                original_name=display_name,
                origin=ORIGIN_EXPORT,
            )
        except Exception:
            # A finished render must not be turned into a failure by bookkeeping.
            logger.exception("Could not register export %s for job %s", filename, job.id)


def _run_job(job_id: str) -> None:
    with Session(engine) as session:
        job = session.get(VideoRenderJob, job_id)
        if not job:
            return
        if is_cancelled(job_id):
            _set(session, job, status="cancelled", stage="", detail="Cancelled")
            return

        note = session.get(Note, job.note_id)
        if not note or note.user_id != job.user_id:
            _set(session, job, status="error", error_message="The note no longer exists")
            return
        user = session.get(User, job.user_id)
        author = (user.username if user else "") or ""

        _set(session, job, status="processing", stage="Preparing", progress=1, detail="")

        try:
            options = RenderOptions.model_validate(json.loads(job.options or "{}"))
        except Exception as exc:
            _set(session, job, status="error", error_message=f"Invalid render options: {exc}"[:500])
            return

        # Reports progress and doubles as the cancellation checkpoint: a render
        # unwinds between shots, wherever it happens to be reporting from.
        def raise_cancelled() -> None:
            raise RenderCancelled()

        progress = progress_reporter(_renders, job_id, raise_cancelled)

        try:
            result = render(
                job_id=job_id,
                user_id=job.user_id,
                media_dir=_media_dir(),
                note_content=note.content or "[]",
                note_title=note.title or "Untitled",
                author=author,
                options=options,
                preview=(job.quality == "preview"),
                tts=_tts_caller(job.user_id),
                progress=progress,
                max_shots=MAX_SHOTS,
                max_narration_chars=MAX_NARRATION_CHARS,
            )
        except RenderCancelled:
            session.rollback()
            row = session.get(VideoRenderJob, job_id)
            if row:
                _set(session, row, status="cancelled", stage="", progress=0, detail="Cancelled")
            return
        except Exception as exc:
            logger.exception("Video render %s failed", job_id)
            session.rollback()
            row = session.get(VideoRenderJob, job_id)
            if row:
                _set(session, row, status="error", stage="", error_message=_readable_error(exc)[:500])
            return

        row = session.get(VideoRenderJob, job_id)
        if not row:
            return

        inserted = False
        if options.insert_into_note:
            try:
                inserted = _attach_to_note(
                    session, row, f"/media/{row.user_id}/{result.video_filename}",
                )
            except Exception:
                # The video itself is fine and downloadable; failing to attach it
                # must not turn a finished render into an error.
                logger.exception("Could not attach video from job %s to its note", job_id)

        _set(
            session, row,
            status="done", stage="", progress=100,
            detail="; ".join(result.warnings)[:500] if result.warnings else "",
            result_filename=result.video_filename,
            subtitle_filename=result.subtitle_filename,
            thumbnail_filename=result.thumbnail_filename,
            duration_seconds=round(result.duration, 3),
            size_bytes=result.size_bytes,
            inserted=inserted,
        )

        _register_exports(session, row, result, note.title or "Untitled")


def _sweep_old_artifacts() -> None:
    """Delete render output nobody kept.

    A rendered article is a large file and the app has no other garbage
    collection, so old jobs' artefacts are removed — unless the video was
    inserted into a note, in which case it is that note's media now.
    """
    if RETENTION_DAYS <= 0:
        return
    try:
        media_dir = _media_dir()
        shutil.rmtree(os.path.join(media_dir, WORK_ROOT_NAME), ignore_errors=True)

        from app.routers.notes import extract_media_urls

        cutoff = datetime.utcnow() - timedelta(days=RETENTION_DAYS)
        with Session(engine) as session:
            stale = session.exec(
                select(VideoRenderJob).where(VideoRenderJob.updated_at < cutoff)
            ).all()
            if not stale:
                return
            in_use: Set[str] = set()
            for note in session.exec(select(Note)).all():
                in_use.update(extract_media_urls(note.content or ""))
            # A render kept in a note's Assets but not embedded in its body is still
            # wanted — the Assets tab is where the user curates it, not this sweep.
            in_use.update(session.exec(select(NoteAsset.url)).all())

            removed = 0
            for job in stale:
                names = [job.result_filename, job.subtitle_filename, job.thumbnail_filename]
                if any(n and f"/media/{job.user_id}/{n}" in in_use for n in names):
                    continue
                for name in names:
                    if not name:
                        continue
                    try:
                        os.remove(os.path.join(media_dir, job.user_id, name))
                        removed += 1
                    except OSError:
                        pass
                session.delete(job)
            session.commit()
            if removed:
                logger.info("Swept %d stale video render artefact(s)", removed)
    except Exception:
        logger.exception("Video render artefact sweep failed")


# Defined after _run_job so the queue can be handed the real callable.
_renders = JobQueue(
    VideoRenderJob, _run_job, name="video-render", concurrency=MAX_CONCURRENCY
)


def start() -> None:
    """Start the render worker(s). Called once from the app lifespan."""
    if not F.ffmpeg_available():
        logger.warning("ffmpeg/ffprobe not found — article-to-video rendering is unavailable")

    threading.Thread(target=_sweep_old_artifacts, daemon=True, name="video-sweep").start()
    _renders.start()
