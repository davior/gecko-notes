import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session, select, col

from app.database import get_session
from app.folder_utils import get_folder_subtree
from app.models import Folder, Note, NoteVersion, Annotation
from app.schemas import (
    FolderCreate, FolderUpdate, FolderRead, FolderContents,
    DataResponse, ListResponse,
)

router = APIRouter()

ARCHIVE_SYSTEM_KEY = "archive"


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user_id


def _get_owned_folder(session: Session, folder_id: str, user_id: str) -> Folder:
    folder = session.get(Folder, folder_id)
    if not folder or folder.user_id != user_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Folder not found"})
    return folder


def _is_descendant(session: Session, candidate_parent_id: Optional[str], folder_id: str, max_depth: int = 1000) -> bool:
    """True if candidate_parent_id is folder_id itself or one of its descendants.

    Walks the ancestor chain of candidate_parent_id; if we reach folder_id then
    moving folder_id under candidate_parent_id would create a cycle.
    """
    cur = candidate_parent_id
    seen = 0
    while cur is not None and seen < max_depth:
        if cur == folder_id:
            return True
        parent = session.get(Folder, cur)
        cur = parent.parent_folder_id if parent else None
        seen += 1
    return False


def _breadcrumb(session: Session, folder: Folder, user_id: str, max_depth: int = 1000) -> list[Folder]:
    """Ordered ancestor chain root..folder (inclusive)."""
    chain: list[Folder] = []
    cur: Optional[Folder] = folder
    seen = 0
    while cur is not None and seen < max_depth:
        chain.append(cur)
        cur = session.get(Folder, cur.parent_folder_id) if cur.parent_folder_id else None
        seen += 1
    chain.reverse()
    return chain


def _reject_if_system(folder: Folder) -> None:
    """Block direct rename/move/customize/delete of app-managed folders (the Bin)."""
    if folder.system_key:
        raise HTTPException(
            status_code=400,
            detail={"code": "system_folder", "message": "This folder can't be modified"},
        )


def get_or_create_archive_folder(session: Session, user_id: str) -> Folder:
    """Return the user's Archive Bin (a special root-level folder), creating it lazily."""
    existing = session.exec(
        select(Folder).where(Folder.user_id == user_id, Folder.system_key == ARCHIVE_SYSTEM_KEY)
    ).first()
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


def _delete_note_hard(session: Session, note: Note) -> None:
    """Permanently delete a note plus its versions/annotations, orphaning any child
    notes — mirrors the note router's delete_note cleanup."""
    for version in session.exec(select(NoteVersion).where(NoteVersion.note_id == note.id)).all():
        session.delete(version)
    for annotation in session.exec(select(Annotation).where(Annotation.note_id == note.id)).all():
        session.delete(annotation)
    for child in session.exec(select(Note).where(Note.parent_note_id == note.id)).all():
        child.parent_note_id = None
        session.add(child)
    session.delete(note)


def _delete_folder_recursive(session: Session, folder_id: str, user_id: str) -> None:
    """Permanently delete a folder and everything nested inside it (subfolders + notes).
    Does not commit — the caller owns the transaction boundary."""
    subtree_ids = get_folder_subtree(folder_id, user_id, session)
    for note in session.exec(
        select(Note).where(Note.user_id == user_id, col(Note.folder_id).in_(subtree_ids))
    ).all():
        _delete_note_hard(session, note)
    folders_by_id = {
        f.id: f
        for f in session.exec(
            select(Folder).where(Folder.user_id == user_id, col(Folder.id).in_(subtree_ids))
        ).all()
    }
    # Deepest-first (reverse of the BFS order) so a parent is never removed before its child.
    for fid in reversed(subtree_ids):
        f = folders_by_id.get(fid)
        if f is not None:
            session.delete(f)


@router.get("", response_model=ListResponse[FolderRead])
def list_folders(
    request: Request,
    parent_folder_id: Optional[str] = None,
    in_parent: bool = Query(False),
    session: Session = Depends(get_session),
):
    """Flat list of the user's folders. With in_parent, scope to a single parent
    (parent_folder_id omitted ⇒ top level); otherwise return all folders (used by
    the move-to picker)."""
    user_id = _get_user_id(request)
    query = select(Folder).where(Folder.user_id == user_id)
    if in_parent:
        query = query.where(Folder.parent_folder_id == parent_folder_id)
    folders = session.exec(query.order_by(Folder.sort_order, Folder.name)).all()
    return ListResponse(
        data=[FolderRead.model_validate(f) for f in folders],
        total=len(folders),
        limit=len(folders),
        offset=0,
    )


@router.get("/{folder_id}/contents", response_model=DataResponse[FolderContents])
def folder_contents(folder_id: str, request: Request, session: Session = Depends(get_session)):
    """Folder chrome: the folder itself, its breadcrumb trail and its subfolders.
    folder_id == "root" returns the top level (folder=None, empty breadcrumb)."""
    user_id = _get_user_id(request)

    if folder_id == "root":
        folder_read = None
        breadcrumb: list[FolderRead] = []
        parent = None
    else:
        folder = _get_owned_folder(session, folder_id, user_id)
        folder_read = FolderRead.model_validate(folder)
        breadcrumb = [FolderRead.model_validate(f) for f in _breadcrumb(session, folder, user_id)]
        parent = folder.id

    subfolders = session.exec(
        select(Folder)
        .where(Folder.user_id == user_id, Folder.parent_folder_id == parent)
        .order_by(Folder.sort_order, Folder.name)
    ).all()

    return DataResponse(data=FolderContents(
        folder=folder_read,
        breadcrumb=breadcrumb,
        subfolders=[FolderRead.model_validate(f) for f in subfolders],
    ))


