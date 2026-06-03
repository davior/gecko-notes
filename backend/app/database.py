import os
import uuid as _uuid
from pathlib import Path
from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy import event, text

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = REPO_ROOT / "data" / "db" / "notes.db"

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_DB_PATH}")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def set_sqlite_pragmas(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


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
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN conversation TEXT"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN is_shared BOOLEAN NOT NULL DEFAULT 0"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN share_token TEXT"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE noteversion ADD COLUMN content_checksum TEXT NOT NULL DEFAULT ''"))
            conn.commit()
        except Exception:
            pass
        # Collapse exact duplicate categories created by seed + import flows.
        try:
            duplicate_groups = conn.execute(text("""
                SELECT
                    label,
                    emoji,
                    color,
                    is_default,
                    sort_order,
                    COUNT(*) AS total
                FROM category
                GROUP BY label, emoji, color, is_default, sort_order
                HAVING COUNT(*) > 1
            """)).fetchall()

            for group in duplicate_groups:
                duplicates = conn.execute(text("""
                    SELECT id
                    FROM category
                    WHERE label = :label
                      AND emoji = :emoji
                      AND color = :color
                      AND is_default = :is_default
                      AND sort_order = :sort_order
                    ORDER BY id
                """), {
                    "label": group[0],
                    "emoji": group[1],
                    "color": group[2],
                    "is_default": group[3],
                    "sort_order": group[4],
                }).fetchall()
                keep_id = duplicates[0][0]
                duplicate_ids = [row[0] for row in duplicates[1:]]

                for duplicate_id in duplicate_ids:
                    conn.execute(text("""
                        UPDATE note
                        SET category_id = :keep_id
                        WHERE category_id = :duplicate_id
                    """), {"keep_id": keep_id, "duplicate_id": duplicate_id})
                    conn.execute(text("""
                        DELETE FROM category
                        WHERE id = :duplicate_id
                    """), {"duplicate_id": duplicate_id})

            conn.commit()
        except Exception:
            pass
        # Convert absolute theme image URLs to relative paths for domain portability
        try:
            themes = conn.execute(text(
                "SELECT id, bg_image_url FROM theme WHERE bg_image_url IS NOT NULL AND bg_image_url LIKE '%/media/%'"
            )).fetchall()
            for theme_id, url in themes:
                if url and "/media/" in url:
                    relative_url = url[url.find("/media/"):]
                    conn.execute(text(
                        "UPDATE theme SET bg_image_url = :url WHERE id = :id"
                    ), {"url": relative_url, "id": theme_id})
            if themes:
                conn.commit()
        except Exception:
            pass


def _seed_after_migrations():
    from app.seed import seed_global_themes
    with Session(engine) as session:
        seed_global_themes(session)


def init_db():
    if DATABASE_URL.startswith("sqlite:///"):
        db_path = Path(DATABASE_URL.removeprefix("sqlite:///"))
        db_path.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(engine)
    _run_migrations()
    _seed_after_migrations()


def get_session():
    with Session(engine) as session:
        yield session
