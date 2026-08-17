import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlmodel import Session, select, func, or_, and_, col

from app.database import get_session
from app.folder_utils import archived_subtree_ids, get_folder_subtree, get_or_create_archive_folder
from app.models import Note, NoteVersion, Folder, Annotation
from app.routers.media import MEDIA_DIR
from app.schemas import (
    NoteCreate, NoteUpdate, NoteRead, NoteListItem, MoveNoteRequest, CreateChildRequest,
    NoteVersionRead, NoteVersionListItem, RestoreVersionRequest, NoteSearchFilter,
    NoteMetrics, DataResponse, ListResponse, ErrorResponse
)

router = APIRouter()


def _version_max_count() -> int:
    try:
        return max(1, int(os.getenv("NOTE_VERSION_MAX_COUNT", "50")))
    except ValueError:
        return 50


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def extract_first_image(content_str: str) -> Optional[str]:
    """Return the URL of the first image block in BlockNote JSON content."""
    try:
        blocks = json.loads(content_str)
        def find_image(block_list):
            for block in block_list:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "image":
                    url = block.get("props", {}).get("url", "")
                    if url:
                        return url
                found = find_image(block.get("children", []))
                if found:
                    return found
        return find_image(blocks)
    except Exception:
        return None


def extract_plain_text(content_str: str, max_chars: int = 200) -> str:
    """Extract plain text from BlockNote JSON content."""
    try:
        blocks = json.loads(content_str)
        texts = []
        for block in blocks:
            if isinstance(block, dict):
                content = block.get("content", [])
                if isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            texts.append(item.get("text", ""))
                        elif isinstance(item, str):
                            texts.append(item)
        plain = " ".join(texts)
        return plain[:max_chars]
    except Exception:
        return content_str[:max_chars] if content_str else ""


def extract_full_text(content_str: str) -> str:
    """Full plain text of a note (no cap), walking nested block children too.

    Used for word/character counts in note metrics — unlike extract_plain_text,
    which caps at max_chars for list previews and only reads top-level blocks.
    """
    try:
        blocks = json.loads(content_str)
    except Exception:
        return content_str or ""

    texts: List[str] = []

    def walk(block_list):
        for block in block_list:
            if not isinstance(block, dict):
                continue
            content = block.get("content", [])
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        texts.append(item.get("text", ""))
                    elif isinstance(item, str):
                        texts.append(item)
            texts.append("\n")
            walk(block.get("children", []) or [])

    walk(blocks)
    return "".join(texts).strip()


def extract_media_urls(content_str: str) -> List[str]:
    """Return the unique `/media/...` URLs referenced by a note's blocks.

    Covers images and the custom/built-in file blocks (videoFile, audioFile,
    file) — all of which store their file location in `props.url`.
    """
    try:
        blocks = json.loads(content_str)
    except Exception:
        return []

    urls: List[str] = []
    seen = set()

    def walk(block_list):
        for block in block_list:
            if not isinstance(block, dict):
                continue
            props = block.get("props", {}) or {}
            url = props.get("url")
            if isinstance(url, str) and url.startswith("/media/") and url not in seen:
                seen.add(url)
                urls.append(url)
            walk(block.get("children", []) or [])

    walk(blocks)
    return urls


# Matches the note-link convention written by the diagram editor's "Link to note" control
# (see frontend/src/utils/diagram.ts buildNoteLinkDirective): a Mermaid `click <id> href
# "/notes/<noteId>"` directive. A plain regex over the raw source is enough here — no
# Mermaid grammar parse needed, since the app only ever writes this one literal form.
_DIAGRAM_NOTE_LINK_RE = re.compile(r'href\s*"(/notes/([^"?#]+))"')


