import os
from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy import text

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./notes.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)


def _run_migrations():
    with engine.connect() as conn:
        # Add is_pinned column if it doesn't exist (idempotent migration)
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN is_pinned BOOLEAN NOT NULL DEFAULT 0"))
            conn.commit()
        except Exception:
            pass  # Column already exists


def init_db():
    SQLModel.metadata.create_all(engine)
    _run_migrations()


def get_session():
    with Session(engine) as session:
        yield session
