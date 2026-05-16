import io
import json
import os
import re
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.models import Category, Note
from app.routers.media import get_user_media_dir
from app.schemas import DataResponse

router = APIRouter()

MEDIA_DIR = os.getenv("MEDIA_DIR", "./data/media")
PART_SIZE_LIMIT = 48 * 1024 * 1024  # 48 MB – comfortably under the 50 MB nginx limit

# In-memory import sessions (maps session_id -> session dict).
# Resets on server restart, which is acceptable for a personal notes app.
import_sessions: dict = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_image_urls(content: str) -> list[str]:
    """Return all image URLs referenced in BlockNote JSON content."""
    try:
        blocks = json.loads(content)
        urls: list[str] = []

        def _walk(block_list: list) -> None:
            for block in block_list:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "image":
                    url = block.get("props", {}).get("url", "")
                    if url:
                        urls.append(url)
                _walk(block.get("children", []))

        _walk(blocks)
        return urls
    except Exception:
        return []


def _get_referenced_media(db: Session) -> list[tuple[str, str, int]]:
    """Return a deduplicated, sorted list of (zip_entry, fs_path, size).

    Scans every note for image URLs of the form …/media/{user_id}/{filename},
    resolves them on disk, and deduplicates by filename.  This captures media
    uploaded by any user, not just the exporting user.
    """
    notes = db.exec(select(Note)).all()
    seen: set[str] = set()
    result: list[tuple[str, str, int]] = []

    for note in notes:
        for url in _extract_image_urls(note.content):
            m = re.search(r"/media/([^/]+)/([^/?#\s]+)", url)
            if not m:
                continue
            note_user_id, filename = m.group(1), m.group(2)
            if filename in seen:
                continue
            fs_path = os.path.join(MEDIA_DIR, note_user_id, filename)
            if os.path.isfile(fs_path):
                seen.add(filename)
                result.append((f"media/{filename}", fs_path, os.path.getsize(fs_path)))

    return sorted(result)


def _compute_parts(
    media_files: list[tuple[str, str, int]], data_json_size: int
) -> list[list[tuple[str, str, int]]]:
    """Assign media files to parts respecting PART_SIZE_LIMIT.

    Part 0 already contains data.json (data_json_size bytes).
    Each item is (zip_entry, fs_path, size).
    """
    parts: list[list[tuple[str, str, int]]] = [[]]
    current_size = data_json_size

    for item in media_files:
        size = item[2]
        if parts[-1] and current_size + size > PART_SIZE_LIMIT:
            parts.append([])
            current_size = 0
        parts[-1].append(item)
        current_size += size

    return parts


def _build_data_json(db: Session) -> bytes:
    """Serialise all notes and categories to a JSON byte string."""
    notes = db.exec(select(Note)).all()
    categories = db.exec(select(Category)).all()

    def _tags(note: Note) -> list:
        try:
            return json.loads(note.tags)
        except Exception:
            return []

    return json.dumps(
        {
            "version": 1,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "categories": [
                {
                    "id": c.id,
                    "label": c.label,
                    "emoji": c.emoji,
                    "color": c.color,
                    "is_default": c.is_default,
                    "sort_order": c.sort_order,
                }
                for c in categories
            ],
            "notes": [
                {
                    "id": n.id,
                    "title": n.title,
                    "content": n.content,
                    "category_id": n.category_id,
                    "tags": _tags(n),
                    "is_pinned": n.is_pinned,
                    "summary": n.summary,
                    "created_at": n.created_at.isoformat(),
                    "modified_at": n.modified_at.isoformat(),
                }
                for n in notes
            ],
        },
        ensure_ascii=False,
    ).encode()


def _remap_media_urls(content: str, url_mapping: dict[str, str]) -> str:
    """Walk BlockNote JSON and replace image URLs whose filename is in url_mapping."""
    if not url_mapping:
        return content
    try:
        blocks = json.loads(content)

        def _walk(block_list: list) -> None:
            for block in block_list:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "image":
                    url: str = block.get("props", {}).get("url", "")
                    if url:
                        filename = url.rstrip("/").split("/")[-1]
                        if filename in url_mapping:
                            block["props"]["url"] = url_mapping[filename]
                _walk(block.get("children", []))

        _walk(blocks)
        return json.dumps(blocks)
    except Exception:
        return content


# ---------------------------------------------------------------------------
# Export endpoints
# ---------------------------------------------------------------------------

@router.get("/export/manifest")
def export_manifest(db: Session = Depends(get_session)):
    data_json = _build_data_json(db)
    media_files = _get_referenced_media(db)
    parts = _compute_parts(media_files, len(data_json))

    return DataResponse(data={"total_parts": len(parts)})


