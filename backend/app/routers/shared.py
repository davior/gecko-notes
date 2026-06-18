import json
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlmodel import Session, select

from app.database import get_session
from app.models import Note, User, UserSetting, Theme
from app.schemas import DataResponse, SharedNoteRead, ThemeRead
from app.routers.notes import extract_first_image, extract_plain_text

router = APIRouter()


@router.get("/{token}", response_model=DataResponse[SharedNoteRead])
def get_shared_note(token: str, session: Session = Depends(get_session)):
    note = session.exec(
        select(Note).where(Note.share_token == token, Note.is_shared == True)
    ).first()
    if not note:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Shared note not found"})

    author = session.get(User, note.user_id) if note.user_id else None

    theme_data = None
    if note.user_id:
        setting = session.exec(
            select(UserSetting).where(
                UserSetting.user_id == note.user_id,
                UserSetting.key == "shared_theme_id",
            )
        ).first()
        if setting:
            try:
                theme_id = json.loads(setting.value)
                if isinstance(theme_id, str):
                    t = session.get(Theme, theme_id)
                    if t:
                        theme_data = ThemeRead.model_validate(t)
            except Exception:
                pass

    try:
        tags = json.loads(note.tags)
    except Exception:
        tags = []

    content_preview = extract_plain_text(note.content, 200)
    first_image_url = extract_first_image(note.content)

    return DataResponse(data=SharedNoteRead(
        id=note.id,
        title=note.title,
        content=note.content,
        tags=tags,
        created_at=note.created_at,
        modified_at=note.modified_at,
        author_username=author.username if author else "Unknown",
        author_avatar_url=author.avatar_url if author else None,
        theme=theme_data,
        content_preview=content_preview,
        first_image_url=first_image_url,
    ))


@router.get("/{token}/preview", response_class=HTMLResponse)
def get_shared_note_preview(token: str, request: Request, session: Session = Depends(get_session)):
    """Returns HTML with OpenGraph and Twitter Card meta tags for social media previews."""
    note = session.exec(
        select(Note).where(Note.share_token == token, Note.is_shared == True)
    ).first()
    if not note:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Shared note not found"})

    author = session.get(User, note.user_id) if note.user_id else None

    content_preview = extract_plain_text(note.content, 200)
    first_image_url = extract_first_image(note.content)

    # Construct absolute URLs using X-Forwarded headers (from reverse proxy) or fallback to request.url
    host = request.headers.get("X-Forwarded-Host", request.url.netloc)
    if not host:
        host = request.url.netloc or "localhost"

    # For scheme: if behind reverse proxy (X-Forwarded-Host is set), default to HTTPS
    # since reverse proxy handles SSL/TLS termination. Otherwise use X-Forwarded-Proto or request.url.scheme
    if request.headers.get("X-Forwarded-Host"):
        scheme = "https"
    else:
        scheme = request.headers.get("X-Forwarded-Proto", request.url.scheme or "https")
        if scheme:
            scheme = scheme.lower().split("/")[0].split(":")[0]
        scheme = scheme or "https"

    base_url = f"{scheme}://{host}"
    # og:url points to the actual note viewer (what users see when they click the preview)
    note_view_url = f"{base_url}/shared/{token}"
    # preview_url is the current endpoint (what gets shared on social media)
    preview_url = f"{base_url}/api/shared/{token}/preview"

    # Use first image from note, fallback to author avatar, fallback to a generic image
    preview_image = first_image_url or (author.avatar_url if author else None) or "/api/media/gecko-logo.png"

    # Ensure image URL is absolute
    if preview_image and not preview_image.startswith(("http://", "https://")):
        preview_image = f"{base_url}{preview_image}"

    # Escape HTML special characters
    def escape_html(s: str) -> str:
        return (s.replace("&", "&amp;")
                 .replace("<", "&lt;")
                 .replace(">", "&gt;")
                 .replace('"', "&quot;")
                 .replace("'", "&#x27;"))

    title = escape_html(note.title or "Shared Note")
    description = escape_html(content_preview or "Check out this note on Gecko Notes")
    author_name = escape_html(author.username if author else "Anonymous")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <meta name="description" content="{description}">

    <!-- Open Graph / Facebook -->
    <!-- og:url is self-referential (this preview endpoint) so crawlers read THESE
         tags rather than following to the SPA, which has no per-note meta tags. -->
    <meta property="og:type" content="article">
    <meta property="og:url" content="{escape_html(preview_url)}">
    <meta property="og:title" content="{title}">
    <meta property="og:description" content="{description}">
    <meta property="og:image" content="{escape_html(preview_image)}">
    <meta property="og:site_name" content="Gecko Notes">

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:url" content="{escape_html(preview_url)}">
    <meta name="twitter:title" content="{title}">
    <meta name="twitter:description" content="{description}">
    <meta name="twitter:image" content="{escape_html(preview_image)}">

    <!-- Article metadata -->
    <meta property="article:author" content="{author_name}">
    <meta property="article:published_time" content="{note.created_at.isoformat()}">
    <meta property="article:modified_time" content="{note.modified_at.isoformat()}">

</head>
<body>
    <p><a href="{escape_html(note_view_url)}">Click here to view the note</a></p>
    <script>window.location.href = "{escape_html(note_view_url)}";</script>
</body>
</html>"""

    return html
