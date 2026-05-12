from typing import Optional, Any, List, Generic, TypeVar
from datetime import datetime
from pydantic import BaseModel

T = TypeVar("T")


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


# Note schemas
class NoteCreate(BaseModel):
    title: str
    content: str = '[]'
    category_id: str
    tags: List[str] = []


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    category_id: Optional[str] = None
    tags: Optional[List[str]] = None
    is_pinned: Optional[bool] = None


class NoteRead(BaseModel):
    id: str
    title: str
    content: str
    category_id: str
    tags: List[str]
    is_pinned: bool
    created_at: datetime
    modified_at: datetime

    class Config:
        from_attributes = True


class NoteListItem(BaseModel):
    id: str
    title: str
    content_preview: str
    first_image_url: Optional[str]
    category_id: str
    tags: List[str]
    is_pinned: bool
    created_at: datetime
    modified_at: datetime

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
    api_key: str
    base_url: Optional[str]
    model: str
    enabled: bool
    is_active: bool

    class Config:
        from_attributes = True


class AIProviderTest(BaseModel):
    provider_type: str
    api_key: str = ''
    base_url: Optional[str] = None
    model: str


# Settings schemas
class SettingsUpdate(BaseModel):
    settings: dict[str, Any]


# Media schemas
class MediaUploadResponse(BaseModel):
    url: str
    filename: str
    mime_type: str
    size: int
