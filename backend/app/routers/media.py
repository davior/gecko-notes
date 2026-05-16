import os
from pathlib import Path
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import JSONResponse

from app.schemas import MediaUploadResponse, DataResponse

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MEDIA_DIR = REPO_ROOT / "data" / "media"
MEDIA_DIR = os.getenv("MEDIA_DIR", str(DEFAULT_MEDIA_DIR))


def get_user_media_dir(user_id: str) -> str:
    path = os.path.join(MEDIA_DIR, user_id)
    os.makedirs(path, exist_ok=True)
    return path


@router.post("/upload", response_model=DataResponse[MediaUploadResponse])
async def upload_media(request: Request, file: UploadFile = File(...)):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_dir = get_user_media_dir(user_id)

    ext = ""
    if file.filename and "." in file.filename:
        ext = "." + file.filename.rsplit(".", 1)[-1].lower()

    filename = f"{uuid.uuid4()}{ext}"
    file_path = os.path.join(user_dir, filename)

    contents = await file.read()
    with open(file_path, "wb") as f:
        f.write(contents)

    size = len(contents)
    mime_type = file.content_type or "application/octet-stream"

    base_url = str(request.base_url).rstrip("/")
    url = f"{base_url}/media/{user_id}/{filename}"

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
