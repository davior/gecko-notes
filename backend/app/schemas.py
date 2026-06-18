from typing import Optional, Any, List, Generic, TypeVar, Literal, Annotated
from datetime import datetime, timezone
from pydantic import BaseModel, field_validator, PlainSerializer

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


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    parent_folder_id: Optional[str] = None  # set to move the folder
    sort_order: Optional[int] = None


class FolderRead(BaseModel):
    id: str
    name: str
    parent_folder_id: Optional[str] = None
    sort_order: int
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
    category_id: str
    folder_id: Optional[str] = None
    parent_note_id: Optional[str] = None
    tags: List[str]
    is_pinned: bool
    is_shared: bool = False
    created_at: UTCDatetime
    modified_at: UTCDatetime

    class Config:
        from_attributes = True


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

    class Config:
        from_attributes = True


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
    enabled: bool = True
    is_active: bool = False


class AIProviderUpdate(BaseModel):
    name: Optional[str] = None
    provider_type: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    enabled: Optional[bool] = None
    is_active: Optional[bool] = None


class AIProviderRead(BaseModel):
    id: str
    name: str
    provider_type: str
    api_key: str = ""
    base_url: Optional[str]
    model: str
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


# Settings schemas
class SettingsUpdate(BaseModel):
    settings: dict[str, Any]


# Media schemas
class MediaUploadResponse(BaseModel):
    url: str
    filename: str
    mime_type: str
    size: int


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


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserRead
