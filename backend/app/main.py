import os
from fastapi import FastAPI, Request, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

from app.database import init_db, get_session, engine
from app.seed import run_seed
from app.routers import notes, categories, media, settings
from sqlmodel import Session


APP_SECRET_TOKEN = os.getenv("APP_SECRET_TOKEN", "")
MEDIA_DIR = os.getenv("MEDIA_DIR", "./data/media")


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
async def auth_middleware(request: Request, call_next):
    if APP_SECRET_TOKEN:
        # Skip auth for health check
        if request.url.path == "/api/health":
            return await call_next(request)
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer ") or auth_header[7:] != APP_SECRET_TOKEN:
            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=401,
                content={"error": {"code": "unauthorized", "message": "Invalid or missing token"}},
            )
    return await call_next(request)


app.include_router(notes.router, prefix="/api/notes", tags=["notes"])
app.include_router(categories.router, prefix="/api/categories", tags=["categories"])
app.include_router(media.router, prefix="/api/media", tags=["media"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])

# Serve media files
os.makedirs(MEDIA_DIR, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
