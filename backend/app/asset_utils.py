"""Registry helpers for note assets.

Media lives on disk in a flat, per-user layout (``MEDIA_DIR/{user_id}/{uuid}{ext}``),
so the filesystem cannot answer "which files belong to this note" — the ``noteasset``
table is what does, and this module is the machinery that keeps it in step with note
content.

The central rule is that reconciliation is **additive**: :func:`sync_note_assets`
registers media it finds in a note's blocks and never removes a row. That is what lets
an asset outlive its removal from the note body — it becomes "detached" and waits in
the Assets tab until the user curates it away. It also means every path that writes
media into a note (uploads, AI image generation, URL import, video renders, transcripts,
bulk import, plain copy-paste) is picked up without each one having to know about this
table.

Nothing here raises: asset bookkeeping runs alongside note saves and deletions, and it
must never be the reason one of those fails.
"""

import logging
import mimetypes
import os
import uuid
from dataclasses import dataclass
from typing import List, Optional, Tuple

import json
from sqlmodel import Session, col, or_, select

from app.models import Note, NoteAsset, Theme, TranscriptionJob, User, VideoRenderJob
from app.routers.media import MEDIA_DIR, categorize_extension

logger = logging.getLogger(__name__)

MEDIA_URL_PREFIX = "/media/"

# Origins record how a file came to belong to a note. Unlike "is it in the body right
# now" (recomputed on every read), this is a fact about the file's provenance and does
# not change when the note is edited.
ORIGIN_EMBEDDED = "embedded"    # added to the note body
ORIGIN_REFERENCE = "reference"  # source material kept alongside the note, never in it
ORIGIN_EXPORT = "export"        # produced from the note (video renders and their sidecars)


@dataclass
class MediaRef:
    """A ``/media/`` reference found in a note's blocks."""
    url: str
    name: Optional[str]
    caption: Optional[str]
    block_type: str


def extract_media_refs(content_str: str) -> List[MediaRef]:
    """Return the unique ``/media/...`` references in a note's BlockNote JSON.

    Covers images and the custom/built-in file blocks (videoFile, audioFile, file) —
    all of which store their location in ``props.url``. The block's ``props.name`` and
    ``props.caption`` come back too: uploads are stored under a UUID and the original
    filename is not recoverable from disk, so these are the only human-readable names
    available for media that was never registered at upload time.
    """
    try:
        blocks = json.loads(content_str)
    except Exception:
        return []

    refs: List[MediaRef] = []
    seen = set()

    def _text(value) -> Optional[str]:
        return value.strip() if isinstance(value, str) and value.strip() else None

    def walk(block_list):
        if not isinstance(block_list, list):
            return
        for block in block_list:
            if not isinstance(block, dict):
                continue
            props = block.get("props", {}) or {}
            url = props.get("url")
            if isinstance(url, str) and url.startswith(MEDIA_URL_PREFIX) and url not in seen:
                seen.add(url)
                refs.append(MediaRef(
                    url=url,
                    name=_text(props.get("name")),
                    caption=_text(props.get("caption")),
                    block_type=block.get("type") or "",
                ))
            walk(block.get("children", []) or [])

    walk(blocks)
    return refs


def extract_media_urls(content_str: str) -> List[str]:
    """Return the unique ``/media/...`` URLs referenced by a note's blocks."""
    return [ref.url for ref in extract_media_refs(content_str)]


def parse_media_url(url: str) -> Optional[Tuple[str, str]]:
    """Split a ``/media/{owner}/{filename}`` URL into its two segments.

    Returns None for anything that isn't exactly that shape, which is also what keeps
    a crafted URL in note content from steering a delete outside the media tree.
    """
    if not isinstance(url, str) or not url.startswith(MEDIA_URL_PREFIX):
        return None
    path = url.split("?", 1)[0].split("#", 1)[0]
    if "\\" in path:
        return None
    parts = path[len(MEDIA_URL_PREFIX):].split("/")
    if len(parts) != 2:
        return None
    owner, filename = parts
    if not owner or not filename or owner in (".", "..") or filename in (".", ".."):
        return None
    return owner, filename


def _disk_size(owner: str, filename: str) -> Optional[int]:
    try:
        return os.path.getsize(os.path.join(MEDIA_DIR, owner, filename))
    except OSError:
        return None


