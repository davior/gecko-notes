import json
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select, func, or_, col

from app.database import get_session
from app.models import Note
from app.schemas import (
    NoteCreate, NoteUpdate, NoteRead, NoteListItem,
    DataResponse, ListResponse, ErrorResponse
)

router = APIRouter()


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
        tags=tags,
        is_pinned=note.is_pinned,
        created_at=note.created_at,
        modified_at=note.modified_at,
    )


def note_to_list_item(note: Note) -> NoteListItem:
    try:
        tags = json.loads(note.tags)
    except Exception:
        tags = []
    return NoteListItem(
        id=note.id,
        title=note.title,
        content_preview=extract_plain_text(note.content, 120),
        first_image_url=extract_first_image(note.content),
        category_id=note.category_id,
        tags=tags,
        is_pinned=note.is_pinned,
        created_at=note.created_at,
        modified_at=note.modified_at,
    )


@router.get("", response_model=ListResponse[NoteListItem])
def list_notes(
    sort: str = Query("modified_at", pattern="^(modified_at|created_at)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    category_id: Optional[str] = None,
    search: Optional[str] = None,
    session: Session = Depends(get_session),
):
    query = select(Note)

    if category_id:
        query = query.where(Note.category_id == category_id)

    if search:
        search_term = f"%{search}%"
        query = query.where(
            or_(
                col(Note.title).ilike(search_term),
                col(Note.content).ilike(search_term),
            )
        )

    sort_col = Note.modified_at if sort == "modified_at" else Note.created_at
    if order == "desc":
        query = query.order_by(Note.is_pinned.desc(), sort_col.desc())
    else:
        query = query.order_by(Note.is_pinned.desc(), sort_col.asc())

    count_query = select(func.count()).select_from(Note)
    if category_id:
        count_query = count_query.where(Note.category_id == category_id)
    if search:
        search_term = f"%{search}%"
        count_query = count_query.where(
            or_(
                col(Note.title).ilike(search_term),
                col(Note.content).ilike(search_term),
            )
        )

    total = session.exec(count_query).one()
    notes = session.exec(query.offset(offset).limit(limit)).all()

    return ListResponse(
        data=[note_to_list_item(n) for n in notes],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{note_id}", response_model=DataResponse[NoteRead])
def get_note(note_id: str, session: Session = Depends(get_session)):
    note = session.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    return DataResponse(data=note_to_read(note))


@router.post("", response_model=DataResponse[NoteRead], status_code=201)
def create_note(payload: NoteCreate, session: Session = Depends(get_session)):
    now = datetime.now(timezone.utc)
    note = Note(
        id=str(uuid.uuid4()),
        title=payload.title,
        content=payload.content,
        category_id=payload.category_id,
        tags=json.dumps(payload.tags),
        created_at=now,
        modified_at=now,
    )
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.put("/{note_id}", response_model=DataResponse[NoteRead])
def update_note(note_id: str, payload: NoteUpdate, session: Session = Depends(get_session)):
    note = session.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})

    if payload.title is not None:
        note.title = payload.title
    if payload.content is not None:
        note.content = payload.content
    if payload.category_id is not None:
        note.category_id = payload.category_id
    if payload.tags is not None:
        note.tags = json.dumps(payload.tags)
    if payload.is_pinned is not None:
        note.is_pinned = payload.is_pinned

    note.modified_at = datetime.now(timezone.utc)
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.patch("/{note_id}/pin", response_model=DataResponse[NoteRead])
def pin_note(note_id: str, session: Session = Depends(get_session)):
    note = session.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    note.is_pinned = not note.is_pinned
    session.add(note)
    session.commit()
    session.refresh(note)
    return DataResponse(data=note_to_read(note))


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: str, session: Session = Depends(get_session)):
    note = session.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    session.delete(note)
    session.commit()
