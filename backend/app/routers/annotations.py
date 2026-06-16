import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from app.database import get_session
from app.models import Annotation, Note
from app.schemas import (
    AnnotationCreate, AnnotationUpdate, AnnotationRead,
    DataResponse, ListResponse,
)

# Mounted under prefix "/api/notes", so routes are /api/notes/{note_id}/annotations[...].
router = APIRouter()


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _get_owned_note(session: Session, note_id: str, user_id: str) -> Note:
    note = session.get(Note, note_id)
    if not note or note.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Note not found"})
    return note


def _get_owned_annotation(session: Session, note_id: str, annotation_id: str, user_id: str) -> Annotation:
    annotation = session.get(Annotation, annotation_id)
    if not annotation or annotation.user_id != user_id or annotation.note_id != note_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Annotation not found"})
    return annotation


@router.get("/{note_id}/annotations", response_model=ListResponse[AnnotationRead])
def list_annotations(note_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    _get_owned_note(session, note_id, user_id)
    annotations = session.exec(
        select(Annotation)
        .where(Annotation.note_id == note_id, Annotation.user_id == user_id)
        .order_by(Annotation.created_at)
    ).all()
    return ListResponse(
        data=[AnnotationRead.model_validate(a) for a in annotations],
        total=len(annotations),
        limit=len(annotations),
        offset=0,
    )


@router.post("/{note_id}/annotations", response_model=DataResponse[AnnotationRead], status_code=201)
def create_annotation(
    note_id: str, payload: AnnotationCreate, request: Request, session: Session = Depends(get_session)
):
    user_id = _get_user_id(request)
    _get_owned_note(session, note_id, user_id)
    now = datetime.now(timezone.utc)
    annotation = Annotation(
        id=str(uuid.uuid4()),
        note_id=note_id,
        user_id=user_id,
        block_id=payload.block_id,
        text=payload.text,
        created_at=now,
        modified_at=now,
    )
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    return DataResponse(data=AnnotationRead.model_validate(annotation))


@router.put("/{note_id}/annotations/{annotation_id}", response_model=DataResponse[AnnotationRead])
def update_annotation(
    note_id: str, annotation_id: str, payload: AnnotationUpdate,
    request: Request, session: Session = Depends(get_session),
):
    user_id = _get_user_id(request)
    annotation = _get_owned_annotation(session, note_id, annotation_id, user_id)
    if payload.text is not None:
        annotation.text = payload.text
    if payload.block_id is not None:
        annotation.block_id = payload.block_id
    annotation.modified_at = datetime.now(timezone.utc)
    session.add(annotation)
    session.commit()
    session.refresh(annotation)
    return DataResponse(data=AnnotationRead.model_validate(annotation))


@router.delete("/{note_id}/annotations/{annotation_id}", status_code=204)
def delete_annotation(note_id: str, annotation_id: str, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    annotation = _get_owned_annotation(session, note_id, annotation_id, user_id)
    session.delete(annotation)
    session.commit()
