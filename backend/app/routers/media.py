import os
from pathlib import Path
import uuid
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import JSONResponse

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


@router.post("/upload", response_model=DataResponse[MediaUploadResponse])
async def upload_media(request: Request, background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

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

    mime_type = file.content_type or "application/octet-stream"

    if ext in IMAGE_EXTENSIONS:
        # Local import breaks a circular dependency: thumbnails.py reads
        # MEDIA_DIR/IMAGE_EXTENSIONS from this module at import time.
        from app.thumbnails import generate_thumbnail
        background_tasks.add_task(generate_thumbnail, Path(file_path))

    url = f"/media/{user_id}/{filename}"

    return DataResponse(data=MediaUploadResponse(
        url=url,
        filename=filename,
        mime_type=mime_type,
        size=size,
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

    os.remove(file_path)

    ext = os.path.splitext(filename)[1].lower()
    if ext in IMAGE_EXTENSIONS:
        from app.thumbnails import thumbnail_filename_for
        thumb_path = os.path.join(MEDIA_DIR, user_id, thumbnail_filename_for(filename))
        if os.path.exists(thumb_path):
            os.remove(thumb_path)