def extract_linked_note_ids(content_str: str) -> List[str]:
    """Return the ids of all notes referenced via childNote, noteReference, or diagram blocks."""
    try:
        blocks = json.loads(content_str)
    except Exception:
        return []

    ids: List[str] = []

    def walk(block_list):
        for block in block_list:
            if not isinstance(block, dict):
                continue
            props = block.get("props", {}) or {}
            btype = block.get("type")
            if btype == "childNote":
                child_id = props.get("childNoteId")
                if child_id:
                    ids.append(child_id)
            elif btype == "noteReference":
                ref_id = props.get("noteId")
                if ref_id:
                    ids.append(ref_id)
            elif btype == "diagram":
                # A diagram's Mermaid source may link a node to another note via a
                # `click <id> href "/notes/<id>"` directive; collect those note ids so the
                # shared view can transform them to the linked notes' shared pages (mirrors
                # the noteReference / childNote handling above).
                source = props.get("source") or ""
                for match in _DIAGRAM_NOTE_LINK_RE.finditer(source):
                    ids.append(match.group(2))
            walk(block.get("children", []) or [])

    walk(blocks)
    return ids


def note_to_read(note: Note) -> NoteRead:
    try:
        tags = json.loads(note.tags)
    except Exception:
        tags = []
    return NoteRead(
        id=note.id,
        title=note.title,
        content=note.content,
        category_id=note.category_id,
        folder_id=note.folder_id,
        parent_note_id=note.parent_note_id,
        tags=tags,
        is_pinned=note.is_pinned,
        is_shared=note.is_shared,
        share_token=note.share_token,
        summary=note.summary,
        conversation=note.conversation,
        created_at=note.created_at,
        modified_at=note.modified_at,
    )


def _thumbnail_url_for(first_image_url: Optional[str]) -> Optional[str]:
    """Derive the `.thumb.` sibling URL for a note's first image. Purely a
    filename transform — the frontend falls back to first_image_url via
    onError if the thumbnail isn't actually on disk yet (or never will be,
    e.g. HEIC/AVIF), so no filesystem check is needed here."""
    if not first_image_url:
        return None
    base, ext = os.path.splitext(first_image_url)
    return f"{base}.thumb{ext}"


def note_to_list_item(note: Note) -> NoteListItem:
    try:
        tags = json.loads(note.tags)
    except Exception:
        tags = []
    first_image_url = extract_first_image(note.content)
    return NoteListItem(
        id=note.id,
        title=note.title,
        content_preview=extract_plain_text(note.content, 240),
        first_image_url=first_image_url,
        thumbnail_url=_thumbnail_url_for(first_image_url),
        category_id=note.category_id,
        folder_id=note.folder_id,
        parent_note_id=note.parent_note_id,
        tags=tags,
        is_pinned=note.is_pinned,
        is_shared=note.is_shared,
        share_token=note.share_token,
        created_at=note.created_at,
        modified_at=note.modified_at,
    )


def version_to_read(version: NoteVersion) -> NoteVersionRead:
    try:
        tags = json.loads(version.tags)
    except Exception:
        tags = []
    return NoteVersionRead(
        id=version.id,
        note_id=version.note_id,
        title=version.title,
        content=version.content,
        tags=tags,
        category_id=version.category_id,
        created_at=version.created_at,
    )


def version_to_list_item(version: NoteVersion) -> NoteVersionListItem:
    return NoteVersionListItem(
        id=version.id,
        title=version.title,
        content_preview=extract_plain_text(version.content, 240),
        created_at=version.created_at,
    )


def _latest_version(session: Session, note_id: str) -> Optional[NoteVersion]:
    return session.exec(
        select(NoteVersion)
        .where(NoteVersion.note_id == note_id)
        .order_by(NoteVersion.created_at.desc())
    ).first()


def _snapshot_note(session: Session, note: Note) -> Optional[NoteVersion]:
    """Save the note's current state as a version, skipping duplicates of the latest one.

    Returns the created version, or None if content checksum matches the most recent version.
    Prunes versions beyond NOTE_VERSION_MAX_COUNT (oldest first).
    """
    checksum = hashlib.sha256(note.content.encode()).hexdigest()
    latest = _latest_version(session, note.id)
    if latest and latest.content_checksum == checksum:
        return None

    version = NoteVersion(
        id=str(uuid.uuid4()),
        note_id=note.id,
        user_id=note.user_id,
        title=note.title,
        content=note.content,
        content_checksum=checksum,
        category_id=note.category_id,
        tags=note.tags,
        created_at=datetime.now(timezone.utc),
    )
    session.add(version)
    session.flush()  # make the new version visible to the query below

    # Prune oldest versions beyond the retention cap (newest first, keep max_count).
    max_count = _version_max_count()
    existing = session.exec(
        select(NoteVersion)
        .where(NoteVersion.note_id == note.id)
        .order_by(NoteVersion.created_at.desc())
    ).all()
    for old in existing[max_count:]:
        session.delete(old)

    return version


