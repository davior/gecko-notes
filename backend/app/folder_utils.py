"""Shared folder-hierarchy helpers used by both the notes and folders routers.

Kept in its own module (rather than in a router) so both routers can import it
without creating a router-to-router import cycle.
"""
from typing import List

from sqlmodel import Session, select

from app.models import Folder


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
