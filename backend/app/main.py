import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from jose import JWTError

from app.database import init_db, get_session, engine
from app.seed import run_seed
from app.routers import notes, categories, media, settings
from app.routers import auth as auth_router
from app.auth import decode_token
from sqlmodel import Session


MEDIA_DIR = os.getenv("MEDIA_DIR", "./data/media")

PUBLIC_PATHS = {"/api/health", "/api/auth/login", "/api/auth/register"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with Session(engine) as session:
        run_seed(session)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    yield


app = FastAPI(title="Gecko Notes API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def jwt_auth_middleware(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS:
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
app.include_router(notes.router, prefix="/api/notes", tags=["notes"])
app.include_router(categories.router, prefix="/api/categories", tags=["categories"])
app.include_router(media.router, prefix="/api/media", tags=["media"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])

os.makedirs(MEDIA_DIR, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
