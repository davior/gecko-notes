import logging
import os
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from jose import JWTError
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.database import init_db, get_session, engine
from app.limiter import limiter
from app.seed import run_seed
from app.routers import notes, categories, media, settings
from app.routers import auth as auth_router
from app.routers import users as users_router
from app.routers import data as data_router
from app.auth import decode_token, encrypt_api_key, decrypt_api_key
from app.models import AIProvider
from sqlmodel import Session, select


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MEDIA_DIR = REPO_ROOT / "data" / "media"
MEDIA_DIR = os.getenv("MEDIA_DIR", str(DEFAULT_MEDIA_DIR))

PUBLIC_PATHS = {"/api/health", "/api/auth/login", "/api/auth/register"}


def _is_public(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith("/media/")


def _encrypt_legacy_api_keys(session: Session) -> None:
    """Encrypt any plaintext API keys that pre-date encryption support."""
    providers = session.exec(select(AIProvider)).all()
    changed = False
    for p in providers:
        if p.api_key and not p.api_key.startswith("enc:"):
            p.api_key = encrypt_api_key(p.api_key)
            session.add(p)
            changed = True
    if changed:
        session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with Session(engine) as session:
        run_seed(session)
        _encrypt_legacy_api_keys(session)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    yield


app = FastAPI(title="Gecko Notes API", version="1.0.0", lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

_raw_cors = os.getenv("CORS_ORIGIN", "")
if not _raw_cors:
    logging.warning("CORS_ORIGIN is not set — cross-origin API requests will be blocked.")
_cors_origins = [o.strip() for o in _raw_cors.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def jwt_auth_middleware(request: Request, call_next):
    if _is_public(request.url.path):
        return await call_next(request)

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return JSONResponse(
            status_code=401,
            content={"error": {"code": "unauthorized", "message": "Missing or invalid Authorization header"}},
        )

    token = auth_header[7:]
    try:
        payload = decode_token(token)
        request.state.user_id = payload.get("sub")
        request.state.username = payload.get("username")
    except JWTError:
        return JSONResponse(
            status_code=401,
            content={"error": {"code": "unauthorized", "message": "Invalid or expired token"}},
        )

    return await call_next(request)


app.include_router(auth_router.router, prefix="/api/auth", tags=["auth"])
app.include_router(users_router.router, prefix="/api/users", tags=["users"])
app.include_router(notes.router, prefix="/api/notes", tags=["notes"])
app.include_router(categories.router, prefix="/api/categories", tags=["categories"])
app.include_router(media.router, prefix="/api/media", tags=["media"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(data_router.router, prefix="/api/data", tags=["data"])

os.makedirs(MEDIA_DIR, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
