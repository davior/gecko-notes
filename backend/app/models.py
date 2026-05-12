from typing import Optional
from datetime import datetime
from sqlmodel import SQLModel, Field


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


class AppSetting(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str  # JSON-serialised value
