import uuid
from datetime import datetime, timedelta
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from jose import JWTError
from sqlmodel import Session, select, func

from app.database import get_session
from app.limiter import limiter
from app.models import User, AuthToken
from app.schemas import (
    UserCreate, UserLogin, UserRead, Token, UserUpdate, PasswordChange,
    VerifyEmailRequest, ResendVerificationRequest, ForgotPasswordRequest,
    ResetPasswordRequest, MessageResponse, TwoFactorRequired, LoginTwoFactorRequest,
    TwoFactorStatus, TotpSetupResponse, TotpEnableRequest, CodeRequest,
    TwoFactorDisableRequest,
)
from app.auth import (
    hash_password, verify_password, create_access_token,
    create_challenge_token, decode_challenge_token,
    generate_url_token, generate_numeric_code, hash_token,
    encrypt_api_key, decrypt_api_key,
)
from app.seed import seed_user_settings
from app.mail import email_enabled, app_base_url, send_template
from app import twofa
from app.app_settings import (
    get_bool, REGISTRATION_ENABLED, EMAIL_VERIFICATION_REQUIRED,
)

router = APIRouter()

APP_NAME = "Gecko Notes"
VERIFY_TOKEN_EXPIRE_HOURS = 24
RESET_TOKEN_EXPIRE_MINUTES = 60
EMAIL_2FA_CODE_EXPIRE_MINUTES = 10
EMAIL_2FA_MAX_ATTEMPTS = 5


# ─── Small helpers ────────────────────────────────────────────────────────────

def _require_auth(request: Request, session: Session) -> User:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def _find_user_by_email(session: Session, email: str) -> User | None:
    return session.exec(
        select(User).where(func.lower(User.email) == email.strip().lower())
    ).first()


def _verification_required(session: Session) -> bool:
    """Verification is only enforced when it's both configured on and actually
    deliverable (SMTP set) — otherwise new users could never verify and log in."""
    return email_enabled() and get_bool(session, EMAIL_VERIFICATION_REQUIRED, True)


def _finalize_login(session: Session, user: User) -> Token:
    user.last_login = datetime.utcnow()
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_access_token({"sub": user.id, "username": user.username})
    return Token(access_token=token, token_type="bearer", user=UserRead.model_validate(user))


def _add_auth_token(session: Session, user_id: str, purpose: str, raw: str, expires_at: datetime) -> None:
    session.add(AuthToken(
        id=str(uuid.uuid4()),
        user_id=user_id,
        purpose=purpose,
        token_hash=hash_token(raw),
        expires_at=expires_at,
        created_at=datetime.utcnow(),
    ))


def _consume_link_token(session: Session, purpose: str, raw: str) -> AuthToken | None:
    """Look up a valid, unused, unexpired link token (verify/reset). Caller marks used."""
    row = session.exec(
        select(AuthToken).where(
            AuthToken.purpose == purpose,
            AuthToken.token_hash == hash_token(raw.strip()),
            AuthToken.used_at == None,  # noqa: E711
        )
    ).first()
    if not row or row.expires_at < datetime.utcnow():
        return None
    return row


def _invalidate_outstanding(session: Session, user_id: str, purpose: str) -> None:
    rows = session.exec(
        select(AuthToken).where(
            AuthToken.user_id == user_id,
            AuthToken.purpose == purpose,
            AuthToken.used_at == None,  # noqa: E711
        )
    ).all()
    for row in rows:
        row.used_at = datetime.utcnow()
        session.add(row)


def _issue_verification(session: Session, background_tasks: BackgroundTasks, user: User) -> None:
    _invalidate_outstanding(session, user.id, "verify_email")
    raw = generate_url_token()
    _add_auth_token(session, user.id, "verify_email", raw,
                    datetime.utcnow() + timedelta(hours=VERIFY_TOKEN_EXPIRE_HOURS))
    session.commit()
    verify_url = f"{app_base_url()}/verify-email?token={raw}"
    send_template(
        user.email, "welcome_verify.md", f"Verify your {APP_NAME} email",
        {"username": user.username, "verify_url": verify_url,
         "expires_hours": VERIFY_TOKEN_EXPIRE_HOURS},
        background_tasks,
    )


