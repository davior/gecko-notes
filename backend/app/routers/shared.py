import json
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.database import get_session
from app.models import Note, User, UserSetting, Theme
from app.schemas import DataResponse, SharedNoteRead, ThemeRead

router = APIRouter()


@router.get("/{token}", response_model=DataResponse[SharedNoteRead])
def get_shared_note(token: str, session: Session = Depends(get_session)):
    note = session.exec(
        select(Note).where(Note.share_token == token, Note.is_shared == True)
    ).first()
    if not note:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Shared note not found"})

    author = session.get(User, note.user_id) if note.user_id else None

    theme_data = None
    if note.user_id:
        setting = session.exec(
            select(UserSetting).where(
                UserSetting.user_id == note.user_id,
                UserSetting.key == "shared_theme_id",
            )
        ).first()
        if setting:
            try:
                theme_id = json.loads(setting.value)
                if isinstance(theme_id, str):
                    t = session.get(Theme, theme_id)
                    if t:
                        theme_data = ThemeRead.model_validate(t)
            except Exception:
                pass

    try:
        tags = json.loads(note.tags)
    except Exception:
        tags = []

    return DataResponse(data=SharedNoteRead(
        id=note.id,
        title=note.title,
        content=note.content,
        tags=tags,
        created_at=note.created_at,
        modified_at=note.modified_at,
        author_username=author.username if author else "Unknown",
        author_avatar_url=author.avatar_url if author else None,
        theme=theme_data,
    ))
