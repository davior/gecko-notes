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


class Note(SQLModel, table=True):
    id: str = Field(primary_key=True)
    title: str
    content: str  # BlockNote JSON serialised as string
    category_id: str = Field(foreign_key="category.id")
    tags: str = Field(default='[]')  # JSON array serialised as string
    is_pinned: bool = Field(default=False)
    summary: Optional[str] = None
    created_at: datetime
    modified_at: datetime


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


class SystemPrompt(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    content: str
    is_active: bool = Field(default=False)
    sort_order: int = Field(default=0)
    user_id: Optional[str] = Field(default=None, index=True)