def _issue_password_reset(session: Session, background_tasks: BackgroundTasks, user: User) -> None:
    _invalidate_outstanding(session, user.id, "password_reset")
    raw = generate_url_token()
    _add_auth_token(session, user.id, "password_reset", raw,
                    datetime.utcnow() + timedelta(minutes=RESET_TOKEN_EXPIRE_MINUTES))
    session.commit()
    reset_url = f"{app_base_url()}/reset-password?token={raw}"
    send_template(
        user.email, "password_reset.md", f"Reset your {APP_NAME} password",
        {"username": user.username, "reset_url": reset_url,
         "expires_minutes": RESET_TOKEN_EXPIRE_MINUTES},
        background_tasks,
    )


def _issue_email_2fa_code(session: Session, background_tasks: BackgroundTasks, user: User) -> None:
    _invalidate_outstanding(session, user.id, "twofa_email")
    code = generate_numeric_code(6)
    _add_auth_token(session, user.id, "twofa_email", code,
                    datetime.utcnow() + timedelta(minutes=EMAIL_2FA_CODE_EXPIRE_MINUTES))
    session.commit()
    send_template(
        user.email, "twofa_code.md", f"Your {APP_NAME} sign-in code",
        {"username": user.username, "code": code,
         "expires_minutes": EMAIL_2FA_CODE_EXPIRE_MINUTES},
        background_tasks,
    )


def _consume_email_2fa_code(session: Session, user: User, code: str) -> bool:
    row = session.exec(
        select(AuthToken).where(
            AuthToken.user_id == user.id,
            AuthToken.purpose == "twofa_email",
            AuthToken.used_at == None,  # noqa: E711
        ).order_by(AuthToken.created_at.desc())
    ).first()
    if not row or row.expires_at < datetime.utcnow():
        return False
    if row.attempts >= EMAIL_2FA_MAX_ATTEMPTS:
        row.used_at = datetime.utcnow()
        session.add(row)
        session.commit()
        return False
    if hash_token(code.strip()) == row.token_hash:
        row.used_at = datetime.utcnow()
        session.add(row)
        session.commit()
        return True
    row.attempts += 1
    session.add(row)
    session.commit()
    return False


# ─── Registration & login ─────────────────────────────────────────────────────

@router.post("/register", response_model=UserRead, status_code=201)
def register(payload: UserCreate, background_tasks: BackgroundTasks, session: Session = Depends(get_session)):
    if session.exec(select(User).where(User.username == payload.username)).first():
        raise HTTPException(status_code=400, detail="Username already taken")
    if _find_user_by_email(session, payload.email):
        raise HTTPException(status_code=400, detail="Email already registered")

    user_count = session.exec(select(func.count()).select_from(User)).one()
    is_first = user_count == 0
    # The very first account bootstraps the admin and must never be blocked by the
    # registration toggle (there'd be no admin to flip it back on).
    if not is_first and not get_bool(session, REGISTRATION_ENABLED, True):
        raise HTTPException(status_code=403, detail="New registrations are currently disabled")

    # First user is created pre-verified so the instance always has a usable admin;
    # everyone else must verify when verification is required and email is configured.
    email_verified = True if is_first else (not _verification_required(session))
    user = User(
        id=str(uuid.uuid4()),
        username=payload.username,
        email=str(payload.email),
        hashed_password=hash_password(payload.password),
        is_admin=is_first,
        email_verified=email_verified,
        created_at=datetime.utcnow(),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    seed_user_settings(session, user.id)
    if not email_verified:
        _issue_verification(session, background_tasks, user)
    return UserRead.model_validate(user)


@router.post("/login")
@limiter.limit("5/minute")
def login(request: Request, payload: UserLogin, background_tasks: BackgroundTasks,
          session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.username == payload.username)).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")
    if not user.email_verified and _verification_required(session):
        raise HTTPException(
            status_code=403,
            detail={"code": "email_not_verified",
                    "message": "Please verify your email address before signing in."},
        )

    if user.two_factor_method:
        challenge = create_challenge_token(user.id, user.two_factor_method)
        if user.two_factor_method == "email":
            _issue_email_2fa_code(session, background_tasks, user)
        return TwoFactorRequired(method=user.two_factor_method, challenge_token=challenge)

    return _finalize_login(session, user)