@router.post("", response_model=DataResponse[FolderRead], status_code=201)
def create_folder(payload: FolderCreate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    if payload.parent_folder_id:
        _get_owned_folder(session, payload.parent_folder_id, user_id)
    now = datetime.now(timezone.utc)
    folder = Folder(
        id=str(uuid.uuid4()),
        name=payload.name,
        parent_folder_id=payload.parent_folder_id,
        user_id=user_id,
        sort_order=payload.sort_order,
        icon_type=payload.icon_type,
        icon_value=payload.icon_value,
        color=payload.color,
        created_at=now,
        modified_at=now,
    )
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return DataResponse(data=FolderRead.model_validate(folder))


@router.put("/{folder_id}", response_model=DataResponse[FolderRead])
def update_folder(folder_id: str, payload: FolderUpdate, request: Request, session: Session = Depends(get_session)):
    user_id = _get_user_id(request)
    folder = _get_owned_folder(session, folder_id, user_id)
    _reject_if_system(folder)

    if payload.name is not None:
        folder.name = payload.name
    if payload.sort_order is not None:
        folder.sort_order = payload.sort_order
    if payload.icon_type is not None:
        folder.icon_type = payload.icon_type
    if payload.icon_value is not None:
        folder.icon_value = payload.icon_value
    if payload.color is not None:
        folder.color = payload.color
    # Move: re-parent, guarding against cycles.
    if "parent_folder_id" in payload.model_fields_set:
        new_parent = payload.parent_folder_id or None
        if new_parent == folder.id or _is_descendant(session, new_parent, folder.id):
            raise HTTPException(
                status_code=400,
                detail={"code": "cycle", "message": "Cannot move a folder into itself or a descendant"},
            )
        if new_parent:
            _get_owned_folder(session, new_parent, user_id)
        folder.parent_folder_id = new_parent

    folder.modified_at = datetime.now(timezone.utc)
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return DataResponse(data=FolderRead.model_validate(folder))


@router.delete("/{folder_id}", status_code=204)
def delete_folder(
    folder_id: str,
    request: Request,
    recursive: bool = Query(False),
    session: Session = Depends(get_session),
):
    """Delete a folder. By default its contents are re-parented to the folder's parent
    so nothing is orphaned or lost. With ?recursive=true the folder and everything
    nested inside it (subfolders + notes) are permanently deleted."""
    user_id = _get_user_id(request)
    folder = _get_owned_folder(session, folder_id, user_id)
    _reject_if_system(folder)

    if recursive:
        _delete_folder_recursive(session, folder_id, user_id)
        session.commit()
        return

    new_parent = folder.parent_folder_id

    for sub in session.exec(
        select(Folder).where(Folder.user_id == user_id, Folder.parent_folder_id == folder_id)
    ).all():
        sub.parent_folder_id = new_parent
        session.add(sub)

    for note in session.exec(
        select(Note).where(Note.user_id == user_id, Note.folder_id == folder_id)
    ).all():
        note.folder_id = new_parent
        session.add(note)

    session.delete(folder)
    session.commit()


@router.post("/archive/empty", status_code=204)
def empty_archive(request: Request, session: Session = Depends(get_session)):
    """Permanently delete everything inside the Archive Bin, keeping the Bin itself."""
    user_id = _get_user_id(request)
    bin_folder = session.exec(
        select(Folder).where(Folder.user_id == user_id, Folder.system_key == ARCHIVE_SYSTEM_KEY)
    ).first()
    if not bin_folder:
        return
    for child in session.exec(
        select(Folder).where(Folder.user_id == user_id, Folder.parent_folder_id == bin_folder.id)
    ).all():
        _delete_folder_recursive(session, child.id, user_id)
    for note in session.exec(
        select(Note).where(Note.user_id == user_id, Note.folder_id == bin_folder.id)
    ).all():
        _delete_note_hard(session, note)
    session.commit()


@router.post("/{folder_id}/archive", response_model=DataResponse[FolderRead])
def archive_folder(folder_id: str, request: Request, session: Session = Depends(get_session)):
    """Move a folder (with everything nested inside it) into the Archive Bin instead of
    deleting it. The Bin is created lazily on first use."""
    user_id = _get_user_id(request)
    folder = _get_owned_folder(session, folder_id, user_id)
    if folder.system_key == ARCHIVE_SYSTEM_KEY:
        raise HTTPException(
            status_code=400,
            detail={"code": "system_folder", "message": "The Archive Bin can't be archived"},
        )
    bin_folder = get_or_create_archive_folder(session, user_id)
    folder.parent_folder_id = bin_folder.id
    folder.modified_at = datetime.now(timezone.utc)
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return DataResponse(data=FolderRead.model_validate(folder))
