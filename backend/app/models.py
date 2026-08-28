from typing import Optional
from datetime import datetime
from sqlmodel import SQLModel, Field


class User(SQLModel, table=True):
    id: str = Field(primary_key=True)
    username: str = Field(unique=True, index=True)
    email: str = Field(unique=True, index=True)
    hashed_password: str
    is_active: bool = Field(default=True)
    is_admin: bool = Field(default=False)
    avatar_url: Optional[str] = None
    created_at: datetime
    last_login: Optional[datetime] = None
    # Email verification: new sign-ups start unverified and cannot log in until they
    # click the link in their welcome email (when verification is required & email is
    # configured). Pre-existing accounts are backfilled to verified in _run_migrations.
    email_verified: bool = Field(default=False)
    # Two-factor auth (opt-in, per user). None = disabled; "email" = one-time codes sent
    # by email at login; "totp" = authenticator app. totp_secret is Fernet-encrypted at
    # rest (see app.auth.encrypt_api_key) and holds the pending secret during TOTP setup
    # even before two_factor_method is set to "totp".
    two_factor_method: Optional[str] = None
    totp_secret: Optional[str] = None


class AuthToken(SQLModel, table=True):
    """Short-lived, single-use secrets for out-of-band auth flows. One table backs
    three purposes: email verification links, password-reset links, and email-based
    2FA login codes. The raw token/code is never stored — only its SHA-256 hash
    (see app.auth.hash_token) — and rows are consumed by setting used_at."""
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    purpose: str = Field(index=True)  # "verify_email" | "password_reset" | "twofa_email"
    token_hash: str = Field(index=True)
    expires_at: datetime
    used_at: Optional[datetime] = None
    attempts: int = Field(default=0)  # failed-code attempts (email-2FA brute-force cap)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Category(SQLModel, table=True):
    id: str = Field(primary_key=True)
    label: str
    emoji: str
    color: str  # hex e.g. "#3B82F6"
    is_default: bool = False
    sort_order: int = 0


class Folder(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    parent_folder_id: Optional[str] = Field(default=None, foreign_key="folder.id", index=True)  # null = top level
    user_id: Optional[str] = Field(default=None, index=True)
    sort_order: int = Field(default=0)
    icon_type: Optional[str] = None   # 'emoji' | 'lucide'
    icon_value: Optional[str] = None  # the emoji character, or a Lucide icon name
    color: Optional[str] = None       # hex e.g. "#3B82F6"
    # Marks special, app-managed folders. 'archive' identifies the per-user Archive
    # Bin (where deleted folders are moved); null for ordinary user folders.
    system_key: Optional[str] = Field(default=None, index=True)
    # Saved search query. When non-null, this is a "dynamic folder": clicking it in the
    # tree runs the query against the note search instead of opening a directory. It
    # holds no notes/subfolders. Null for ordinary container folders.
    search_query: Optional[str] = None
    created_at: datetime
    modified_at: datetime


class Note(SQLModel, table=True):
    id: str = Field(primary_key=True)
    title: str
    content: str  # BlockNote JSON serialised as string
    category_id: str = Field(foreign_key="category.id")
    folder_id: Optional[str] = Field(default=None, foreign_key="folder.id", index=True)  # null = root
    parent_note_id: Optional[str] = Field(default=None, foreign_key="note.id", index=True)  # null = top-level note
    tags: str = Field(default='[]')  # JSON array serialised as string
    is_pinned: bool = Field(default=False)
    is_shared: bool = Field(default=False)
    share_token: Optional[str] = Field(default=None, index=True)
    like_count: int = Field(default=0)  # public likes on the shared page
    summary: Optional[str] = None
    conversation: Optional[str] = None  # JSON array of ConversationMessage
    created_at: datetime
    modified_at: datetime
    user_id: Optional[str] = Field(default=None, index=True)


class NoteVersion(SQLModel, table=True):
    id: str = Field(primary_key=True)
    note_id: str = Field(foreign_key="note.id", index=True)
    user_id: str = Field(index=True)
    title: str
    content: str  # BlockNote JSON snapshot serialised as string
    content_checksum: str = Field(default='')  # SHA-256 of content for fast dedup
    category_id: str
    tags: str = Field(default='[]')  # JSON array serialised as string
    created_at: datetime


class Annotation(SQLModel, table=True):
    id: str = Field(primary_key=True)
    note_id: str = Field(foreign_key="note.id", index=True)
    user_id: Optional[str] = Field(default=None, index=True)
    block_id: str  # BlockNote block.id this annotation is anchored to
    text: str = Field(default='')  # markdown body
    created_at: datetime
    modified_at: datetime


class AIProvider(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    provider_type: str  # "anthropic" | "openai" | "deepseek" | "ollama" | "custom"
    api_key: str = Field(default='')
    base_url: Optional[str] = None
    model: str
    max_tokens: int = Field(default=16384)  # cap on the model's response (output) length
    # Whether this provider/model accepts image (and PDF) content blocks. Text-only
    # backends (e.g. DeepSeek chat) reject them with a deserialization error, so the
    # UI checks this flag before letting the user attach images. Capability-driven so
    # a new provider only needs the flag set — no per-type special-casing in the app.
    supports_images: bool = Field(default=False)
    # Speak the Anthropic Messages protocol to this provider instead of its default
    # (OpenAI-compatible) one. DeepSeek publishes an Anthropic-compatible endpoint at
    # api.deepseek.com/anthropic which runs the same server-side web_search tool Claude
    # does — so a DeepSeek provider with this set searches the web itself, natively,
    # with no third-party search key. Also usable for a `custom` Anthropic-compatible
    # gateway (with its own base_url). Ignored for `anthropic` (already native) and
    # `ollama` (its own protocol).
    use_anthropic_api: bool = Field(default=False)
    # Arbitrary extra request parameters (JSON-as-text) merged into the outgoing LLM
    # request when a chat is sent — e.g. {"temperature": 0}, top_p, or provider-specific
    # knobs. None/empty sends nothing optional. Structural keys (model, messages,
    # max_tokens, …) are stripped before the merge. Decoded to a dict on read.
    extra_params: Optional[str] = None
    enabled: bool = True
    is_active: bool = False
    user_id: Optional[str] = Field(default=None, index=True)


class AppSetting(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str  # JSON-serialised value


class UserSetting(SQLModel, table=True):
    user_id: str = Field(primary_key=True)
    key: str = Field(primary_key=True)
    value: str  # JSON-serialised value


class UsageEvent(SQLModel, table=True):
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    kind: str = Field(index=True)        # "tts" | "stt" | "ai" | "image"
    provider: Optional[str] = Field(default=None, index=True)  # "anthropic" | "openai" | "deepseek" | "ollama" | "fal.ai"
    model: str = Field(default="")
    units: int = Field(default=0)        # chars (tts) / seconds (stt) / tokens (ai) / images (image)
    unit_type: str = Field(default="")   # "chars" | "seconds" | "tokens" | "images"
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    # Cost attribution. external_ref is the provider request id (e.g. fal's
    # x-fal-request-id); cost is the charge in `currency` when it can be resolved,
    # else null. cost_estimated flags a list-price estimate (LLM token pricing) as
    # opposed to a provider-billed exact amount (fal's x-fal-billable-units).
    external_ref: Optional[str] = Field(default=None)
    cost: Optional[float] = Field(default=None)
    currency: Optional[str] = Field(default=None)
    cost_estimated: Optional[bool] = Field(default=None)


class SystemPrompt(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    content: str
    is_active: bool = Field(default=False)
    sort_order: int = Field(default=0)
    user_id: Optional[str] = Field(default=None, index=True)


class AISession(SQLModel, table=True):
    id: str = Field(primary_key=True)
    # Null note_id marks a "global" session (the list-view AI Assistant), which is
    # not tied to any single open note. Note-scoped sessions carry the note's id.
    note_id: Optional[str] = Field(default=None, index=True)
    user_id: str = Field(index=True)
    name: str
    messages: str = Field(default='[]')
    context_scope: str = Field(default='none')
    use_summaries: bool = Field(default=False)
    include_linked_files: bool = Field(default=False)
    plan_mode: bool = Field(default=True)
    # JSON array of {id, title} notes the user hand-attached to the AI context (in
    # addition to the scope). Title is denormalized for display; the id is the source
    # of truth — bodies are re-fetched live at send time.
    attached_notes: str = Field(default='[]')
    created_at: datetime
    updated_at: datetime


class Recipe(SQLModel, table=True):
    """A saved, reusable prompt the user can trigger from the AI composer (button
    picker or Deepgram Flux voice command) instead of retyping it. Per-user only —
    unlike SystemPrompt there is no global/shared concept yet."""
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    name: str
    prompt: str
    # JSON array of strings, matching this codebase's existing convention (Note.tags).
    tags: str = Field(default='[]')
    sort_order: int = Field(default=0)
    created_at: datetime
    updated_at: datetime


class TranscriptionJob(SQLModel, table=True):
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    source_filename: str  # video filename in the user's media dir
    status: str = Field(default="queued")  # "queued" | "processing" | "done" | "error"
    result_filename: Optional[str] = None  # transcript .txt filename, once done
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class VideoRenderJob(SQLModel, table=True):
    """One "generate video from article" render.

    Follows TranscriptionJob's shape — a queued row a background worker picks up
    and writes results into the user's media dir — with the progress fields a
    multi-minute render needs, and the render options kept as one JSON blob so
    a saved-preset feature never needs a schema change.
    """
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    note_id: str = Field(index=True)
    status: str = Field(default="queued")  # "queued"|"processing"|"done"|"error"|"cancelled"
    stage: str = Field(default="")         # "Narrating" | "Rendering" | "Stitching"
    progress: int = Field(default=0)       # 0-100
    detail: str = Field(default="")        # e.g. "shot 7 of 19"
    options: str = Field(default="{}")     # RenderOptions, JSON as text
    quality: str = Field(default="full")   # "preview" | "full"
    note_title: str = Field(default="")    # snapshot, for download filenames
    result_filename: Optional[str] = None      # rendered .mp4
    subtitle_filename: Optional[str] = None    # .srt sidecar
    thumbnail_filename: Optional[str] = None   # poster .jpg
    duration_seconds: Optional[float] = None
    size_bytes: Optional[int] = None
    # True once the worker has appended the result to the note, so neither side
    # inserts it twice.
    inserted: bool = Field(default=False)
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class Theme(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    user_id: Optional[str] = Field(default=None, index=True)  # null = global theme
    is_global: bool = Field(default=False)
    mode: str = Field(default="light")           # "light" | "dark"
    bg_type: str = Field(default="flat")          # "flat" | "gradient" | "image"
    bg_color1: str = Field(default="#f0f4ff")
    bg_color2: Optional[str] = None               # gradient second color
    bg_image_url: Optional[str] = None
    bg_image_mode: str = Field(default="fill")    # "repeat" | "stretch" | "fill"
    bg_blur: float = Field(default=0.0)
    glass_opacity: float = Field(default=0.30)
    glass_blur: float = Field(default=12.0)
    shadow_size: float = Field(default=8.0)
    shadow_blur: float = Field(default=16.0)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ModelCatalogEntry(SQLModel, table=True):
    """Admin-managed, shared catalog of fal.ai models offered for image/TTS/STT
    generation. Global (not per-user) — distinct from each user's own custom_models /
    custom_tts_models, which stay in UserSetting."""
    id: str = Field(primary_key=True)
    kind: str = Field(index=True)          # "image" | "tts" | "stt"
    model_id: str                          # fal endpoint id, e.g. "fal-ai/flux/dev"
    label: str
    maker_note: Optional[str] = None       # maker + one-line pitch
    sort_order: int = Field(default=0)
    is_active: bool = Field(default=True)  # soft-hide without losing the row
    # TTS-only overrides (null for image/stt kinds). JSON stored as plain text,
    # matching this codebase's existing convention (Note.tags, AISession.messages).
    voices: Optional[str] = None
    text_field: Optional[str] = None
    voice_field: Optional[str] = None
    extra_params: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
