import os
from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy import text

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = REPO_ROOT / "data" / "db" / "notes.db"

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_DB_PATH}")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)


def _run_migrations():
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN is_pinned BOOLEAN NOT NULL DEFAULT 0"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE user ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE user ADD COLUMN avatar_url TEXT"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN summary TEXT"))
            conn.commit()
        except Exception:
            pass


def init_db():
    if DATABASE_URL.startswith("sqlite:///"):
        db_path = Path(DATABASE_URL.removeprefix("sqlite:///"))
        db_path.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(engine)
    _run_migrations()


def get_session():
    with Session(engine) as session:
        yield session