@router.post("/login/2fa", response_model=Token)
@limiter.limit("10/minute")
def login_two_factor(request: Request, payload: LoginTwoFactorRequest,
                     session: Session = Depends(get_session)):
    try:
        claims = decode_challenge_token(payload.challenge_token)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired 2FA challenge")
    user = session.get(User, claims.get("sub"))
    if not user or not user.two_factor_method:
        raise HTTPException(status_code=401, detail="Invalid or expired 2FA challenge")

    if user.two_factor_method == "totp":
        secret = decrypt_api_key(user.totp_secret) if user.totp_secret else ""
        ok = twofa.verify_code(secret, payload.code)
    else:  # email
        ok = _consume_email_2fa_code(session, user, payload.code)
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid verification code")

    return _finalize_login(session, user)


# ─── Email verification & password reset ──────────────────────────────────────

@router.post("/verify-email", response_model=MessageResponse)
def verify_email(payload: VerifyEmailRequest, session: Session = Depends(get_session)):
    row = _consume_link_token(session, "verify_email", payload.token)
    user = session.get(User, row.user_id) if row else None
    if not user:
        raise HTTPException(status_code=400, detail="Invalid or expired verification link")
    user.email_verified = True
    row.used_at = datetime.utcnow()
    session.add(user)
    session.add(row)
    session.commit()
    return MessageResponse(message="Your email has been verified. You can now sign in.")


@router.post("/resend-verification", response_model=MessageResponse)
@limiter.limit("3/minute")
def resend_verification(request: Request, payload: ResendVerificationRequest,
                        background_tasks: BackgroundTasks, session: Session = Depends(get_session)):
    user = _find_user_by_email(session, payload.email)
    if user and not user.email_verified and _verification_required(session):
        _issue_verification(session, background_tasks, user)
    return MessageResponse(
        message="If that account exists and needs verification, a new email is on its way."
    )


@router.post("/forgot-password", response_model=MessageResponse)
@limiter.limit("3/minute")
def forgot_password(request: Request, payload: ForgotPasswordRequest,
                    background_tasks: BackgroundTasks, session: Session = Depends(get_session)):
    user = _find_user_by_email(session, payload.email)
    if user and email_enabled():
        _issue_password_reset(session, background_tasks, user)
    return MessageResponse(
        message="If that email is registered, a password reset link has been sent."
    )


@router.post("/reset-password", response_model=MessageResponse)
@limiter.limit("5/minute")
def reset_password(request: Request, payload: ResetPasswordRequest,
                   session: Session = Depends(get_session)):
    row = _consume_link_token(session, "password_reset", payload.token)
    user = session.get(User, row.user_id) if row else None
    if not user:
        raise HTTPException(status_code=400, detail="Invalid or expired reset link")
    user.hashed_password = hash_password(payload.new_password)
    user.email_verified = True  # controlling the inbox also proves the email
    row.used_at = datetime.utcnow()
    session.add(user)
    session.add(row)
    session.commit()
    return MessageResponse(message="Your password has been updated. You can now sign in.")


# ─── Current-user profile ─────────────────────────────────────────────────────

@router.get("/me", response_model=UserRead)
def me(request: Request, session: Session = Depends(get_session)):
    return UserRead.model_validate(_require_auth(request, session))