def kind_for(filename: str) -> str:
    return categorize_extension(os.path.splitext(filename)[1].lower())


def guess_mime(filename: str) -> Optional[str]:
    return mimetypes.guess_type(filename)[0]


def build_asset(
    *,
    user_id: str,
    note_id: str,
    url: str,
    original_name: Optional[str] = None,
    mime_type: Optional[str] = None,
    size_bytes: Optional[int] = None,
    origin: str = ORIGIN_EMBEDDED,
) -> Optional[NoteAsset]:
    """Build an unsaved NoteAsset row, filling in whatever wasn't supplied from disk."""
    parsed = parse_media_url(url)
    if not parsed:
        return None
    owner, filename = parsed
    return NoteAsset(
        id=str(uuid.uuid4()),
        user_id=user_id,
        note_id=note_id,
        url=url,
        filename=filename,
        original_name=(original_name or None),
        mime_type=mime_type or guess_mime(filename),
        size_bytes=size_bytes if size_bytes is not None else _disk_size(owner, filename),
        kind=kind_for(filename),
        origin=origin,
    )


def register_asset(
    session: Session,
    *,
    user_id: str,
    note_id: str,
    url: str,
    original_name: Optional[str] = None,
    mime_type: Optional[str] = None,
    size_bytes: Optional[int] = None,
    origin: str = ORIGIN_EMBEDDED,
) -> Optional[NoteAsset]:
    """Register one file against a note, or return the row that already covers it.

    Returns None when the note doesn't exist or isn't the caller's — registration is
    best-effort, so callers treat that as "not registered yet" rather than an error.
    """
    try:
        note = session.get(Note, note_id)
        if not note or note.user_id != user_id:
            return None

        existing = session.exec(
            select(NoteAsset).where(NoteAsset.note_id == note_id, NoteAsset.url == url)
        ).first()
        if existing:
            # A file reconciled from note content has no original name; an upload does.
            # Fill in the better label rather than leaving the UUID showing.
            if original_name and not existing.original_name:
                existing.original_name = original_name
                session.add(existing)
                session.commit()
                session.refresh(existing)
            return existing

        row = build_asset(
            user_id=user_id,
            note_id=note_id,
            url=url,
            original_name=original_name,
            mime_type=mime_type,
            size_bytes=size_bytes,
            origin=origin,
        )
        if row is None:
            return None
        session.add(row)
        session.commit()
        session.refresh(row)
        return row
    except Exception:
        session.rollback()
        logger.exception("Could not register asset %s on note %s", url, note_id)
        return None


def sync_note_assets(session: Session, note) -> int:
    """Register any media in ``note.content`` that isn't in the registry yet.

    Additive only — rows are never removed here, so a file stays listed after its block
    is deleted from the note. Returns the number of rows added.

    Call this *after* the note's own commit: it commits on its own and swallows
    everything, so a failure to register an asset can never take a note save down with
    it. The substring guard keeps text-only notes off the JSON-parsing path entirely,
    which matters because the editor autosaves every 800ms.
    """
    content = note.content or ""
    if MEDIA_URL_PREFIX not in content:
        return 0

    try:
        refs = extract_media_refs(content)
        if not refs:
            return 0

        known = set(session.exec(
            select(NoteAsset.url).where(NoteAsset.note_id == note.id)
        ).all())

        added = 0
        for ref in refs:
            if ref.url in known:
                continue
            row = build_asset(
                user_id=note.user_id,
                note_id=note.id,
                url=ref.url,
                original_name=ref.name or ref.caption,
                origin=ORIGIN_EMBEDDED,
            )
            if row is None:
                continue
            session.add(row)
            known.add(ref.url)
            added += 1

        if added:
            session.commit()
        return added
    except Exception:
        # A unique-constraint clash from two saves racing is the expected case here,
        # and it means the other save already registered the file.
        session.rollback()
        logger.debug("Could not reconcile assets for note %s", getattr(note, "id", "?"), exc_info=True)
        return 0