@router.get("", response_model=ListResponse[NoteListItem])
def list_notes(
    request: Request,
    sort: str = Query("modified_at", pattern="^(modified_at|created_at)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    category_id: Optional[str] = None,
    folder_id: Optional[str] = None,
    in_folder: bool = Query(False),
    search: Optional[str] = None,
    recursive: bool = Query(False),
    include_children: bool = Query(False),
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    # Child notes are embedded in their parent and never shown in normal list/folder views.
    # include_children=True opts out of this filter for AI context scope fetches.
    if include_children:
        query = select(Note).where(Note.user_id == user_id)
        count_query = select(func.count()).select_from(Note).where(Note.user_id == user_id)
    else:
        query = select(Note).where(Note.user_id == user_id, Note.parent_note_id == None)  # noqa: E711
        count_query = (
            select(func.count()).select_from(Note)
            .where(Note.user_id == user_id, Note.parent_note_id == None)  # noqa: E711
        )

    if category_id:
        query = query.where(Note.category_id == category_id)
        count_query = count_query.where(Note.category_id == category_id)

    # When scoped to a folder view, only return notes directly in that folder
    # (folder_id omitted ⇒ root level). Without in_folder, return notes across
    # all folders (used by global search).
    #
    # Pinned notes are surfaced at the root regardless of which folder they live
    # in. Inside a folder, every note belonging to that folder is shown (pinned
    # or not) — there is no separate pinned section within a folder.
    # Archived notes (those in the Archive Bin or nested under it) are hidden from
    # the root view and from global/search results — they only surface when the
    # user explicitly browses into the Bin (in_folder + folder_id). The
    # `folder_id IS NULL` leg keeps root notes, which a bare NOT IN would drop.
    archived_ids = archived_subtree_ids(session, user_id)
    exclude_archived = (
        or_(Note.folder_id == None, col(Note.folder_id).notin_(archived_ids))  # noqa: E711
        if archived_ids else None
    )

    if in_folder:
        if folder_id:
            if recursive:
                # Recursive: include notes in this folder and all descendant folders.
                folder_ids = get_folder_subtree(folder_id, user_id, session)
                folder_filter = col(Note.folder_id).in_(folder_ids)
            else:
                folder_filter = Note.folder_id == folder_id
            query = query.where(folder_filter)
            count_query = count_query.where(folder_filter)
        else:
            # Root: notes with no folder, plus all pinned notes (any folder).
            root_filter = or_(Note.folder_id == None, Note.is_pinned == True)  # noqa: E711, E712
            query = query.where(root_filter)
            count_query = count_query.where(root_filter)
            if exclude_archived is not None:
                query = query.where(exclude_archived)
                count_query = count_query.where(exclude_archived)
    elif exclude_archived is not None:
        # Global (no folder scoping — used by search): still hide archived notes.
        query = query.where(exclude_archived)
        count_query = count_query.where(exclude_archived)

    if search:
        search_term = f"%{search}%"
        search_filter = or_(
            col(Note.title).ilike(search_term),
            col(Note.content).ilike(search_term),
        )
        query = query.where(search_filter)
        count_query = count_query.where(search_filter)

    sort_col = Note.modified_at if sort == "modified_at" else Note.created_at
    if order == "desc":
        query = query.order_by(Note.is_pinned.desc(), sort_col.desc())
    else:
        query = query.order_by(Note.is_pinned.desc(), sort_col.asc())

    total = session.exec(count_query).one()
    notes = session.exec(query.offset(offset).limit(limit)).all()

    return ListResponse(
        data=[note_to_list_item(n) for n in notes],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/search", response_model=ListResponse[NoteListItem])
def smart_search_notes(
    payload: NoteSearchFilter,
    request: Request,
    session: Session = Depends(get_session),
):
    """Execute an AI-generated structured filter across ALL of the user's notes
    (no folder scoping — unlike list_notes' in_folder mode). The frontend turns
    natural language / advanced search syntax (tags:, date:, category:) into this
    validated shape via the AI provider; the model itself never emits SQL.
    """
    user_id = _get_user_id(request)
    query = select(Note).where(Note.user_id == user_id, Note.parent_note_id == None)  # noqa: E711
    count_query = (
        select(func.count()).select_from(Note)
        .where(Note.user_id == user_id, Note.parent_note_id == None)  # noqa: E711
    )

    # Never surface archived notes (those in the Archive Bin or nested under it).
    archived_ids = archived_subtree_ids(session, user_id)
    if archived_ids:
        exclude_archived = or_(Note.folder_id == None, col(Note.folder_id).notin_(archived_ids))  # noqa: E711
        query = query.where(exclude_archived)
        count_query = count_query.where(exclude_archived)

    def apply(filter_clause):
        nonlocal query, count_query
        query = query.where(filter_clause)
        count_query = count_query.where(filter_clause)

    for term in payload.text_all:
        apply(or_(col(Note.title).ilike(f"%{term}%"), col(Note.content).ilike(f"%{term}%")))

    if payload.text_any:
        apply(or_(*[
            or_(col(Note.title).ilike(f"%{t}%"), col(Note.content).ilike(f"%{t}%"))
            for t in payload.text_any
        ]))

    if payload.tags:
        apply(or_(*[col(Note.tags).ilike(f"%{t}%") for t in payload.tags]))

    if payload.category_ids:
        apply(col(Note.category_id).in_(payload.category_ids))

    date_col = Note.created_at if payload.date_field == "created_at" else Note.modified_at

    if payload.date_from:
        d = payload.date_from
        apply(date_col >= datetime(d.year, d.month, d.day))

    if payload.date_to:
        d = payload.date_to
        apply(date_col < datetime(d.year, d.month, d.day) + timedelta(days=1))

    if payload.annual_ranges:
        # SQLite-specific: strftime('%m-%d', ...) extracts the month-day so a
        # recurring window (e.g. "first week of January") matches across any year.
        month_day = func.strftime('%m-%d', date_col)
        range_filters = []
        for r in payload.annual_ranges:
            start = f"{r.start_month:02d}-{r.start_day:02d}"
            end = f"{r.end_month:02d}-{r.end_day:02d}"
            if start <= end:
                range_filters.append(and_(month_day >= start, month_day <= end))
            else:
                # Wraps year-end (e.g. Dec 20 -> Jan 5): match either side.
                range_filters.append(or_(month_day >= start, month_day <= end))
        apply(or_(*range_filters))

    if payload.is_pinned is not None:
        apply(Note.is_pinned == payload.is_pinned)

    query = query.order_by(Note.is_pinned.desc(), date_col.desc())

    total = session.exec(count_query).one()
    notes = session.exec(query.offset(payload.offset).limit(payload.limit)).all()

    return ListResponse(
        data=[note_to_list_item(n) for n in notes],
        total=total,
        limit=payload.limit,
        offset=payload.offset,
    )


@router.get("/{note_id}", response_model=DataResponse[NoteRead])
def get_note(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    return DataResponse(data=note_to_read(note))


@router.get("/{note_id}/metrics", response_model=DataResponse[NoteMetrics])
def note_metrics(note_id: str, request: Request, session: Session = Depends(get_session)):
    """On-demand stats for a note: word/character count, reading time, size
    (stored JSON + referenced media), version count, and public likes."""
    user_id = _get_user_id(request)
    note = _get_owned_note(session, note_id, user_id)

    text = extract_full_text(note.content)
    word_count = len(text.split())
    character_count = len(text)
    # Ceil-divide at ~200 wpm; 0 words → 0, otherwise at least 1 minute.
    reading_time_minutes = (word_count + 199) // 200 if word_count else 0

    content_bytes = len(note.content.encode("utf-8"))

    resource_bytes = 0
    resource_count = 0
    seen_paths = set()
    for url in extract_media_urls(note.content):
        # URLs look like /media/{owner_id}/{filename}; only count this owner's
        # files and reject path traversal before touching the filesystem.
        rel = url[len("/media/"):].split("?")[0].split("#")[0]
        parts = rel.split("/")
        if len(parts) != 2:
            continue
        owner_id, filename = parts
        if owner_id != note.user_id or ".." in filename or not filename:
            continue
        file_path = os.path.join(MEDIA_DIR, owner_id, filename)
        if file_path in seen_paths:
            continue
        seen_paths.add(file_path)
        try:
            resource_bytes += os.path.getsize(file_path)
            resource_count += 1
        except OSError:
            continue  # referenced file missing on disk; skip it

    version_count = session.exec(
        select(func.count()).select_from(NoteVersion).where(NoteVersion.note_id == note_id)
    ).one()

    return DataResponse(data=NoteMetrics(
        word_count=word_count,
        character_count=character_count,
        reading_time_minutes=reading_time_minutes,
        content_bytes=content_bytes,
        resource_bytes=resource_bytes,
        resource_count=resource_count,
        total_bytes=content_bytes + resource_bytes,
        version_count=version_count,
        like_count=note.like_count or 0,
        is_shared=note.is_shared,
        created_at=note.created_at,
        modified_at=note.modified_at,
    ))


@router.post("", response_model=DataResponse[NoteRead], status_code=201)
def create_note(payload: NoteCreate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    now = datetime.now(timezone.utc)
    note = Note(
        id=str(uuid.uuid4()),
        title=payload.title,
        content=payload.content,
        category_id=payload.category_id,
        folder_id=payload.folder_id,
        tags=json.dumps(payload.tags),
        summary=payload.summary,
        created_at=now,
        modified_at=now,
        user_id=user_id,
    )
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.put("/{note_id}", response_model=DataResponse[NoteRead])
def update_note(note_id: str, payload: NoteUpdate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})

    # For optional fields like parent_note_id and folder_id, check if explicitly set
    # in the payload rather than checking if not None, so that clearing them (null)
    # is possible. Other fields use is not None check as before.
    if payload.title is not None:
        note.title = payload.title
    if payload.content is not None:
        note.content = payload.content
    if payload.category_id is not None:
        note.category_id = payload.category_id
    if 'folder_id' in payload.model_fields_set:
        note.folder_id = payload.folder_id
    if 'parent_note_id' in payload.model_fields_set:
        note.parent_note_id = payload.parent_note_id
    if payload.tags is not None:
        note.tags = json.dumps(payload.tags)
    if payload.is_pinned is not None:
        note.is_pinned = payload.is_pinned
    if payload.summary is not None:
        note.summary = payload.summary
    if payload.conversation is not None:
        note.conversation = payload.conversation

    note.modified_at = datetime.now(timezone.utc)
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.patch("/{note_id}/pin", response_model=DataResponse[NoteRead])
def pin_note(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    note.is_pinned = not note.is_pinned
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.patch("/{note_id}/move", response_model=DataResponse[NoteRead])
def move_note(note_id: str, payload: MoveNoteRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    if payload.folder_id:
        folder = session.get(Folder, payload.folder_id)
        if not folder or folder.user_id != user_id:
            raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Folder not found"})
        if folder.search_query is not None:
            raise HTTPException(status_code=400, detail={"code": "dynamic_folder", "message": "A dynamic folder can't contain notes"})
    note.folder_id = payload.folder_id or None
    note.modified_at = datetime.now(timezone.utc)
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.get("/{note_id}/children", response_model=ListResponse[NoteListItem])
def list_children(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    parent = session.get(Note, note_id)
    if not parent or parent.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    children = session.exec(
        select(Note)
        .where(Note.user_id == user_id, Note.parent_note_id == note_id)
        .order_by(Note.created_at.asc())
    ).all()
    return ListResponse(
        data=[note_to_list_item(c) for c in children],
        total=len(children),
        limit=len(children),
        offset=0,
    )


@router.post("/{note_id}/children", response_model=DataResponse[NoteRead], status_code=201)
def create_child(note_id: str, payload: CreateChildRequest, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    parent = session.get(Note, note_id)
    if not parent or parent.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    now = datetime.now(timezone.utc)
    child = Note(
        id=str(uuid.uuid4()),
        title=payload.title,
        content=payload.content,
        category_id=parent.category_id,   # inherit category
        folder_id=parent.folder_id,       # inherit folder
        parent_note_id=parent.id,
        tags='[]',
        created_at=now,
        modified_at=now,
        user_id=user_id,
    )
    session.add(child)
    session.commit()
    session.refresh(child)
    return DataResponse(data=note_to_read(child))


@router.post("/{note_id}/archive", response_model=DataResponse[NoteRead])
def archive_note(note_id: str, request: Request, session: Session = Depends(get_session)):
    """Move a note into the Archive Bin (soft delete) instead of permanently deleting
    it. The Bin is created lazily. Unpins the note so it stops surfacing at the root
    view. Permanent deletion is DELETE /notes/{id} (used when it's already in the Bin)."""
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    bin_folder = get_or_create_archive_folder(session, user_id)
    note.folder_id = bin_folder.id
    note.is_pinned = False
    note.modified_at = datetime.now(timezone.utc)
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    # Orphan (don't cascade-delete) children so their content survives and they
    # re-surface in the main list rather than being silently destroyed.
    children = session.exec(select(Note).where(Note.parent_note_id == note_id)).all()
    for child in children:
        child.parent_note_id = None
        session.add(child)
    versions = session.exec(select(NoteVersion).where(NoteVersion.note_id == note_id)).all()
    for version in versions:
        session.delete(version)
    annotations = session.exec(select(Annotation).where(Annotation.note_id == note_id)).all()
    for annotation in annotations:
        session.delete(annotation)
    session.delete(note)
    session.commit()


@router.post("/{note_id}/share", response_model=DataResponse[NoteRead])
def share_note(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    if not note.share_token:
        note.share_token = str(uuid.uuid4())
    note.is_shared = True
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.delete("/{note_id}/share", response_model=DataResponse[NoteRead])
def unshare_note(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    note.is_shared = False
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


def _get_owned_note(session: Session, note_id: str, user_id: str) -> Note:
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    return note


@router.post("/{note_id}/versions", response_model=Optional[DataResponse[NoteVersionRead]])
def create_version(note_id: str, request: Request, response: Response, session: Session = Depends(get_session)):
    """Snapshot the note's current state as a version. No-op (204) if unchanged."""
    user_id = _get_user_id(request)
    note = _get_owned_note(session, note_id, user_id)
    version = _snapshot_note(session, note)
    if version is None:
        session.rollback()
        response.status_code = 204
        return None
    session.commit()
    session.refresh(version)
    return DataResponse(data=version_to_read(version))


@router.get("/{note_id}/versions", response_model=ListResponse[NoteVersionListItem])
def list_versions(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    _get_owned_note(session, note_id, user_id)
    versions = session.exec(
        select(NoteVersion)
        .where(NoteVersion.note_id == note_id)
        .order_by(NoteVersion.created_at.desc())
    ).all()
    items = [version_to_list_item(v) for v in versions]
    return ListResponse(data=items, total=len(items), limit=len(items), offset=0)


@router.get("/{note_id}/versions/{version_id}", response_model=DataResponse[NoteVersionRead])
def get_version(note_id: str, version_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    _get_owned_note(session, note_id, user_id)
    version = session.get(NoteVersion, version_id)
    if not version or version.note_id != note_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Version not found"})
    return DataResponse(data=version_to_read(version))


@router.post("/{note_id}/versions/{version_id}/restore", response_model=DataResponse[NoteRead])
def restore_version(
    note_id: str,
    version_id: str,
    payload: RestoreVersionRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    note = _get_owned_note(session, note_id, user_id)
    version = session.get(NoteVersion, version_id)
    if not version or version.note_id != note_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Version not found"})

    now = datetime.now(timezone.utc)

    if payload.mode == "new_note":
        new_note = Note(
            id=str(uuid.uuid4()),
            title=f"RECOVERED: {version.title}",
            content=version.content,
            category_id=version.category_id,
            tags=version.tags,
            created_at=now,
            modified_at=now,
            user_id=user_id,
        )
        session.add(new_note)
        session.commit()
        session.refresh(new_note)
        return DataResponse(data=note_to_read(new_note))

    # in_place: preserve the current state as a version before overwriting it.
    _snapshot_note(session, note)
    note.title = version.title
    note.content = version.content
    note.category_id = version.category_id
    note.tags = version.tags
    note.modified_at = now
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))
