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
        # Track the most recent successful login (surfaced in the admin user metrics).
        try:
            conn.execute(text("ALTER TABLE user ADD COLUMN last_login TEXT"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN summary TEXT"))
            conn.commit()
        except Exception:
            pass
        # Folders: notes can live inside a folder (null = root)
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN folder_id TEXT"))
            conn.commit()
        except Exception:
            pass
        # Child notes: a note can be nested under a parent note (null = top-level)
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN parent_note_id TEXT"))
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
        # Per-provider output-token cap. Backfill the higher Anthropic default the
        # form ships so existing Anthropic providers aren't capped lower than before.
        # The UPDATE rides the ALTER (which throws once the column exists), so it
        # runs exactly once and never overwrites a value the user later sets.
        try:
            conn.execute(text("ALTER TABLE aiprovider ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 16384"))
            conn.execute(text("UPDATE aiprovider SET max_tokens = 64000 WHERE provider_type = 'anthropic'"))
            conn.commit()
        except Exception:
            pass
        # Image-capability flag. New column defaults to 0 (text-only) so text-only
        # backends like DeepSeek are guarded by default; backfill the provider types
        # whose current models are vision-capable so existing users keep attaching
        # images. Runs once and never overwrites a value the user later sets.
        try:
            conn.execute(text("ALTER TABLE aiprovider ADD COLUMN supports_images BOOLEAN NOT NULL DEFAULT 0"))
            conn.execute(text("UPDATE aiprovider SET supports_images = 1 WHERE provider_type IN ('anthropic', 'openai')"))
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
        # Public likes on shared notes
        try:
            conn.execute(text("ALTER TABLE note ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0"))
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
        # Usage tracking table (TTS / STT / AI). create_all also creates this, but
        # an explicit idempotent create matches the codebase's defensive convention.
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS usageevent (
                    id TEXT PRIMARY KEY,
                    user_id TEXT,
                    kind TEXT,
                    model TEXT,
                    units INTEGER,
                    unit_type TEXT,
                    created_at TEXT
                )
            """))
            conn.commit()
        except Exception:
            pass
        # Cost-attribution columns on usageevent (added for image-generation billing;
        # provider/cost_estimated added for the per-provider usage & cost dashboard).
        for _col, _type in (
            ("external_ref", "TEXT"), ("cost", "REAL"), ("currency", "TEXT"),
            ("provider", "TEXT"), ("cost_estimated", "INTEGER"),
        ):
            try:
                conn.execute(text(f"ALTER TABLE usageevent ADD COLUMN {_col} {_type}"))
                conn.commit()
            except Exception:
                pass
        # Re-surface "dangling" child notes. A note is a child only while its parent
        # embeds it as a childNote block. Earlier versions failed to clear
        # parent_note_id when a child block was removed (the update endpoint ignored
        # an explicit null), leaving such notes stuck: still flagged as children (so
        # hidden from every list) yet no longer embedded anywhere. Detect children
        # whose parent is gone, or whose parent's content no longer references the
        # child's id, and orphan them so they return to the main list. Idempotent:
        # once parent_note_id is NULL the row is no longer considered.
        try:
            rows = conn.execute(text(
                "SELECT id, parent_note_id FROM note WHERE parent_note_id IS NOT NULL"
            )).fetchall()
            for child_id, parent_id in rows:
                parent = conn.execute(text(
                    "SELECT content FROM note WHERE id = :pid"
                ), {"pid": parent_id}).fetchone()
                # Orphan if the parent is missing, or its content doesn't embed this
                # child id (childNote blocks store the id in their props JSON).
                if parent is None or child_id not in (parent[0] or ""):
                    conn.execute(text(
                        "UPDATE note SET parent_note_id = NULL WHERE id = :cid"
                    ), {"cid": child_id})
            conn.commit()
        except Exception:
            pass
        # Migrate legacy Note.conversation data into the new AISession table
        try:
            import json as _json
            notes_with_convo = conn.execute(text(
                "SELECT id, user_id, conversation, modified_at FROM note "
                "WHERE conversation IS NOT NULL AND conversation != '' AND conversation != '[]'"
            )).fetchall()
            for note_id, user_id, conversation_json, modified_at in notes_with_convo:
                if not user_id:
                    continue
                existing = conn.execute(text(
                    "SELECT 1 FROM aisession WHERE note_id = :nid LIMIT 1"
                ), {"nid": note_id}).fetchone()
                if existing:
                    continue
                try:
                    msgs = _json.loads(conversation_json)
                    user_msgs = [m for m in msgs if isinstance(m, dict) and m.get("role") == "user"]
                    first_text = (user_msgs[0].get("content", "") if user_msgs else "").strip()
                    name = (first_text[:47] + "…") if len(first_text) > 50 else first_text or "Previous session"
                except Exception:
                    name = "Previous session"
                ts = modified_at or ""
                conn.execute(text("""
                    INSERT INTO aisession (id, note_id, user_id, name, messages, context_scope,
                        use_summaries, include_linked_files, plan_mode, created_at, updated_at)
                    VALUES (:id, :note_id, :user_id, :name, :messages, 'note',
                        0, 0, 1, :ts, :ts)
                """), {
                    "id": str(_uuid.uuid4()),
                    "note_id": note_id,
                    "user_id": user_id,
                    "name": name,
                    "messages": conversation_json,
                    "ts": ts,
                })
            conn.commit()
        except Exception:
            pass
        # Allow a NULL note_id on aisession so the list-view AI Assistant can create
        # "global" sessions not tied to any note. Older DBs created the column as
        # NOT NULL; SQLite can't drop NOT NULL in place, so rebuild the table. Guarded
        # on PRAGMA so it only runs once (skipped after the column is already nullable
        # and on fresh installs where create_all already made it nullable).
        try:
            cols = conn.execute(text("PRAGMA table_info(aisession)")).fetchall()
            # PRAGMA columns: (cid, name, type, notnull, dflt_value, pk)
            note_id_col = next((c for c in cols if c[1] == "note_id"), None)
            if note_id_col is not None and note_id_col[3] == 1:
                conn.execute(text("""
                    CREATE TABLE aisession_new (
                        id TEXT PRIMARY KEY,
                        note_id TEXT,
                        user_id TEXT,
                        name TEXT,
                        messages TEXT,
                        context_scope TEXT,
                        use_summaries BOOLEAN,
                        include_linked_files BOOLEAN,
                        plan_mode BOOLEAN,
                        created_at DATETIME,
                        updated_at DATETIME
                    )
                """))
                conn.execute(text("""
                    INSERT INTO aisession_new
                        (id, note_id, user_id, name, messages, context_scope,
                         use_summaries, include_linked_files, plan_mode, created_at, updated_at)
                    SELECT id, note_id, user_id, name, messages, context_scope,
                           use_summaries, include_linked_files, plan_mode, created_at, updated_at
                    FROM aisession
                """))
                conn.execute(text("DROP TABLE aisession"))
                conn.execute(text("ALTER TABLE aisession_new RENAME TO aisession"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_aisession_note_id ON aisession (note_id)"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_aisession_user_id ON aisession (user_id)"))
                conn.commit()
        except Exception:
            pass
        # Initialize speech_gen_config for existing users
        try:
            import json as _json
            users = conn.execute(text('SELECT id FROM "user"')).fetchall()
            for user_row in users:
                uid = user_row[0]
                # Check if speech_gen_config already exists
                existing = conn.execute(text(
                    "SELECT 1 FROM usersetting WHERE user_id = :uid AND key = 'speech_gen_config'"
                ), {"uid": uid}).fetchone()
                if not existing:
                    # Create default speech config
                    cfg = {
                        "tts_model": "fal-ai/elevenlabs/tts/eleven-v3",
                        "custom_tts_models": []
                    }
                    conn.execute(text(
                        "INSERT INTO usersetting (user_id, key, value) VALUES (:uid, :key, :value)"
                    ), {"uid": uid, "key": "speech_gen_config", "value": _json.dumps(cfg)})
            conn.commit()
        except Exception:
            pass
        # Folder customization: emoji/icon + color
        for col, coltype in [("icon_type", "TEXT"), ("icon_value", "TEXT"), ("color", "TEXT")]:
            try:
                conn.execute(text(f"ALTER TABLE folder ADD COLUMN {col} {coltype}"))
                conn.commit()
            except Exception:
                pass
        # Archive Bin: system_key flags app-managed folders ('archive' = the trash).
        try:
            conn.execute(text("ALTER TABLE folder ADD COLUMN system_key TEXT"))
            conn.commit()
        except Exception:
            pass
        # Backfill stt_model into existing users' speech_gen_config, so the stored
        # JSON blob is materialized consistently with the new tts_model/stt_model
        # shape (load_speech_config already defaults a missing key at read time —
        # this just keeps the on-disk row in sync, matching the sibling migration
        # above for tts_model/custom_tts_models).
        try:
            import json as _json
            rows = conn.execute(text(
                "SELECT user_id, value FROM usersetting WHERE key = 'speech_gen_config'"
            )).fetchall()
            for uid, value in rows:
                try:
                    cfg = _json.loads(value) or {}
                except Exception:
                    continue
                if "stt_model" not in cfg:
                    cfg["stt_model"] = "fal-ai/wizper"
                    conn.execute(text(
                        "UPDATE usersetting SET value = :value WHERE user_id = :uid AND key = 'speech_gen_config'"
                    ), {"value": _json.dumps(cfg), "uid": uid})
            conn.commit()
        except Exception:
            pass
        # Fix a bad seed value: xai/tts/v1's fal.run endpoint actually expects the
        # voice under `voice` (the shape every other curated TTS model already uses),
        # not `voice_id` — the seeded voice_field override was wrong, so any DB
        # already seeded before this fix landed has it baked in. Clear the override
        # so build_tts_request_body() falls back to the correct default.
        try:
            conn.execute(text(
                "UPDATE modelcatalogentry SET voice_field = NULL "
                "WHERE kind = 'tts' AND model_id = 'xai/tts/v1' AND voice_field = 'voice_id'"
            ))
            conn.commit()
        except Exception:
            pass
        # Fix two bad seed values in the curated image catalog:
        # `fal-ai/flux-pro/kontext` is fal's image-EDITING endpoint (requires an
        # input image_url; a prompt-only call 422s) — text-to-image lives at the
        # /text-to-image subpath. `fal-ai/krea-2` is not a valid fal endpoint id;
        # Krea 2 Large is `fal-ai/krea/v2/large/text-to-image`.
        try:
            for _old, _new in (
                ("fal-ai/flux-pro/kontext", "fal-ai/flux-pro/kontext/text-to-image"),
                ("fal-ai/krea-2", "fal-ai/krea/v2/large/text-to-image"),
            ):
                conn.execute(text(
                    "UPDATE modelcatalogentry SET model_id = :new "
                    "WHERE kind = 'image' AND model_id = :old"
                ), {"new": _new, "old": _old})
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