def file_is_referenced(
    session: Session,
    user_id: str,
    filename: str,
    exclude_asset_id: Optional[str] = None,
) -> bool:
    """True if anything still points at this file, so it must not be unlinked.

    Note versions are deliberately *not* consulted. Snapshots embed the URLs they were
    taken with, so nearly every file the user has ever used appears in one — guarding
    against them would mean almost nothing could ever be deleted, which is the opposite
    of the point. Deleting an asset can therefore leave a missing item in an older
    version of a note; the confirm dialog says so.
    """
    suffix = f"/{filename}"

    stmt = select(NoteAsset.id).where(
        NoteAsset.user_id == user_id,
        NoteAsset.filename == filename,
    )
    if exclude_asset_id:
        stmt = stmt.where(NoteAsset.id != exclude_asset_id)
    if session.exec(stmt.limit(1)).first():
        return True

    if session.exec(
        select(User.id)
        .where(User.id == user_id, col(User.avatar_url).endswith(suffix))
        .limit(1)
    ).first():
        return True

    if session.exec(
        select(Theme.id)
        .where(
            or_(Theme.user_id == user_id, Theme.is_global == True),  # noqa: E712
            col(Theme.bg_image_url).endswith(suffix),
        )
        .limit(1)
    ).first():
        return True

    if session.exec(
        select(TranscriptionJob.id)
        .where(
            TranscriptionJob.user_id == user_id,
            or_(
                TranscriptionJob.source_filename == filename,
                TranscriptionJob.result_filename == filename,
            ),
        )
        .limit(1)
    ).first():
        return True

    if session.exec(
        select(VideoRenderJob.id)
        .where(
            VideoRenderJob.user_id == user_id,
            or_(
                VideoRenderJob.result_filename == filename,
                VideoRenderJob.subtitle_filename == filename,
                VideoRenderJob.thumbnail_filename == filename,
            ),
        )
        .limit(1)
    ).first():
        return True

    return False


def remove_media_file(owner: str, filename: str) -> bool:
    """Unlink a file from the media tree along with its thumbnail sidecar."""
    file_path = os.path.join(MEDIA_DIR, owner, filename)
    removed = False
    try:
        os.remove(file_path)
        removed = True
    except FileNotFoundError:
        pass
    except OSError:
        logger.exception("Could not delete media file %s", file_path)
        return False

    # Local import: thumbnails.py reads MEDIA_DIR/IMAGE_EXTENSIONS from routers.media
    # at import time, so importing it at module scope would close a cycle.
    from app.thumbnails import thumbnail_filename_for

    thumb_path = os.path.join(MEDIA_DIR, owner, thumbnail_filename_for(filename))
    try:
        os.remove(thumb_path)
    except OSError:
        pass
    return removed


def release_media_file(
    session: Session,
    user_id: str,
    url: str,
    exclude_asset_id: Optional[str] = None,
) -> bool:
    """Unlink the file behind ``url`` if nothing else needs it. True if it was removed.

    Takes the URL rather than a row so it can be called after the row is gone, which is
    the order deletion has to run in: the refcount check below counts remaining rows, so
    the one being deleted must already be committed away.
    """
    parsed = parse_media_url(url)
    if not parsed:
        return False
    owner, filename = parsed

    # Content pasted in from someone else's shared note points into their media dir.
    # Dropping our row is right; touching their file is not.
    if owner != user_id:
        return False

    if file_is_referenced(session, user_id, filename, exclude_asset_id=exclude_asset_id):
        return False

    return remove_media_file(owner, filename)


def purge_note_assets(session: Session, note_id: str) -> int:
    """Drop a note's asset rows and unlink the files nothing else references.

    For permanent deletion only. Archiving is a soft delete — the note can come back, so
    its files must stay put.
    """
    try:
        rows = session.exec(select(NoteAsset).where(NoteAsset.note_id == note_id)).all()
        if not rows:
            return 0
        # Snapshot before deleting: the rows are detached once committed away.
        pending = [(row.user_id, row.url) for row in rows]
        for row in rows:
            session.delete(row)
        # Commit first so the reference check below sees the post-delete state.
        session.commit()

        removed = 0
        for user_id, url in pending:
            if release_media_file(session, user_id, url):
                removed += 1
        return removed
    except Exception:
        session.rollback()
        logger.exception("Could not purge assets for note %s", note_id)
        return 0
