import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

import fal_client
import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session

from app.database import engine
from app.jobs.runner import JobQueue, int_env, set_fields as _set
from app.models import Note, TranscriptionJob
from app.routers.settings import _record_usage, compute_fal_cost, load_fal_api_key, load_speech_config
from app.schemas import DataResponse, TranscriptionJobRead

router = APIRouter()

logger = logging.getLogger(__name__)

MAX_CONCURRENCY = int_env("TRANSCRIBE_MAX_CONCURRENCY", 1)

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MEDIA_DIR = REPO_ROOT / "data" / "media"
MEDIA_DIR = os.getenv("MEDIA_DIR", str(DEFAULT_MEDIA_DIR))


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _safe_source_path(user_id: str, filename: str) -> str:
    # Security: prevent path traversal (same guard as media.py's delete endpoint).
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail={"code": "invalid_filename", "message": "Invalid filename"})
    path = os.path.join(MEDIA_DIR, user_id, filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Source file not found"})
    return path


class TranscribeRequest(BaseModel):
    filename: str
    model: Optional[str] = None  # None = use the caller's configured STT model
    # Where the transcript goes when it is ready. The worker attaches it, so this
    # travels with the job rather than living in the browser that started it.
    note_id: Optional[str] = None
    after_block_id: Optional[str] = None


def _job_to_read(job: TranscriptionJob) -> TranscriptionJobRead:
    result_url = f"/media/{job.user_id}/{job.result_filename}" if job.result_filename else None
    return TranscriptionJobRead(
        id=job.id,
        status=job.status,
        filename=job.result_filename,
        result_url=result_url,
        error_message=job.error_message,
    )


def _attach_to_note(session: Session, job: TranscriptionJob, url: str) -> bool:
    """Put the finished transcript into its note.

    Done here rather than in the browser because a transcription takes minutes and
    the tab that started it is usually gone — the old client-side poll died with the
    component, and its best case was a toast telling the user to reopen the note and
    attach it themselves, which nothing ever did.

    Inserted after the block the recording sits in, so placement survives too; when
    that block has since been deleted the transcript is appended rather than lost.
    Deduped on the URL so an open editor and this cannot both insert it.
    """
    if not job.note_id:
        return False
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

    block = {
        "id": str(uuid.uuid4()),
        "type": "file",
        "props": {"url": url, "name": f"Transcript — {job.source_filename}"},
        "children": [],
    }
    index = next(
        (i for i, b in enumerate(blocks)
         if isinstance(b, dict) and b.get("id") == job.after_block_id),
        -1,
    )
    blocks.insert(len(blocks) if index == -1 else index + 1, block)

    note.content = json.dumps(blocks)
    note.modified_at = datetime.utcnow()
    session.add(note)
    session.commit()
    try:
        from app.asset_utils import sync_note_assets

        sync_note_assets(session, note)
    except Exception:
        logger.exception("Could not sync assets after attaching transcript %s", job.id)
    return True


def _run_job(job_id: str) -> None:
    """Extract the audio track from a recorded video via ffmpeg, transcribe it with
    fal.ai (Wizper), save the transcript into the user's media dir, and attach it to
    its note. Runs on the shared job runner, so it survives a restart and reports
    progress into the header indicator like every other long job.
    """
    with Session(engine) as session:
        job = session.get(TranscriptionJob, job_id)
        if not job:
            return
        if _jobs.is_cancelled(job_id):
            _set(session, job, status="cancelled", stage="", detail="Cancelled")
            return

        user_id = job.user_id
        model = job.model
        _set(session, job, status="processing", stage="Extracting audio", progress=5, detail="")

        try:
            video_path = os.path.join(MEDIA_DIR, user_id, job.source_filename)
            if not os.path.exists(video_path):
                raise RuntimeError("The recording no longer exists")

            if not shutil.which("ffmpeg"):
                raise RuntimeError("ffmpeg is not installed on the server")

            api_key = load_fal_api_key(session, user_id)
            if not api_key:
                raise RuntimeError("fal.ai API key is not configured")

            fd, audio_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            try:
                result = subprocess.run(
                    ["ffmpeg", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", audio_path],
                    capture_output=True,
                    timeout=900,
                )
                if result.returncode != 0:
                    stderr_tail = result.stderr.decode(errors="replace")[-500:]
                    raise RuntimeError(f"ffmpeg failed: {stderr_tail}")

                with open(audio_path, "rb") as f:
                    audio_bytes = f.read()
            finally:
                try:
                    os.remove(audio_path)
                except OSError:
                    pass

            _set(session, job, stage="Uploading", progress=40)

            # fal's model endpoints need a real, fetchable URL for file inputs (not a
            # data: URI), so upload via the official SDK first and run on the result.
            try:
                fal = fal_client.SyncClient(key=api_key)
                audio_url = fal.upload(audio_bytes, "audio/wav", "recording.wav")
            except fal_client.FalClientHTTPError as e:
                raise RuntimeError(f"fal.ai error: {str(e)[:500]}")
            except Exception as e:
                raise RuntimeError(f"fal.ai upload failed: {type(e).__name__}: {e}")

            _set(session, job, stage="Transcribing", progress=60)

            # POST directly to fal's synchronous Wizper endpoint (rather than
            # fal_client.run()) so we can read fal's billing headers off the response,
            # same approach as the live-transcription and TTS integrations.
            try:
                with httpx.Client(timeout=120.0) as http:
                    resp = http.post(
                        f"https://fal.run/{model}",
                        headers={"Authorization": f"Key {api_key}", "Content-Type": "application/json"},
                        json={"audio_url": audio_url, "task": "transcribe"},
                    )
            except httpx.TimeoutException as e:
                raise RuntimeError(f"Timed out contacting fal.ai: {type(e).__name__}: {e}")
            except httpx.RequestError as e:
                raise RuntimeError(f"Could not reach fal.ai: {type(e).__name__}: {e}")
            if not resp.is_success:
                raise RuntimeError(f"fal.ai error: {resp.text[:500]}")
            try:
                body = resp.json()
            except ValueError:
                raise RuntimeError("Unexpected fal.ai response")

            transcript = (body.get("text") or "").strip()

            # ffmpeg and the fal upload have no interruption points, so cancelling a
            # running transcription cannot stop the work — but it must stop the result
            # from landing, or a job the user stopped still edits their note minutes
            # later. Same discipline as the assistant executor's check before a write.
            if _jobs.is_cancelled(job_id):
                _set(session, job, status="cancelled", stage="", progress=0, detail="Cancelled")
                return

            user_dir = os.path.join(MEDIA_DIR, user_id)
            os.makedirs(user_dir, exist_ok=True)
            result_filename = f"{uuid.uuid4()}.txt"
            with open(os.path.join(user_dir, result_filename), "w", encoding="utf-8") as f:
                f.write(transcript)

            _set(session, job, status="done", stage="", progress=100,
                 result_filename=result_filename)

            try:
                _attach_to_note(session, job, f"/media/{user_id}/{result_filename}")
            except Exception:
                # The transcript is written and downloadable; failing to place it in
                # the note must not turn a finished job into an error.
                logger.exception("Could not attach transcript %s to its note", job_id)

            cost, currency, request_id, cost_estimated = compute_fal_cost(session, user_id, model, resp)
            try:
                seconds = None
                chunks = body.get("chunks") or []
                if chunks and isinstance(chunks[-1], dict):
                    ts = chunks[-1].get("timestamp")
                    if isinstance(ts, (list, tuple)) and len(ts) == 2 and ts[1] is not None:
                        seconds = round(float(ts[1]))
                units, unit_type = (seconds, "seconds") if seconds else (len(transcript), "chars")
                _record_usage(
                    session, user_id, "stt", model, units, unit_type,
                    provider="fal.ai", external_ref=request_id, cost=cost, currency=currency,
                    cost_estimated=cost_estimated,
                )
            except Exception:
                pass

        except Exception as exc:
            logger.exception("Transcription %s failed", job_id)
            session.rollback()
            row = session.get(TranscriptionJob, job_id)
            if row:
                _set(session, row, status="error", stage="",
                     error_message=str(exc)[:500])


# Defined after _run_job so the queue can be handed the real callable.
_jobs = JobQueue(TranscriptionJob, _run_job, name="transcription", concurrency=MAX_CONCURRENCY)


def cancel(job_id: str) -> None:
    """Ask a transcription to stop.

    A queued one never starts. A running one cannot actually be interrupted — ffmpeg
    and the fal upload have no checkpoints — but the result is discarded rather than
    written to the note, and the row leaves the indicator immediately.
    """
    _jobs.cancel(job_id)


def start() -> None:
    """Start the transcription worker(s). Called once from the app lifespan."""
    _jobs.start()


@router.post("/jobs", response_model=DataResponse[TranscriptionJobRead])
def create_job(payload: TranscribeRequest, request: Request):
    user_id = _get_user_id(request)
    _safe_source_path(user_id, payload.filename)  # rejects traversal and missing files

    now = datetime.utcnow()
    with Session(engine) as session:
        note_title = ""
        if payload.note_id:
            note = session.get(Note, payload.note_id)
            if not note or note.user_id != user_id:
                raise HTTPException(
                    status_code=404, detail={"code": "not_found", "message": "Note not found"}
                )
            note_title = note.title or "Untitled"

        job = TranscriptionJob(
            id=str(uuid.uuid4()),
            user_id=user_id,
            source_filename=payload.filename,
            status="queued",
            stage="Queued",
            model=payload.model or load_speech_config(session, user_id)["stt_model"],
            note_id=payload.note_id,
            note_title=note_title,
            after_block_id=payload.after_block_id,
            created_at=now,
            updated_at=now,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        result = _job_to_read(job)

    _jobs.enqueue(job.id)
    return DataResponse(data=result)


@router.get("/jobs/{job_id}", response_model=DataResponse[TranscriptionJobRead])
def get_job(job_id: str, request: Request):
    user_id = _get_user_id(request)
    with Session(engine) as session:
        job = session.get(TranscriptionJob, job_id)
        if not job or job.user_id != user_id:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found"})
        return DataResponse(data=_job_to_read(job))
