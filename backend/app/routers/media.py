import mimetypes
import os
import re
from pathlib import Path
from typing import Optional, Tuple
import uuid
from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile, File, Request
from fastapi.responses import JSONResponse
from sqlmodel import Session

from app.database import get_session
from app.schemas import MediaUploadResponse, DataResponse

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MEDIA_DIR = REPO_ROOT / "data" / "media"
MEDIA_DIR = os.getenv("MEDIA_DIR", str(DEFAULT_MEDIA_DIR))

IMAGE_EXTENSIONS = frozenset({
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".tiff", ".ico", ".heic", ".heif",
})
VIDEO_EXTENSIONS = frozenset({
    ".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".wmv", ".flv",
})
AUDIO_EXTENSIONS = frozenset({
    ".mp3", ".ogg", ".wav", ".m4a", ".flac", ".aac", ".opus", ".wma",
})
DOCUMENT_EXTENSIONS = frozenset({
    ".pdf", ".txt", ".md", ".rtf", ".csv",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".odt", ".ods", ".odp",
})
ARCHIVE_EXTENSIONS = frozenset({".zip", ".tar", ".gz"})
DATA_EXTENSIONS = frozenset({".json", ".xml", ".yaml", ".yml", ".toml"})

ALLOWED_EXTENSIONS = (
    IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
    | DOCUMENT_EXTENSIONS | ARCHIVE_EXTENSIONS | DATA_EXTENSIONS
)


def categorize_extension(ext: str) -> str:
    if ext in IMAGE_EXTENSIONS:
        return "images"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext in DOCUMENT_EXTENSIONS:
        return "documents"
    if ext in ARCHIVE_EXTENSIONS:
        return "archives"
    if ext in DATA_EXTENSIONS:
        return "data"
    return "other"


def get_user_media_dir(user_id: str) -> str:
    path = os.path.join(MEDIA_DIR, user_id)
    os.makedirs(path, exist_ok=True)
    return path


_UNSAFE_NAME_CHARS = re.compile(r"[\x00-\x1f\\/]")


def sanitize_original_name(name: Optional[str]) -> Optional[str]:
    """Reduce an uploaded filename to something safe to store and display.

    Files are saved under a UUID, so this never touches the path — it only guards the
    label shown in the Assets tab, which is otherwise attacker-controlled text.
    """
    if not name:
        return None
    cleaned = _UNSAFE_NAME_CHARS.sub("", os.path.basename(name)).strip()
    return cleaned[:255] or None


async def save_upload(
    user_id: str,
    file: UploadFile,
    background_tasks: BackgroundTasks,
) -> Tuple[str, str, int, str]:
    """Stream an upload to the user's media dir. Returns (filename, url, size, mime_type).

    Raises 400 for a file type outside the allowlist.
    """
    user_dir = get_user_media_dir(user_id)

    ext = ""
    if file.filename and "." in file.filename:
        ext = "." + file.filename.rsplit(".", 1)[-1].lower()

    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_file_type", "message": f"File type '{ext or 'unknown'}' is not allowed"},
        )

    filename = f"{uuid.uuid4()}{ext}"
    file_path = os.path.join(user_dir, filename)

    size = 0
    with open(file_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):  # stream in 1 MB chunks
            f.write(chunk)
            size += len(chunk)

    # Prefer the extension's registered type over the browser's Content-Type: the latter
    # is unvalidated and now gets stored and displayed, not just echoed back.
    mime_type = mimetypes.guess_type(filename)[0] or file.content_type or "application/octet-stream"

    if ext in IMAGE_EXTENSIONS:
        # Local import breaks a circular dependency: thumbnails.py reads
        # MEDIA_DIR/IMAGE_EXTENSIONS from this module at import time.
        from app.thumbnails import generate_thumbnail
        background_tasks.add_task(generate_thumbnail, Path(file_path))

    return filename, f"/media/{user_id}/{filename}", size, mime_type


@router.post("/upload", response_model=DataResponse[MediaUploadResponse])
async def upload_media(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    note_id: Optional[str] = Form(None),
    session: Session = Depends(get_session),
):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    filename, url, size, mime_type = await save_upload(user_id, file, background_tasks)

    # Register the file against its note while the original filename is still in hand —
    # this is the only point at which it exists, since the file is stored under a UUID.
    # A note_id that names nothing (an upload into an unsaved note, say) is not an
    # error: reconciliation picks the file up on the first save. An upload must never
    # fail because bookkeeping did.
    registered = None
    if note_id:
        from app.asset_utils import ORIGIN_EMBEDDED, register_asset
        registered = register_asset(
            session,
            user_id=user_id,
            note_id=note_id,
            url=url,
            original_name=sanitize_original_name(file.filename),
            mime_type=mime_type,
            size_bytes=size,
            origin=ORIGIN_EMBEDDED,
        )

    return DataResponse(data=MediaUploadResponse(
        url=url,
        filename=filename,
        mime_type=mime_type,
        size=size,
        note_id=registered.note_id if registered else None,
    ))


@router.delete("/{filename}", status_code=204)
def delete_media(filename: str, request: Request):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Security: prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail={"code": "invalid_filename", "message": "Invalid filename"})

    file_path = os.path.join(MEDIA_DIR, user_id, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File not found"})

    # Local import: asset_utils reads MEDIA_DIR and the extension sets from this module.
    # Note this deletes the file outright, with no check for a note still using it —
    # /api/notes/{id}/assets/{asset_id} is the reference-counted way to remove media.
    from app.asset_utils import remove_media_file
    remove_media_file(user_id, filename)
