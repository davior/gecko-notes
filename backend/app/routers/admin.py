"""Admin-only global settings.

Reads/writes the registration-policy flags stored in the AppSetting table. These
are instance-wide (unlike per-user UserSetting handled by routers/settings.py) and
are surfaced publicly (read-only) via GET /api/config so the login screen can
adapt without authentication.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session

from app.database import get_session
from app.models import User
from app.schemas import AdminSettings, AdminSettingsUpdate
from app.app_settings import (
    get_bool, set_setting, REGISTRATION_ENABLED, EMAIL_VERIFICATION_REQUIRED, VOICE_MODE_ENABLED,
)

router = APIRouter()


def _require_admin(request: Request, session: Session) -> User:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = session.get(User, user_id)
    if not user or not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _current(session: Session) -> AdminSettings:
    return AdminSettings(
        registration_enabled=get_bool(session, REGISTRATION_ENABLED, True),
        email_verification_required=get_bool(session, EMAIL_VERIFICATION_REQUIRED, True),
        voice_mode_enabled=get_bool(session, VOICE_MODE_ENABLED, False),
    )


@router.get("/settings", response_model=AdminSettings)
def get_admin_settings(request: Request, session: Session = Depends(get_session)):
    _require_admin(request, session)
    return _current(session)


@router.put("/settings", response_model=AdminSettings)
def update_admin_settings(payload: AdminSettingsUpdate, request: Request,
                          session: Session = Depends(get_session)):
    _require_admin(request, session)
    if payload.registration_enabled is not None:
        set_setting(session, REGISTRATION_ENABLED, payload.registration_enabled)
    if payload.email_verification_required is not None:
        set_setting(session, EMAIL_VERIFICATION_REQUIRED, payload.email_verification_required)
    if payload.voice_mode_enabled is not None:
        set_setting(session, VOICE_MODE_ENABLED, payload.voice_mode_enabled)
    session.commit()
    return _current(session)