@router.patch("/me", response_model=UserRead)
def update_me(payload: UserUpdate, request: Request, background_tasks: BackgroundTasks,
              session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if payload.username is not None and payload.username != user.username:
        if session.exec(select(User).where(User.username == payload.username)).first():
            raise HTTPException(status_code=400, detail="Username already taken")
        user.username = payload.username
    email_changed = False
    if payload.email is not None and payload.email != user.email:
        if _find_user_by_email(session, payload.email):
            raise HTTPException(status_code=400, detail="Email already registered")
        user.email = payload.email
        email_changed = True
    if payload.avatar_url is not None:
        user.avatar_url = payload.avatar_url
    # A new email address must be re-verified when verification is enforced.
    if email_changed and _verification_required(session):
        user.email_verified = False
    session.add(user)
    session.commit()
    session.refresh(user)
    if email_changed and not user.email_verified:
        _issue_verification(session, background_tasks, user)
    return UserRead.model_validate(user)


@router.post("/me/change-password", status_code=204)
def change_password(payload: PasswordChange, request: Request, session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    user.hashed_password = hash_password(payload.new_password)
    session.add(user)
    session.commit()


# ─── Two-factor management (authenticated) ────────────────────────────────────

@router.get("/2fa/status", response_model=TwoFactorStatus)
def two_factor_status(request: Request, session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    return TwoFactorStatus(
        enabled=bool(user.two_factor_method),
        method=user.two_factor_method,
        email_available=email_enabled(),
    )


@router.post("/2fa/totp/setup", response_model=TotpSetupResponse)
def totp_setup(request: Request, session: Session = Depends(get_session)):
    """Generate a fresh authenticator secret + QR. Nothing is persisted until the
    user confirms with a valid code at /2fa/totp/enable, so an abandoned setup can't
    clobber an already-active secret."""
    user = _require_auth(request, session)
    secret = twofa.generate_secret()
    uri = twofa.provisioning_uri(secret, user.email)
    return TotpSetupResponse(secret=secret, otpauth_uri=uri, qr_data_uri=twofa.qr_data_uri(uri))


@router.post("/2fa/totp/enable", response_model=TwoFactorStatus)
def totp_enable(payload: TotpEnableRequest, request: Request, session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if not twofa.verify_code(payload.secret, payload.code):
        raise HTTPException(status_code=400, detail="That code didn't match. Try again.")
    user.totp_secret = encrypt_api_key(payload.secret)
    user.two_factor_method = "totp"
    session.add(user)
    session.commit()
    return TwoFactorStatus(enabled=True, method="totp", email_available=email_enabled())


@router.post("/2fa/email/setup", response_model=MessageResponse)
def email_2fa_setup(request: Request, background_tasks: BackgroundTasks,
                    session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if not email_enabled():
        raise HTTPException(status_code=400, detail="Email 2FA is unavailable because email isn't configured.")
    _issue_email_2fa_code(session, background_tasks, user)
    return MessageResponse(message="We've emailed you a code to confirm email-based 2FA.")


@router.post("/2fa/email/verify", response_model=TwoFactorStatus)
def email_2fa_verify(payload: CodeRequest, request: Request, session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if not _consume_email_2fa_code(session, user, payload.code):
        raise HTTPException(status_code=400, detail="That code didn't match or has expired.")
    user.two_factor_method = "email"
    session.add(user)
    session.commit()
    return TwoFactorStatus(enabled=True, method="email", email_available=email_enabled())


@router.post("/2fa/disable", response_model=TwoFactorStatus)
def two_factor_disable(payload: TwoFactorDisableRequest, request: Request,
                       session: Session = Depends(get_session)):
    user = _require_auth(request, session)
    if not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Password is incorrect")
    user.two_factor_method = None
    user.totp_secret = None
    session.add(user)
    session.commit()
    return TwoFactorStatus(enabled=False, method=None, email_available=email_enabled())
