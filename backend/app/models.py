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


class AIProvider(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    provider_type: str  # "anthropic" | "openai" | "ollama" | "custom"
    api_key: str = Field(default='')
    base_url: Optional[str] = None
    model: str
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
    kind: str = Field(index=True)        # "tts" | "stt" | "ai"
    model: str = Field(default="")
    units: int = Field(default=0)        # chars (tts) / seconds (stt) / tokens (ai)
    unit_type: str = Field(default="")   # "chars" | "seconds" | "tokens"
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class SystemPrompt(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    content: str
    is_active: bool = Field(default=False)
    sort_order: int = Field(default=0)
    user_id: Optional[str] = Field(default=None, index=True)


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
