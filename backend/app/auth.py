import base64
import hashlib
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import os
from jose import JWTError, jwt
from passlib.context import CryptContext

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)
except ImportError:
    pass

_WEAK_DEFAULT = "gecko-notes-secret-change-in-production"
SECRET_KEY = os.getenv("JWT_SECRET_KEY") or _WEAK_DEFAULT
if SECRET_KEY == _WEAK_DEFAULT:
    raise RuntimeError(
        "JWT_SECRET_KEY must be set to a strong secret before starting. "
        "Generate one with:  openssl rand -hex 32"
    )

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 30

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


# ─── Two-factor login challenge ───────────────────────────────────────────────
# After a correct password, a user with 2FA enabled gets a short-lived challenge
# token (not a full access token) that proves the password step passed. Step two
# (POST /auth/login/2fa) requires it, so the second factor can't be presented
# without the first. It reuses the JWT machinery with a distinct claim.

TWO_FACTOR_CHALLENGE_EXPIRE_MINUTES = 5


def create_challenge_token(user_id: str, method: str) -> str:
    return create_access_token(
        {"sub": user_id, "twofa_pending": True, "method": method},
        expires_delta=timedelta(minutes=TWO_FACTOR_CHALLENGE_EXPIRE_MINUTES),
    )


def decode_challenge_token(token: str) -> dict:
    """Decode a 2FA challenge token, raising JWTError unless it is a genuine
    twofa_pending token (a normal access token must not be accepted here)."""
    payload = decode_token(token)
    if not payload.get("twofa_pending"):
        raise JWTError("Not a 2FA challenge token")
    return payload


# ─── Out-of-band token / code helpers ─────────────────────────────────────────

def generate_url_token() -> str:
    """Opaque, URL-safe secret for email verification / password-reset links."""
    return secrets.token_urlsafe(32)


def generate_numeric_code(digits: int = 6) -> str:
    """Zero-padded numeric one-time code for email-based 2FA."""
    return f"{secrets.randbelow(10 ** digits):0{digits}d}"


def hash_token(raw: str) -> str:
    """SHA-256 hex digest — link tokens and email codes are stored hashed, never raw."""
    return hashlib.sha256(raw.encode()).hexdigest()


class PasswordPolicyError(ValueError):
    """Raised when a password fails the strength policy."""


MIN_PASSWORD_LENGTH = 8


def validate_password_strength(password: str) -> str:
    """Enforce the minimum password policy. Returns the password unchanged so it can
    be used inline in a pydantic validator; raises PasswordPolicyError otherwise."""
    if password is None or len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
        )
    return password


def _fernet():
    from cryptography.fernet import Fernet
    derived = hashlib.sha256(SECRET_KEY.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(derived))


def encrypt_api_key(api_key: str) -> str:
    """Encrypt an API key for storage. Returns enc:<token>."""
    if not api_key:
        return api_key
    return "enc:" + _fernet().encrypt(api_key.encode()).decode()


def decrypt_api_key(value: str) -> str:
    """Decrypt a stored API key. Falls back to plaintext for unencrypted legacy values."""
    if not value:
        return value
    if value.startswith("enc:"):
        return _fernet().decrypt(value[4:].encode()).decode()
    return value
