import os
import uuid as _uuid
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
        # Per-user settings migration
        try:
            conn.execute(text("ALTER TABLE aiprovider ADD COLUMN user_id TEXT"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE systemprompt ADD COLUMN user_id TEXT"))
            conn.commit()
        except Exception:
            pass
        # Assign existing AI providers to first admin (admin-only migration)
        try:
            admin = conn.execute(text(
                'SELECT id FROM "user" WHERE is_admin = 1 ORDER BY created_at LIMIT 1'
            )).fetchone()
            if admin:
                conn.execute(text(
                    "UPDATE aiprovider SET user_id = :uid WHERE user_id IS NULL"
                ), {"uid": admin[0]})
                conn.commit()
        except Exception:
            pass
        # Clone existing system prompts to all users then delete originals
        try:
            prompts = conn.execute(text(
                "SELECT id, name, content, is_active, sort_order FROM systemprompt WHERE user_id IS NULL"
            )).fetchall()
            if prompts:
                users = conn.execute(text('SELECT id FROM "user"')).fetchall()
                for user_row in users:
                    uid = user_row[0]
                    for p in prompts:
                        conn.execute(text("""
                            INSERT INTO systemprompt (id, name, content, is_active, sort_order, user_id)
                            VALUES (:id, :name, :content, :is_active, :sort_order, :user_id)
                        """), {
                            "id": str(_uuid.uuid4()),
                            "name": p[1],
                            "content": p[2],
                            "is_active": p[3],
                            "sort_order": p[4],
                            "user_id": uid,
                        })
                original_ids = ",".join(f"'{p[0]}'" for p in prompts)
                conn.execute(text(f"DELETE FROM systemprompt WHERE id IN ({original_ids})"))
                conn.commit()
        except Exception:
            pass
        # Copy existing AppSetting rows to UserSetting for all users
        try:
            user_keys = {"default_sort_order", "ai_temperature", "ai_prefill", "summary_prompt"}
            global_settings = conn.execute(text("SELECT key, value FROM appsetting")).fetchall()
            users = conn.execute(text('SELECT id FROM "user"')).fetchall()
            for user_row in users:
                uid = user_row[0]
                for key, value in global_settings:
                    if key not in user_keys:
                        continue
                    exists = conn.execute(text(
                        "SELECT 1 FROM usersetting WHERE user_id = :uid AND key = :key"
                    ), {"uid": uid, "key": key}).fetchone()
                    if not exists:
                        conn.execute(text(
                            "INSERT INTO usersetting (user_id, key, value) VALUES (:uid, :key, :value)"
                        ), {"uid": uid, "key": key, "value": value})
            conn.commit()
        except Exception:
            pass
        # Per-user notes migration
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN user_id TEXT"))
            conn.commit()
        except Exception:
            pass
        try:
            admin = conn.execute(text(
                'SELECT id FROM "user" WHERE is_admin = 1 ORDER BY created_at LIMIT 1'
            )).fetchone()
            if admin:
                conn.execute(text(
                    "UPDATE note SET user_id = :uid WHERE user_id IS NULL"
                ), {"uid": admin[0]})
                conn.commit()
        except Exception:
            pass


def init_db():
    SQLModel.metadata.create_all(engine)
    _run_migrations()


def get_session():
    with Session(engine) as session:
        yield session
