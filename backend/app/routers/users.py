from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from app.database import get_session
from app.models import User
from app.schemas import UserRead, AdminUserUpdate, AdminPasswordReset
from app.auth import hash_password

router = APIRouter()


def _require_admin(request: Request, session: Session) -> User:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = session.get(User, user_id)
    if not user or not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


@router.get("", response_model=list[UserRead])
def list_users(request: Request, session: Session = Depends(get_session)):
    _require_admin(request, session)
    users = session.exec(select(User).order_by(User.created_at)).all()
    return [UserRead.model_validate(u) for u in users]


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
    session.delete(user)
    session.commit()
