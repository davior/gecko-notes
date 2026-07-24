"""Shared folder-hierarchy helpers used by both the notes and folders routers.

Kept in its own module (rather than in a router) so both routers can import it
without creating a router-to-router import cycle.
"""
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlmodel import Session, select

from app.models import Folder

# Marks the per-user Archive Bin (a special app-managed folder). "Archiving" a
# folder or note means re-parenting it into this Bin; permanent deletion happens
# when it is removed again from inside the Bin.
ARCHIVE_SYSTEM_KEY = "archive"


def get_folder_subtree(folder_id: str, user_id: str, session: Session, max_depth: int = 50) -> List[str]:
    """BFS walk returning folder_id and all descendant folder IDs owned by user_id."""
    result = [folder_id]
    queue = [folder_id]
    for _ in range(max_depth):
        if not queue:
            break
        next_queue = []
        for fid in queue:
            children = session.exec(
                select(Folder).where(Folder.user_id == user_id, Folder.parent_folder_id == fid)
            ).all()
            for child in children:
                result.append(child.id)
                next_queue.append(child.id)
        queue = next_queue
    return result


def get_archive_folder(session: Session, user_id: str) -> Optional[Folder]:
    """Return the user's Archive Bin if it exists, else None. Read-only — safe to
    call from GET handlers (unlike get_or_create_archive_folder, which writes)."""
    return session.exec(
        select(Folder).where(Folder.user_id == user_id, Folder.system_key == ARCHIVE_SYSTEM_KEY)
    ).first()


def get_or_create_archive_folder(session: Session, user_id: str) -> Folder:
    """Return the user's Archive Bin (a special root-level folder), creating it lazily."""
    existing = get_archive_folder(session, user_id)
    if existing:
        return existing
    now = datetime.now(timezone.utc)
    bin_folder = Folder(
        id=str(uuid.uuid4()),
        name="Archive Bin",
        parent_folder_id=None,
        user_id=user_id,
        sort_order=1_000_000,  # sorts last among top-level folders
        icon_type="emoji",
        icon_value="🗑️",
        system_key=ARCHIVE_SYSTEM_KEY,
        created_at=now,
        modified_at=now,
    )
    session.add(bin_folder)
    session.commit()
    session.refresh(bin_folder)
    return bin_folder


def archived_subtree_ids(session: Session, user_id: str) -> List[str]:
    """All folder IDs that count as 'archived' — the Archive Bin plus everything
    nested under it. Empty list if the user has no Bin yet. Used to exclude
    archived notes from root/global/search listings."""
    bin_folder = get_archive_folder(session, user_id)
    if not bin_folder:
        return []
    return get_folder_subtree(bin_folder.id, user_id, session)
