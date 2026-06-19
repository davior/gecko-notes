import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select
from sqlalchemy import desc

from app.database import get_session
from app.models import AISession, Note
from app.schemas import AISessionCreate, AISessionUpdate, AISessionRead, DataResponse, ListResponse

router = APIRouter()


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _get_note(note_id: str, user_id: str, session: Session) -> Note:
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


@router.get("/{note_id}/ai-sessions", response_model=ListResponse[AISessionRead])
def list_sessions(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    _get_note(note_id, user_id, session)
    rows = session.exec(
        select(AISession)
        .where(AISession.note_id == note_id, AISession.user_id == user_id)
        .order_by(desc(AISession.updated_at))
    ).all()
    return ListResponse(data=rows, total=len(rows), limit=len(rows), offset=0)


@router.post("/{note_id}/ai-sessions", response_model=DataResponse[AISessionRead], status_code=201)
def create_session(note_id: str, body: AISessionCreate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    _get_note(note_id, user_id, session)
    now = datetime.utcnow()
    obj = AISession(
        id=str(uuid.uuid4()),
        note_id=note_id,
        user_id=user_id,
        name=body.name,
        messages=body.messages,
        context_scope=body.context_scope,
        use_summaries=body.use_summaries,
        include_linked_files=body.include_linked_files,
        plan_mode=body.plan_mode,
        created_at=now,
        updated_at=now,
    )
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return DataResponse(data=obj)


@router.patch("/{note_id}/ai-sessions/{session_id}", response_model=DataResponse[AISessionRead])
def update_session(note_id: str, session_id: str, body: AISessionUpdate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    _get_note(note_id, user_id, session)
    obj = session.get(AISession, session_id)
    if not obj or obj.note_id != note_id or obj.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    if body.name is not None:
        obj.name = body.name
    if body.messages is not None:
        obj.messages = body.messages
    if body.context_scope is not None:
        obj.context_scope = body.context_scope
    if body.use_summaries is not None:
        obj.use_summaries = body.use_summaries
    if body.include_linked_files is not None:
        obj.include_linked_files = body.include_linked_files
    if body.plan_mode is not None:
        obj.plan_mode = body.plan_mode
    obj.updated_at = datetime.utcnow()
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return DataResponse(data=obj)


@router.delete("/{note_id}/ai-sessions/{session_id}", status_code=204)
def delete_session(note_id: str, session_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    _get_note(note_id, user_id, session)
    obj = session.get(AISession, session_id)
    if not obj or obj.note_id != note_id or obj.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    session.delete(obj)
    session.commit()
