"""Who signs people in: Notes itself, or Gecko Suite (M6).

`IDENTITY_PROVIDER=notes` (the default) is Notes as it has always been: it keeps the
accounts, signs people in and mints the token every app in the suite verifies.

`IDENTITY_PROVIDER=suite` makes Notes a verifier, like GAM and GVC. The suite keeps the
accounts and signs the same token with the same `JWT_SECRET_KEY`, so nothing about
verifying one changes. What changes here:

- Someone Notes has never seen gets a `User` row the first time a request of theirs
  arrives (`ensure_user`), with their default settings seeded as registering would have.
  The row is Notes' own record of them: their notes, settings and storage hang off its
  id, which is the token's `sub` and the suite's `User.id` (ids are preserved, D7).
- The routes that create or change an account answer 410 with where to do it instead
  (`managed_by_suite`). Reading the account, trading the cookie for a token and signing
  out still work.

Switching back is setting the variable back: tokens from either issuer verify the same,
and the rows this created are ordinary rows (with no password, so nobody can sign in to
them here until someone sets one).

Read at call time, as everything in Notes is, so a test can switch it per case.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlmodel import Session, func, select

from app import suite
from app.models import User
from app.seed import seed_user_settings

logger = logging.getLogger(__name__)

PROVIDERS = {"notes", "suite"}


def provider() -> str:
    return (os.getenv("IDENTITY_PROVIDER") or "notes").strip().lower()


def suite_signs_in() -> bool:
    return provider() == "suite"


def suite_url() -> str:
    """Where a browser reaches the suite's sign-in, account and Users pages."""
    return suite.public_url()


def validate() -> None:
    """Refuse to start on a value that cannot work, as `suite.validate` does for AI."""
    value = provider()
    if value not in PROVIDERS:
        raise RuntimeError('IDENTITY_PROVIDER must be "notes" or "suite"')
    if value == "suite" and not (os.getenv("SUITE_PUBLIC_URL") or os.getenv("SUITE_BASE_URL") or "").strip():
        raise RuntimeError(
            "IDENTITY_PROVIDER=suite needs SUITE_PUBLIC_URL (or SUITE_BASE_URL): it is where "
            "Notes sends people to sign in and to manage their account."
        )


def managed_by_suite(what: str = "Accounts") -> HTTPException:
    """The answer to a request this app no longer handles. 410, not 404 or 403: the route
    exists and the caller did nothing wrong, it has moved for good. The structured detail
    is the shape the login screen already reads (`extractMessage`)."""
    return HTTPException(
        status_code=410,
        detail={
            "code": "managed_by_suite",
            "message": f"{what} are managed in Gecko Suite now: {suite_url()}",
        },
    )


def refuse_in_suite_mode() -> None:
    """A route dependency for every account-changing route in `routers/auth.py`."""
    if suite_signs_in():
        raise managed_by_suite()


def _free(session: Session, column, value: str, owner: str) -> bool:
    """Whether `value` is unused by anyone but `owner`, case-insensitively for email."""
    if column is User.email:
        clash = select(User).where(func.lower(User.email) == value.lower())
    else:
        clash = select(User).where(column == value)
    other = session.exec(clash.where(User.id != owner)).first()
    return other is None


def ensure_user(session: Session, claims: Dict[str, Any]) -> Optional[User]:
    """The row for the token's subject, created or brought up to date from its claims.

    Only in suite mode; in notes mode every subject is someone who registered here.

    A claim that is absent leaves the field alone: a token Notes minted carries only
    `sub` and `username`, and must not blank the email or demote an admin. A claim that
    collides with someone else's (a local account nobody imported holds the same name)
    is skipped with a warning rather than failing the request: the person can still use
    their notes, and the clash is an operator's to resolve.
    """
    user_id = claims.get("sub")
    if not user_id or not suite_signs_in():
        return None
    username = (claims.get("username") or "").strip()
    email = (claims.get("email") or "").strip()
    admin = claims.get("is_admin")

    user = session.get(User, user_id)
    if user is None:
        name = username or user_id
        if not _free(session, User.username, name, user_id):
            logger.warning("Username %r is taken locally; %s gets a suffixed one", name, user_id)
            name = f"{name}-{user_id[:8]}"
        address = email if email and _free(session, User.email, email, user_id) else ""
        user = User(
            id=user_id,
            username=name,
            # The column is NOT NULL and unique; a placeholder that cannot receive mail
            # until a token with the real address arrives.
            email=address or f"{user_id}@users.invalid",
            # Empty, never a hash: nothing can sign in to this row here.
            hashed_password="",
            is_admin=bool(admin),
            email_verified=True,  # the suite verified it, or does not require it
            created_at=datetime.utcnow(),
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        seed_user_settings(session, user.id)
        return user

    changed = False
    if username and username != user.username:
        if _free(session, User.username, username, user_id):
            user.username, changed = username, True
        else:
            logger.warning("Not renaming %s to %r: taken locally", user_id, username)
    if email and email.lower() != (user.email or "").lower():
        if _free(session, User.email, email, user_id):
            user.email, changed = email, True
        else:
            logger.warning("Not changing %s's email: taken locally", user_id)
    if admin is not None and bool(admin) != user.is_admin:
        user.is_admin, changed = bool(admin), True
    if changed:
        session.add(user)
        session.commit()
        session.refresh(user)
    return user
