import base64
import hashlib
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
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
