"""Helpers for global (admin-managed) settings stored in the AppSetting table.

Values are JSON-encoded text (matching the seed convention). These are distinct
from per-user UserSetting rows handled by routers/settings.py.
"""
import json
from typing import Any

from sqlmodel import Session

from app.models import AppSetting

REGISTRATION_ENABLED = "registration_enabled"
EMAIL_VERIFICATION_REQUIRED = "email_verification_required"


def get_setting(session: Session, key: str, default: Any = None) -> Any:
    row = session.get(AppSetting, key)
    if row is None:
        return default
    try:
        return json.loads(row.value)
    except Exception:
        return row.value


def get_bool(session: Session, key: str, default: bool) -> bool:
    return bool(get_setting(session, key, default))


def set_setting(session: Session, key: str, value: Any) -> None:
    serialised = json.dumps(value)
    row = session.get(AppSetting, key)
    if row is None:
        session.add(AppSetting(key=key, value=serialised))
    else:
        row.value = serialised
        session.add(row)
