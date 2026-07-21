import re
from typing import Optional, Any, List, Generic, TypeVar, Literal, Annotated
from datetime import datetime, timezone, date
from pydantic import BaseModel, Field, field_validator, PlainSerializer

_HEX_COLOR_RE = re.compile(r"#[0-9A-Fa-f]{6}")


def _validate_hex_color(v: Optional[str]) -> Optional[str]:
    if v is not None and not _HEX_COLOR_RE.fullmatch(v):
        raise ValueError("color must be a hex string like #3B82F6")
    return v

T = TypeVar("T")


def _utc_isoformat(dt: datetime) -> str:
    """Serialise a datetime as an unambiguous ISO 8601 string in UTC.

    Timestamps are stored as UTC, but SQLite returns them without tzinfo. Tagging
    them as UTC lets clients (e.g. `new Date(...)` in the browser) convert to the
    viewer's local timezone instead of misreading them as local time.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


# Datetime that always serialises with an explicit UTC offset.
UTCDatetime = Annotated[datetime, PlainSerializer(_utc_isoformat, return_type=str)]


class DataResponse(BaseModel, Generic[T]):
    data: T


class ListResponse(BaseModel, Generic[T]):
    data: List[T]
    total: int
    limit: int
    offset: int


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


# Category schemas
class CategoryCreate(BaseModel):
    label: str
    emoji: str
    color: str
    is_default: bool = False
    sort_order: int = 0


class CategoryUpdate(BaseModel):
    label: Optional[str] = None
    emoji: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None


class CategoryRead(BaseModel):
    id: str
    label: str
    emoji: str
    color: str
    is_default: bool
    sort_order: int

    class Config:
        from_attributes = True


# Folder schemas
class FolderCreate(BaseModel):
    name: str
    parent_folder_id: Optional[str] = None
    sort_order: int = 0
    icon_type: Optional[Literal["emoji", "lucide"]] = None
    icon_value: Optional[str] = Field(default=None, max_length=64)
    color: Optional[str] = None

    _validate_color = field_validator("color")(_validate_hex_color)


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    parent_folder_id: Optional[str] = None  # set to move the folder
    sort_order: Optional[int] = None
    icon_type: Optional[Literal["emoji", "lucide"]] = None
    icon_value: Optional[str] = Field(default=None, max_length=64)
    color: Optional[str] = None

    _validate_color = field_validator("color")(_validate_hex_color)


class FolderRead(BaseModel):
    id: str
    name: str
    parent_folder_id: Optional[str] = None
    sort_order: int
    icon_type: Optional[str] = None
    icon_value: Optional[str] = None
    color: Optional[str] = None
    created_at: UTCDatetime
    modified_at: UTCDatetime

    class Config:
        from_attributes = True


class FolderContents(BaseModel):
    folder: Optional[FolderRead] = None       # None when viewing root
    breadcrumb: List[FolderRead] = []         # root..current ancestor chain
    subfolders: List[FolderRead] = []


class MoveNoteRequest(BaseModel):
    folder_id: Optional[str] = None           # null = move to root


# Note schemas
class NoteCreate(BaseModel):
    title: str
    content: str = '[]'
    category_id: str
    folder_id: Optional[str] = None
    tags: List[str] = []


class CreateChildRequest(BaseModel):
    title: str = "Untitled"
    content: str = '[]'  # selected blocks JSON when sending a selection, else empty


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    category_id: Optional[str] = None
    folder_id: Optional[str] = None
    parent_note_id: Optional[str] = None
    tags: Optional[List[str]] = None
    is_pinned: Optional[bool] = None
    summary: Optional[str] = None
    conversation: Optional[str] = None


class NoteRead(BaseModel):
    id: str
    title: str
    content: str
    category_id: str
    folder_id: Optional[str] = None
    parent_note_id: Optional[str] = None
    tags: List[str]
    is_pinned: bool
    is_shared: bool = False
    share_token: Optional[str] = None
    summary: Optional[str] = None
    conversation: Optional[str] = None
    created_at: UTCDatetime
    modified_at: UTCDatetime

    class Config:
        from_attributes = True


class NoteListItem(BaseModel):
    id: str
    title: str
    content_preview: str
    first_image_url: Optional[str]
    thumbnail_url: Optional[str] = None
    category_id: str
    folder_id: Optional[str] = None
    parent_note_id: Optional[str] = None
    tags: List[str]
    is_pinned: bool
    is_shared: bool = False
    share_token: Optional[str] = None
    created_at: UTCDatetime
    modified_at: UTCDatetime

    class Config:
        from_attributes = True


# Smart search schemas (AI-generated structured filter, see routers/notes.py's
# POST /search — the model never emits SQL, only this validated shape)
class AnnualRange(BaseModel):
    """A recurring month/day window matched in any year, e.g. "first week of
    January" == start_month=1, start_day=1, end_month=1, end_day=7."""
    start_month: int = Field(ge=1, le=12)
    start_day: int = Field(ge=1, le=31)
    end_month: int = Field(ge=1, le=12)
    end_day: int = Field(ge=1, le=31)


