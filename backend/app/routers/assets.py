"""Endpoints behind the Assets tab.

Two routers: `router` is note-scoped and mounted under /api/notes (alongside
annotations and ai-sessions), `library_router` is account-scoped and mounted under
/api/assets for the unlinked-file sweep, which spans every note the user has.
"""

import os
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile
from sqlmodel import Session, select

from app.asset_utils import (
    ORIGIN_EMBEDDED,
    ORIGIN_EXPORT,
    ORIGIN_REFERENCE,
    MEDIA_URL_PREFIX,
    extract_media_urls,
    parse_media_url,
    register_asset,
    release_media_file,
    remove_media_file,
    sync_note_assets,
)
from app.database import get_session
from app.models import Note, NoteAsset, NoteVersion, Theme, TranscriptionJob, User, VideoRenderJob
from app.routers.media import MEDIA_DIR, get_user_media_dir, sanitize_original_name, save_upload
from app.schemas import (
    AdoptRequest,
    DataResponse,
    ListResponse,
    NoteAssetRead,
    NoteAssetUpdate,
    UnlinkedFile,
    UnlinkedScan,
)
from app.thumbnails import is_thumbnail_filename, thumbnail_filename_for

router = APIRouter()
library_router = APIRouter()

VALID_ORIGINS = frozenset({ORIGIN_EMBEDDED, ORIGIN_REFERENCE, ORIGIN_EXPORT})

