import os

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select, func

from app.database import get_session
from app.models import User, Note, Folder, NoteAsset
from app.routers.media import MEDIA_DIR, IMAGE_EXTENSIONS, categorize_extension
from app.thumbnails import is_thumbnail_filename, thumbnail_filename_for
from app.schemas import (
    UserRead, AdminUserUpdate, AdminPasswordReset, UserMetrics, UserStorage, FileTypeBreakdown,
)
from app.auth import hash_password

router = APIRouter()


def _count(session: Session, model, *conditions) -> int:
    """COUNT(*) over `model` with optional filter conditions."""
    query = select(func.count()).select_from(model)
    for condition in conditions:
        query = query.where(condition)
    return session.exec(query).one()


def _require_admin(request: Request, session: Session) -> User:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = session.get(User, user_id)
    if not user or not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _require_self_or_admin(request: Request, session: Session, user_id: str) -> User:
    """Allow a user to read their own resource; admins may read anyone's."""
    requester_id = getattr(request.state, "user_id", None)
    if not requester_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    requester = session.get(User, requester_id)
    if not requester:
        raise HTTPException(status_code=404, detail="User not found")
    if requester.id != user_id and not requester.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return requester


@router.get("", response_model=list[UserRead])
def list_users(request: Request, session: Session = Depends(get_session)):
    _require_admin(request, session)
    users = session.exec(select(User).order_by(User.created_at)).all()
    return [UserRead.model_validate(u) for u in users]


@router.get("/{user_id}/metrics", response_model=UserMetrics)
def user_metrics(user_id: str, request: Request, session: Session = Depends(get_session)):
    _require_self_or_admin(request, session, user_id)
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    note_count = _count(session, Note, Note.user_id == user_id)
    folder_count = _count(session, Folder, Folder.user_id == user_id)
    shared_note_count = _count(session, Note, Note.user_id == user_id, Note.is_shared == True)  # noqa: E712
    total_likes = session.exec(
        select(func.coalesce(func.sum(Note.like_count), 0)).where(Note.user_id == user_id)
    ).one()

    return UserMetrics(
        note_count=note_count,
        folder_count=folder_count,
        shared_note_count=shared_note_count,
        total_likes=int(total_likes or 0),
        last_login=user.last_login,
        created_at=user.created_at,
    )


@router.get("/{user_id}/storage", response_model=UserStorage)
def user_storage(user_id: str, request: Request, session: Session = Depends(get_session)):
    """On-demand total size of a user's uploaded media folder (can be expensive)."""
    _require_self_or_admin(request, session, user_id)
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    total_bytes = 0
    file_count = 0
    thumbnail_count = 0
    thumbnail_bytes = 0
    images_without_thumbnail = 0
    by_type: dict[str, dict[str, int]] = {}
    user_dir = os.path.join(MEDIA_DIR, user_id)
    for root, _dirs, files in os.walk(user_dir):
        for name in files:
            path = os.path.join(root, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue  # file vanished mid-walk; skip it
            total_bytes += size
            file_count += 1

            if is_thumbnail_filename(name):
                thumbnail_count += 1
                thumbnail_bytes += size
                continue  # kept out of by_type so "images" reflects original files

            ext = os.path.splitext(name)[1].lower()
            category = categorize_extension(ext)
            bucket = by_type.setdefault(category, {"file_count": 0, "total_bytes": 0})
            bucket["file_count"] += 1
            bucket["total_bytes"] += size

            if ext in IMAGE_EXTENSIONS and not os.path.exists(os.path.join(root, thumbnail_filename_for(name))):
                images_without_thumbnail += 1

    return UserStorage(
        total_bytes=total_bytes,
        file_count=file_count,
        by_type=[
            FileTypeBreakdown(category=cat, file_count=v["file_count"], total_bytes=v["total_bytes"])
            for cat, v in sorted(by_type.items())
        ],
        thumbnail_count=thumbnail_count,
        thumbnail_bytes=thumbnail_bytes,
        images_without_thumbnail=images_without_thumbnail,
    )


@router.patch("/{user_id}", response_model=UserRead)
def update_user(user_id: str, payload: AdminUserUpdate, request: Request, session: Session = Depends(get_session)):
    admin = _require_admin(request, session)
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user_id == admin.id and payload.is_admin is False:
        raise HTTPException(status_code=400, detail="Cannot revoke your own admin status")
    if payload.is_active is not None:
        user.is_active = payload.is_active
    if payload.is_admin is not None:
        user.is_admin = payload.is_admin
    session.add(user)
    session.commit()
    session.refresh(user)
    return UserRead.model_validate(user)


@router.post("/{user_id}/reset-password", status_code=204)
def reset_password(user_id: str, payload: AdminPasswordReset, request: Request, session: Session = Depends(get_session)):
    _require_admin(request, session)
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.hashed_password = hash_password(payload.new_password)
    session.add(user)
    session.commit()


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: str, request: Request, session: Session = Depends(get_session)):
    admin = _require_admin(request, session)
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Their notes and media dir are left in place (a long-standing gap in this
    # endpoint), but asset rows must not outlive the account — they carry a user_id that
    # no longer resolves, and would otherwise keep counting as references.
    for asset in session.exec(select(NoteAsset).where(NoteAsset.user_id == user_id)).all():
        session.delete(asset)
    session.delete(user)
    session.commit()