class NoteSearchFilter(BaseModel):
    text_all: List[str] = []          # every term must appear (title OR content)
    text_any: List[str] = []          # at least one term must appear
    tags: List[str] = []              # match ANY of these tags
    category_ids: List[str] = []
    date_field: Literal["created_at", "modified_at"] = "created_at"
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    annual_ranges: List[AnnualRange] = []
    is_pinned: Optional[bool] = None
    limit: int = Field(default=200, ge=1, le=200)
    offset: int = Field(default=0, ge=0)

    # Caps list sizes before per-item validation so a malformed/runaway model
    # response can't blow up the generated SQL with hundreds of OR clauses.
    @field_validator("text_all", "text_any", "tags", "category_ids", "annual_ranges", mode="before")
    @classmethod
    def _cap_list(cls, v: Any) -> Any:
        if isinstance(v, list):
            return v[:50]
        return v


class NoteVersionRead(BaseModel):
    id: str
    note_id: str
    title: str
    content: str
    tags: List[str]
    category_id: str
    created_at: UTCDatetime

    class Config:
        from_attributes = True


class NoteVersionListItem(BaseModel):
    id: str
    title: str
    content_preview: str
    created_at: UTCDatetime

    class Config:
        from_attributes = True


class RestoreVersionRequest(BaseModel):
    mode: Literal["in_place", "new_note"] = "in_place"


class SharedNoteRead(BaseModel):
    id: str
    title: str
    content: str
    tags: List[str]
    created_at: UTCDatetime
    modified_at: UTCDatetime
    author_username: str
    author_avatar_url: Optional[str] = None
    theme: Optional['ThemeRead'] = None
    content_preview: str = ""
    first_image_url: Optional[str] = None
    like_count: int = 0
    # Maps ids of childNote/noteReference blocks in `content` to the share
    # token of that note, for notes that are also shared. Lets the shared
    # view link to other shared notes instead of the private edit URL.
    linked_shared_notes: dict[str, str] = {}
    # Title of the parent note (if this note has one), shown even when the
    # parent isn't shared. parent_share_token is only set when the parent is
    # also shared, which is what makes the "Up to {parent}" link navigable.
    parent_title: Optional[str] = None
    parent_share_token: Optional[str] = None

    class Config:
        from_attributes = True


class LikeCountRead(BaseModel):
    like_count: int


# Annotation schemas
class AnnotationCreate(BaseModel):
    block_id: str
    text: str = ''


class AnnotationUpdate(BaseModel):
    text: Optional[str] = None
    block_id: Optional[str] = None


class AnnotationRead(BaseModel):
    id: str
    note_id: str
    block_id: str
    text: str
    created_at: UTCDatetime
    modified_at: UTCDatetime

    class Config:
        from_attributes = True


# AI Provider schemas
class AIProviderCreate(BaseModel):
    name: str
    provider_type: str
    api_key: str = ''
    base_url: Optional[str] = None
    model: str
    max_tokens: int = Field(default=16384, ge=1, le=200000)
    supports_images: bool = False
    enabled: bool = True
    is_active: bool = False


class AIProviderUpdate(BaseModel):
    name: Optional[str] = None
    provider_type: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    max_tokens: Optional[int] = Field(default=None, ge=1, le=200000)
    supports_images: Optional[bool] = None
    enabled: Optional[bool] = None
    is_active: Optional[bool] = None


class AIProviderRead(BaseModel):
    id: str
    name: str
    provider_type: str
    api_key: str = ""
    base_url: Optional[str]
    model: str
    max_tokens: int = 16384
    supports_images: bool = False
    enabled: bool
    is_active: bool

    @field_validator("api_key", mode="before")
    @classmethod
    def _redact(cls, v: Any) -> str:
        return ""

    class Config:
        from_attributes = True


class AIProviderTest(BaseModel):
    provider_id: Optional[str] = None
    provider_type: str
    api_key: str = ''
    base_url: Optional[str] = None
    model: str


# System Prompt schemas
class SystemPromptCreate(BaseModel):
    name: str
    content: str
    is_active: bool = False
    sort_order: int = 0


class SystemPromptUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


class SystemPromptRead(BaseModel):
    id: str
    name: str
    content: str
    is_active: bool
    sort_order: int

    class Config:
        from_attributes = True


# AI Session schemas
class AISessionCreate(BaseModel):
    name: str
    messages: str = '[]'
    context_scope: str = 'none'
    use_summaries: bool = False
    include_linked_files: bool = False
    plan_mode: bool = True


class AISessionUpdate(BaseModel):
    name: Optional[str] = None
    messages: Optional[str] = None
    context_scope: Optional[str] = None
    use_summaries: Optional[bool] = None
    include_linked_files: Optional[bool] = None
    plan_mode: Optional[bool] = None


class AISessionRead(BaseModel):
    id: str
    note_id: Optional[str] = None
    name: str
    messages: str
    context_scope: str
    use_summaries: bool
    include_linked_files: bool
    plan_mode: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime

    class Config:
        from_attributes = True


