import json
import os
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import decrypt_api_key
from app.database import engine
from app.models import TranscriptionJob, UserSetting
from app.routers.settings import _record_usage
from app.schemas import DataResponse, TranscriptionJobRead

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MEDIA_DIR = REPO_ROOT / "data" / "media"
MEDIA_DIR = os.getenv("MEDIA_DIR", str(DEFAULT_MEDIA_DIR))

_DEEPGRAM_KEY = "deepgram_api_key"


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
    model: str = "nova-2"


def _job_to_read(job: TranscriptionJob) -> TranscriptionJobRead:
    result_url = f"/media/{job.user_id}/{job.result_filename}" if job.result_filename else None
    return TranscriptionJobRead(
        id=job.id,
        status=job.status,
        filename=job.result_filename,
        result_url=result_url,
        error_message=job.error_message,
    )


def _run_job(job_id: str, user_id: str, video_path: str, model: str) -> None:
    """Extract the audio track from a recorded video via ffmpeg, transcribe it with
    Deepgram, and save the transcript as a .txt file in the user's media dir. Runs
    in a background thread (FastAPI dispatches sync BackgroundTasks to a threadpool),
    so it never blocks the upload response.
    """
    with Session(engine) as session:
        job = session.get(TranscriptionJob, job_id)
        if not job:
            return
        job.status = "processing"
        job.updated_at = datetime.utcnow()
        session.add(job)
        session.commit()

        try:
            if not shutil.which("ffmpeg"):
                raise RuntimeError("ffmpeg is not installed on the server")

            row = session.exec(
                select(UserSetting).where(UserSetting.user_id == user_id, UserSetting.key == _DEEPGRAM_KEY)
            ).first()
            if not row or not row.value:
                raise RuntimeError("Deepgram API key is not configured")
            api_key = decrypt_api_key(json.loads(row.value))

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

            response = httpx.post(
                f"https://api.deepgram.com/v1/listen?model={model}&smart_format=true",
                headers={
                    "Authorization": f"Token {api_key}",
                    "Content-Type": "audio/wav",
                },
                content=audio_bytes,
                timeout=180.0,
            )
            if not response.is_success:
                raise RuntimeError(f"Deepgram error: {response.text[:500]}")

            body = response.json()
            try:
                transcript = body["results"]["channels"][0]["alternatives"][0]["transcript"]
            except (KeyError, IndexError):
                raise RuntimeError("Unexpected Deepgram response")

            user_dir = os.path.join(MEDIA_DIR, user_id)
            os.makedirs(user_dir, exist_ok=True)
            result_filename = f"{uuid.uuid4()}.txt"
            with open(os.path.join(user_dir, result_filename), "w", encoding="utf-8") as f:
                f.write(transcript)

            job.status = "done"
            job.result_filename = result_filename
            job.updated_at = datetime.utcnow()
            session.add(job)
            session.commit()

            try:
                duration = body.get("metadata", {}).get("duration")
                if duration is not None:
                    _record_usage(session, user_id, "stt", model, round(float(duration)), "seconds")
                else:
                    _record_usage(session, user_id, "stt", model, len(transcript), "chars")
            except Exception:
                pass

        except Exception as exc:
            session.rollback()
            job = session.get(TranscriptionJob, job_id)
            if job:
                job.status = "error"
                job.error_message = str(exc)[:500]
                job.updated_at = datetime.utcnow()
                session.add(job)
                session.commit()


@router.post("/jobs", response_model=DataResponse[TranscriptionJobRead])
def create_job(payload: TranscribeRequest, request: Request, background_tasks: BackgroundTasks):
    user_id = _get_user_id(request)
    video_path = _safe_source_path(user_id, payload.filename)

    job = TranscriptionJob(
        id=str(uuid.uuid4()),
        user_id=user_id,
        source_filename=payload.filename,
        status="queued",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    with Session(engine) as session:
        session.add(job)
        session.commit()
        session.refresh(job)
        result = _job_to_read(job)

    background_tasks.add_task(_run_job, job.id, user_id, video_path, payload.model)

    return DataResponse(data=result)


@router.get("/jobs/{job_id}", response_model=DataResponse[TranscriptionJobRead])
def get_job(job_id: str, request: Request):
    user_id = _get_user_id(request)
    with Session(engine) as session:
        job = session.get(TranscriptionJob, job_id)
        if not job or job.user_id != user_id:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Job not found"})
        return DataResponse(data=_job_to_read(job))