# Extensions a model can actually read. Everything else (video, audio, archives) is
# storable and downloadable but can't be sent as context, so the UI disables the toggle
# rather than silently dropping the file at request time.
AI_TEXT_EXTENSIONS = frozenset({".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".toml"})

# Ordering for the panel's sections: what's in the note, then what feeds it, then what
# came out of it, then what's been left behind.
_ROLE_ORDER = {"in_note": 0, "reference": 1, "export": 2, "detached": 3}


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _owned_note(note_id: str, user_id: str, session: Session) -> Note:
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    return note


def _owned_asset(asset_id: str, note_id: str, user_id: str, session: Session) -> NoteAsset:
    asset = session.get(NoteAsset, asset_id)
    if not asset or asset.note_id != note_id or asset.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Asset not found"})
    return asset


def _ai_eligible(filename: str, kind: str) -> bool:
    ext = os.path.splitext(filename)[1].lower()
    return kind == "images" or ext == ".pdf" or ext in AI_TEXT_EXTENSIONS


def _role_for(asset: NoteAsset, in_note: bool) -> str:
    if in_note:
        return "in_note"
    if asset.origin == ORIGIN_REFERENCE:
        return "reference"
    if asset.origin == ORIGIN_EXPORT:
        return "export"
    return "detached"


def _read(asset: NoteAsset, in_note_urls: Set[str]) -> NoteAssetRead:
    """Map a row to its API shape, checking disk for size, thumbnail and existence.

    Size is re-read rather than trusted: a row can outlive its file (deleted while still
    referenced, swept by the renderer's retention job), and saying so is more useful than
    quietly showing a stale number.
    """
    parsed = parse_media_url(asset.url)
    owner = parsed[0] if parsed else asset.user_id

    path = os.path.join(MEDIA_DIR, owner, asset.filename)
    try:
        size_bytes: Optional[int] = os.path.getsize(path)
        missing = False
    except OSError:
        size_bytes = asset.size_bytes
        missing = True

    thumb_url = None
    if not missing:
        thumb_name = thumbnail_filename_for(asset.filename)
        if os.path.exists(os.path.join(MEDIA_DIR, owner, thumb_name)):
            thumb_url = f"{MEDIA_URL_PREFIX}{owner}/{thumb_name}"

    in_note = asset.url in in_note_urls
    return NoteAssetRead(
        id=asset.id,
        note_id=asset.note_id,
        url=asset.url,
        filename=asset.filename,
        display_name=asset.title or asset.original_name or asset.filename,
        original_name=asset.original_name,
        title=asset.title,
        description=asset.description,
        mime_type=asset.mime_type,
        kind=asset.kind,
        origin=asset.origin,
        size_bytes=size_bytes,
        thumb_url=thumb_url,
        in_note=in_note,
        role=_role_for(asset, in_note),
        missing=missing,
        ai_context=asset.ai_context,
        ai_eligible=_ai_eligible(asset.filename, asset.kind),
        created_at=asset.created_at,
    )


@router.get("/{note_id}/assets", response_model=ListResponse[NoteAssetRead])
def list_note_assets(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = _owned_note(note_id, user_id, session)

    # Reconcile on read as well as on save, so media that arrived by a path which
    # doesn't write the note (a server-side render, say) shows up without an edit first.
    sync_note_assets(session, note)

    in_note_urls = set(extract_media_urls(note.content or ""))
    rows = session.exec(
        select(NoteAsset).where(NoteAsset.note_id == note_id).order_by(NoteAsset.created_at.desc())
    ).all()

    items = [_read(row, in_note_urls) for row in rows]
    items.sort(key=lambda a: _ROLE_ORDER.get(a.role, 9))
    return ListResponse(data=items, total=len(items), limit=len(items), offset=0)


@router.post("/{note_id}/assets", response_model=DataResponse[NoteAssetRead], status_code=201)
async def upload_note_asset(
    note_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    origin: Optional[str] = Form(None),
    session: Session = Depends(get_session),
):
    """Upload a file straight into a note's assets without putting it in the note body.

    Defaults to `reference`, because that is what this endpoint is for: material used
    while writing the note rather than published in it. Nothing here touches
    `note.content` — inserting a block is the editor's job, and doing it server-side
    would be clobbered by the next autosave.
    """
    user_id = _get_user_id(request)
    _owned_note(note_id, user_id, session)

    resolved_origin = origin if origin in VALID_ORIGINS else ORIGIN_REFERENCE

    filename, url, size, mime_type = await save_upload(user_id, file, background_tasks)

    asset = register_asset(
        session,
        user_id=user_id,
        note_id=note_id,
        url=url,
        original_name=sanitize_original_name(file.filename),
        mime_type=mime_type,
        size_bytes=size,
        origin=resolved_origin,
    )
    if asset is None:
        raise HTTPException(
            status_code=500,
            detail={"code": "register_failed", "message": "The file uploaded but could not be registered"},
        )

    if title or description:
        asset.title = title or asset.title
        asset.description = description or asset.description
        session.add(asset)
        session.commit()
        session.refresh(asset)

    note = session.get(Note, note_id)
    in_note_urls = set(extract_media_urls(note.content or "")) if note else set()
    return DataResponse(data=_read(asset, in_note_urls))


@router.patch("/{note_id}/assets/{asset_id}", response_model=DataResponse[NoteAssetRead])
def update_note_asset(
    note_id: str,
    asset_id: str,
    payload: NoteAssetUpdate,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    note = _owned_note(note_id, user_id, session)
    asset = _owned_asset(asset_id, note_id, user_id, session)

    # Blank strings clear the field; omitted keys leave it alone.
    if "title" in payload.model_fields_set:
        asset.title = (payload.title or None)
    if "description" in payload.model_fields_set:
        asset.description = (payload.description or None)
    if payload.origin is not None:
        if payload.origin not in VALID_ORIGINS:
            raise HTTPException(
                status_code=400,
                detail={"code": "invalid_origin", "message": f"Unknown origin '{payload.origin}'"},
            )
        asset.origin = payload.origin
    if payload.ai_context is not None:
        if payload.ai_context and not _ai_eligible(asset.filename, asset.kind):
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "not_ai_eligible",
                    "message": "This file type can't be sent to the assistant as context",
                },
            )
        asset.ai_context = payload.ai_context

    session.add(asset)
    session.commit()
    session.refresh(asset)

    in_note_urls = set(extract_media_urls(note.content or ""))
    return DataResponse(data=_read(asset, in_note_urls))


@router.delete("/{note_id}/assets/{asset_id}", status_code=204)
def delete_note_asset(
    note_id: str,
    asset_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Remove an asset and, when nothing else needs it, the file behind it.

    The row is committed away before the file is touched, so the reference count below
    reflects the delete. Note versions are not consulted — see file_is_referenced.
    """
    user_id = _get_user_id(request)
    _owned_note(note_id, user_id, session)
    asset = _owned_asset(asset_id, note_id, user_id, session)

    url = asset.url
    session.delete(asset)
    session.commit()

    release_media_file(session, user_id, url)


def _referenced_filenames(session: Session, user_id: str) -> Set[str]:
    """Every media filename this user still has a use for.

    Unlike the guard on a single delete, this one does read note versions: the sweep is
    explicit and user-initiated, so it can afford the scan, and offering to delete a file
    that history still needs would be worse than the cost of looking.
    """
    names: Set[str] = set()

    def add_url(url: Optional[str]):
        if not url:
            return
        idx = url.find(MEDIA_URL_PREFIX)
        parsed = parse_media_url(url[idx:] if idx >= 0 else url)
        if parsed:
            names.add(parsed[1])

    for filename in session.exec(select(NoteAsset.filename).where(NoteAsset.user_id == user_id)).all():
        names.add(filename)

    for content in session.exec(select(Note.content).where(Note.user_id == user_id)).all():
        if content and MEDIA_URL_PREFIX in content:
            for url in extract_media_urls(content):
                add_url(url)

    for content in session.exec(select(NoteVersion.content).where(NoteVersion.user_id == user_id)).all():
        if content and MEDIA_URL_PREFIX in content:
            for url in extract_media_urls(content):
                add_url(url)

    user = session.get(User, user_id)
    if user:
        add_url(user.avatar_url)

    for url in session.exec(select(Theme.bg_image_url)).all():
        add_url(url)

    for source, result in session.exec(
        select(TranscriptionJob.source_filename, TranscriptionJob.result_filename)
        .where(TranscriptionJob.user_id == user_id)
    ).all():
        names.update(n for n in (source, result) if n)

    for result, subtitle, thumb in session.exec(
        select(
            VideoRenderJob.result_filename,
            VideoRenderJob.subtitle_filename,
            VideoRenderJob.thumbnail_filename,
        ).where(VideoRenderJob.user_id == user_id)
    ).all():
        names.update(n for n in (result, subtitle, thumb) if n)

    return names


def _scan_unlinked(session: Session, user_id: str) -> List[UnlinkedFile]:
    """Files sitting in the user's media dir that nothing points at any more."""
    from app.asset_utils import kind_for

    user_dir = get_user_media_dir(user_id)
    referenced = _referenced_filenames(session, user_id)

    found: List[UnlinkedFile] = []
    try:
        entries = os.scandir(user_dir)
    except OSError:
        return found

    with entries:
        for entry in entries:
            if not entry.is_file() or is_thumbnail_filename(entry.name):
                continue
            if entry.name in referenced:
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            found.append(UnlinkedFile(
                filename=entry.name,
                url=f"{MEDIA_URL_PREFIX}{user_id}/{entry.name}",
                kind=kind_for(entry.name),
                size_bytes=stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
            ))

    found.sort(key=lambda f: f.size_bytes, reverse=True)
    return found


@library_router.get("/unlinked", response_model=DataResponse[UnlinkedScan])
def scan_unlinked(request: Request, session: Session = Depends(get_session)):
    """Find leaked media: files on disk that no note, version, avatar or theme uses.

    Deliberately on demand rather than on tab open — this walks every note version the
    user has, which is far too much work to do on a timer.
    """
    user_id = _get_user_id(request)
    files = _scan_unlinked(session, user_id)
    return DataResponse(data=UnlinkedScan(
        files=files,
        total_bytes=sum(f.size_bytes for f in files),
    ))


@library_router.delete("/unlinked/{filename}", status_code=204)
def delete_unlinked(filename: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)

    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail={"code": "invalid_filename", "message": "Invalid filename"})

    # Re-check rather than trusting the client's list: a scan taken minutes ago may have
    # been overtaken by an edit that put this file back to work.
    if filename in _referenced_filenames(session, user_id):
        raise HTTPException(
            status_code=409,
            detail={"code": "in_use", "message": "That file is in use again — re-scan to refresh the list"},
        )

    if not os.path.exists(os.path.join(MEDIA_DIR, user_id, filename)):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File not found"})

    remove_media_file(user_id, filename)


@library_router.post("/unlinked/{filename}/adopt", response_model=DataResponse[NoteAssetRead], status_code=201)
def adopt_unlinked(
    filename: str,
    payload: AdoptRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Attach an orphaned file to a note as reference material, rather than deleting it."""
    user_id = _get_user_id(request)

    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail={"code": "invalid_filename", "message": "Invalid filename"})

    note = _owned_note(payload.note_id, user_id, session)

    if not os.path.exists(os.path.join(MEDIA_DIR, user_id, filename)):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "File not found"})

    asset = register_asset(
        session,
        user_id=user_id,
        note_id=note.id,
        url=f"{MEDIA_URL_PREFIX}{user_id}/{filename}",
        origin=ORIGIN_REFERENCE,
    )
    if asset is None:
        raise HTTPException(
            status_code=500,
            detail={"code": "register_failed", "message": "Could not add that file to the note"},
        )

    in_note_urls = set(extract_media_urls(note.content or ""))
    return DataResponse(data=_read(asset, in_note_urls))