# Theme schemas
class ThemeCreate(BaseModel):
    name: str
    is_global: bool = False
    mode: str = "light"
    bg_type: str = "flat"
    bg_color1: str = "#f0f4ff"
    bg_color2: Optional[str] = None
    bg_image_url: Optional[str] = None
    bg_image_mode: str = "fill"
    bg_blur: float = 0.0
    glass_opacity: float = 0.30
    glass_blur: float = 12.0
    shadow_size: float = 8.0
    shadow_blur: float = 16.0


class ThemeUpdate(BaseModel):
    name: Optional[str] = None
    is_global: Optional[bool] = None
    mode: Optional[str] = None
    bg_type: Optional[str] = None
    bg_color1: Optional[str] = None
    bg_color2: Optional[str] = None
    bg_image_url: Optional[str] = None
    bg_image_mode: Optional[str] = None
    bg_blur: Optional[float] = None
    glass_opacity: Optional[float] = None
    glass_blur: Optional[float] = None
    shadow_size: Optional[float] = None
    shadow_blur: Optional[float] = None


class ThemeRead(BaseModel):
    id: str
    name: str
    user_id: Optional[str]
    is_global: bool
    mode: str
    bg_type: str
    bg_color1: str
    bg_color2: Optional[str]
    bg_image_url: Optional[str]
    bg_image_mode: str
    bg_blur: float
    glass_opacity: float
    glass_blur: float
    shadow_size: float
    shadow_blur: float
    created_at: datetime

    class Config:
        from_attributes = True


_CATALOG_KINDS = {"image", "tts", "stt"}


class ModelCatalogEntryCreate(BaseModel):
    kind: str
    model_id: str
    label: str
    maker_note: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True
    voices: Optional[List[str]] = None
    text_field: Optional[str] = None
    voice_field: Optional[str] = None
    extra_params: Optional[dict[str, Any]] = None

    @field_validator("kind")
    @classmethod
    def _validate_kind(cls, v: str) -> str:
        if v not in _CATALOG_KINDS:
            raise ValueError(f"kind must be one of {sorted(_CATALOG_KINDS)}")
        return v


class ModelCatalogEntryUpdate(BaseModel):
    # kind/model_id are immutable after creation (delete + recreate instead).
    label: Optional[str] = None
    maker_note: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None
    voices: Optional[List[str]] = None
    text_field: Optional[str] = None
    voice_field: Optional[str] = None
    extra_params: Optional[dict[str, Any]] = None


class ModelCatalogEntryRead(BaseModel):
    id: str
    kind: str
    model_id: str
    label: str
    maker_note: Optional[str] = None
    sort_order: int
    is_active: bool
    voices: Optional[List[str]] = None
    text_field: Optional[str] = None
    voice_field: Optional[str] = None
    extra_params: Optional[dict[str, Any]] = None
    created_at: datetime


# Settings schemas
class SettingsUpdate(BaseModel):
    settings: dict[str, Any]


# Media schemas
class MediaUploadResponse(BaseModel):
    url: str
    filename: str
    mime_type: str
    size: int


# Transcription job schemas (async video/audio -> transcript pipeline)
class TranscriptionJobRead(BaseModel):
    id: str
    status: str
    filename: Optional[str] = None
    result_url: Optional[str] = None
    error_message: Optional[str] = None


# Auth schemas
class UserCreate(BaseModel):
    username: str
    email: str
    password: str


class UserLogin(BaseModel):
    username: str
    password: str


class UserRead(BaseModel):
    id: str
    username: str
    email: str
    is_active: bool
    is_admin: bool
    avatar_url: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class UserUpdate(BaseModel):
    username: Optional[str] = None
    email: Optional[str] = None
    avatar_url: Optional[str] = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class AdminUserUpdate(BaseModel):
    is_active: Optional[bool] = None
    is_admin: Optional[bool] = None


class AdminPasswordReset(BaseModel):
    new_password: str


class UserMetrics(BaseModel):
    """Admin-facing usage metrics for a single user."""
    note_count: int
    folder_count: int
    shared_note_count: int
    total_likes: int
    last_login: Optional[UTCDatetime] = None
    created_at: UTCDatetime


class FileTypeBreakdown(BaseModel):
    category: str
    file_count: int
    total_bytes: int


class UserStorage(BaseModel):
    """On-demand size of a user's uploaded media folder."""
    total_bytes: int
    file_count: int
    by_type: List[FileTypeBreakdown] = []
    thumbnail_count: int = 0
    thumbnail_bytes: int = 0
    images_without_thumbnail: int = 0


class NoteMetrics(BaseModel):
    """Owner-facing stats for a single note (fetched on demand by the editor)."""
    word_count: int
    character_count: int
    reading_time_minutes: int
    content_bytes: int          # size of the stored BlockNote JSON
    resource_bytes: int         # combined size of referenced media (images, attachments)
    resource_count: int
    total_bytes: int            # content_bytes + resource_bytes
    version_count: int
    like_count: int
    is_shared: bool
    # Public view count for the shared page. Left unset for now — Umami analytics
    # isn't wired up, so `views_available` is False and clients hide/grey the row.
    views: Optional[int] = None
    views_available: bool = False
    created_at: UTCDatetime
    modified_at: UTCDatetime


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserRead
