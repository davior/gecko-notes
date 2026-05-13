import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select, func

from app.database import get_session
from app.models import User
from app.schemas import UserCreate, UserLogin, UserRead, Token, UserUpdate, PasswordChange
from app.auth import hash_password, verify_password, create_access_token

router = APIRouter()


def _require_auth(request: Request, session: Session) -> User:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.post("/register", response_model=UserRead, status_code=201)
def register(payload: UserCreate, session: Session = Depends(get_session)):
    if session.exec(select(User).where(User.username == payload.username)).first():
        raise HTTPException(status_code=400, detail="Username already taken")
    if session.exec(select(User).where(User.email == payload.email)).first():
        raise HTTPException(status_code=400, detail="Email already registered")

    user_count = session.exec(select(func.count()).select_from(User)).one()
    user = User(
        id=str(uuid.uuid4()),
        username=payload.username,
        email=payload.email,
        hashed_password=hash_password(payload.password),
        is_admin=(user_count == 0),
        created_at=datetime.utcnow(),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return UserRead.model_validate(user)


@router.post("/login", response_model=Token)
def login(payload: UserLogin, session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.username == payload.username)).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")

    token = create_access_token({"sub": user.id, "username": user.username})
    return Token(access_token=token, token_type="bearer", user=UserRead.model_validate(user))


@router.get("/me", response_model=UserRead)
def me(request: Request, session: Session = Depends(get_session)):
    return UserRead.model_validate(_require_auth(request, session))


@router.patch("/me", response_model=UserRead)
def update_me(payload: UserUpdate, request: Request, session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if payload.username is not None and payload.username != user.username:
        if session.exec(select(User).where(User.username == payload.username)).first():
            raise HTTPException(status_code=400, detail="Username already taken")
        user.username = payload.username
    if payload.email is not None and payload.email != user.email:
        if session.exec(select(User).where(User.email == payload.email)).first():
            raise HTTPException(status_code=400, detail="Email already registered")
        user.email = payload.email
    if payload.avatar_url is not None:
        user.avatar_url = payload.avatar_url
    session.add(user)
    session.commit()
    session.refresh(user)
    return UserRead.model_validate(user)


@router.post("/me/change-password", status_code=204)
def change_password(payload: PasswordChange, request: Request, session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    user.hashed_password = hash_password(payload.new_password)
    session.add(user)
    session.commit()
