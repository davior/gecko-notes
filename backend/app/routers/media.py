import os
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import JSONResponse

from app.schemas import MediaUploadResponse, DataResponse

router = APIRouter()

MEDIA_DIR = os.getenv("MEDIA_DIR", "./data/media")


def get_media_dir():
    os.makedirs(MEDIA_DIR, exist_ok=True)
    return MEDIA_DIR


@router.post("/upload", response_model=DataResponse[MediaUploadResponse])
async def upload_media(request: Request, file: UploadFile = File(...)):
    media_dir = get_media_dir()

    ext = ""
    if file.filename and "." in file.filename:
        ext = "." + file.filename.rsplit(".", 1)[-1].lower()

    filename = f"{uuid.uuid4()}{ext}"
    file_path = os.path.join(media_dir, filename)

    contents = await file.read()
    with open(file_path, "wb") as f:
        f.write(contents)

    size = len(contents)
    mime_type = file.content_type or "application/octet-stream"

    # Build URL - use the request's base URL
    base_url = str(request.base_url).rstrip("/")
    url = f"{base_url}/media/{filename}"

    return DataResponse(data=MediaUploadResponse(
        url=url,
        filename=filename,
        mime_type=mime_type,
        size=size,
    ))


@router.delete("/{filename}", status_code=204)
def delete_media(filename: str):
    media_dir = get_media_dir()
    # Security: prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail={"code": "invalid_filename", "message": "Invalid filename"})

    file_path = os.path.join(media_dir, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File not found"})

    os.remove(file_path)