@router.get("/export/part/{part_num}")
def export_part(part_num: int, db: Session = Depends(get_session)):

    data_json = _build_data_json(db)
    media_files = _get_referenced_media(db)
    parts = _compute_parts(media_files, len(data_json))

    if part_num < 0 or part_num >= len(parts):
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Part not found"},
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if part_num == 0:
            zf.writestr("data.json", data_json)
        for zip_entry, fs_path, _ in parts[part_num]:
            if os.path.isfile(fs_path):
                zf.write(fs_path, zip_entry)
    buf.seek(0)

    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    total = len(parts)
    zip_name = (
        f"gecko-notes-export-{date_str}.zip"
        if total == 1
        else f"gecko-notes-export-{date_str}-part{part_num + 1}of{total}.zip"
    )

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_name}"'},
    )


# ---------------------------------------------------------------------------
# Import endpoints
# ---------------------------------------------------------------------------

@router.post("/import/upload")
async def import_upload(
    request: Request,
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(None),
):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if not session_id:
        session_id = str(uuid.uuid4())

    if session_id not in import_sessions:
        import_sessions[session_id] = {
            "user_id": user_id,
            "url_mapping": {},
            "data_json": None,
            "media_count": 0,
            "created_at": datetime.now(timezone.utc),
        }

    sess = import_sessions[session_id]
    if sess["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Session belongs to a different user")

    contents = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(contents))
    except zipfile.BadZipFile:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_file", "message": "File is not a valid ZIP archive"},
        )

    base_url = str(request.base_url).rstrip("/")
    user_dir = get_user_media_dir(user_id)

    with zf:
        for name in zf.namelist():
            if name == "data.json":
                try:
                    sess["data_json"] = json.loads(zf.read(name))
                except Exception:
                    raise HTTPException(
                        status_code=400,
                        detail={"code": "invalid_data_json", "message": "data.json is not valid JSON"},
                    )
            elif name.startswith("media/") and not name.endswith("/"):
                original_filename = os.path.basename(name)
                if not original_filename:
                    continue
                ext = os.path.splitext(original_filename)[1].lower()
                new_filename = f"{uuid.uuid4()}{ext}"
                with open(os.path.join(user_dir, new_filename), "wb") as fp:
                    fp.write(zf.read(name))
                sess["url_mapping"][original_filename] = f"{base_url}/media/{user_id}/{new_filename}"
                sess["media_count"] += 1

    return DataResponse(
        data={
            "session_id": session_id,
            "has_data_json": sess["data_json"] is not None,
            "media_count": sess["media_count"],
        }
    )


class ImportApplyRequest(BaseModel):
    session_id: str


@router.post("/import/apply")
def import_apply(
    body: ImportApplyRequest,
    request: Request,
    db: Session = Depends(get_session),
):
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    sess = import_sessions.get(body.session_id)
    if not sess or sess["user_id"] != user_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Import session not found"},
        )
    if not sess["data_json"]:
        raise HTTPException(
            status_code=400,
            detail={"code": "no_data_json", "message": "No data.json found in uploaded parts"},
        )

    data = sess["data_json"]
    url_mapping: dict[str, str] = sess["url_mapping"]

    imported_categories = 0
    imported_notes = 0

    for cat in data.get("categories", []):
        if not db.get(Category, cat["id"]):
            db.add(
                Category(
                    id=cat["id"],
                    label=cat["label"],
                    emoji=cat["emoji"],
                    color=cat["color"],
                    is_default=cat.get("is_default", False),
                    sort_order=cat.get("sort_order", 0),
                )
            )
            imported_categories += 1

    for note in data.get("notes", []):
        if not db.get(Note, note["id"]):
            try:
                created_at = datetime.fromisoformat(note["created_at"])
                modified_at = datetime.fromisoformat(note["modified_at"])
            except Exception:
                now = datetime.now(timezone.utc)
                created_at = now
                modified_at = now

            db.add(
                Note(
                    id=note["id"],
                    title=note["title"],
                    content=_remap_media_urls(note["content"], url_mapping),
                    category_id=note["category_id"],
                    tags=json.dumps(note.get("tags", [])),
                    is_pinned=note.get("is_pinned", False),
                    summary=note.get("summary"),
                    created_at=created_at,
                    modified_at=modified_at,
                )
            )
            imported_notes += 1

    db.commit()

    media_count = sess["media_count"]
    del import_sessions[body.session_id]

    return DataResponse(
        data={
            "imported_notes": imported_notes,
            "imported_categories": imported_categories,
            "imported_media": media_count,
        }
    )
