"""Apply an approved plan's actions to notes.

A port of `frontend/src/services/planExecutor.ts`, which ran this in the browser
against the REST API. Working directly against the database makes each handler
shorter, but the behaviour is deliberately identical — several of the helpers below
encode things learned from real model output and are not simplifications waiting to
happen:

  * a section heading has three forms, because models emit all three
  * embeds have to be rescued across a section rewrite, because Markdown cannot
    express them and the rewrite would otherwise delete them
  * one version snapshot per note per run, not one per step
  * every action is caught on its own, so one failure never abandons the rest

Cancellation is checked before each action *and* immediately before each write. The
second check is the one that matters: a run cancelled while the worker sat in a slow
generation call must not land one more edit on a note the user has already unlocked.
"""

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from sqlmodel import Session, select

from app.blocks.markdown_blocks import markdown_to_blocks
from app.models import Annotation, Category, Folder, Note, Recipe

logger = logging.getLogger(__name__)

# A bold paragraph longer than this is a sentence, not a heading. Without the cap, a
# long bold line inside a section would be read as a boundary and cut it short.
PSEUDO_HEADING_MAX_LEN = 100

# Bold pseudo-headings sort below every real heading (1-6) so a real heading always
# wins as a section boundary.
PSEUDO_HEADING_LEVEL = 7


class Cancelled(Exception):
    """Raised at a checkpoint when the run has been stopped."""


@dataclass
class ActionResult:
    """One row of the summary written back into the chat."""

    ok: bool
    message: str
    kind: Optional[str] = None          # "respond" for conversational output
    notes_changed: bool = False
    touched_current_note: bool = False
    annotations_changed: bool = False
    recipes_changed: bool = False
    note_id: Optional[str] = None       # for the summary's note pill
    note_title: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "message": self.message,
            "kind": self.kind,
            "notes_changed": self.notes_changed,
            "touched_current_note": self.touched_current_note,
            "annotations_changed": self.annotations_changed,
            "recipes_changed": self.recipes_changed,
            "note_id": self.note_id,
            "note_title": self.note_title,
        }


@dataclass
class ExecContext:
    """`PlanExecContext` without the live editor — the ids the plan may target.

    The allow-lists are not decoration: the model works from a reference block and
    will happily name a note id it saw earlier in the transcript. Anything not in
    context is refused rather than guessed at.
    """

    user_id: str
    current_note_id: Optional[str] = None
    default_category_id: str = ""
    current_folder_id: Optional[str] = None
    valid_note_ids: Set[str] = field(default_factory=set)
    valid_folder_ids: Set[str] = field(default_factory=set)
    valid_category_ids: Set[str] = field(default_factory=set)
    valid_annotation_ids: Set[str] = field(default_factory=set)
    valid_recipe_ids: Set[str] = field(default_factory=set)

    @classmethod
    def from_json(cls, raw: str, user_id: str) -> "ExecContext":
        try:
            data = json.loads(raw or "{}") or {}
        except (ValueError, TypeError):
            data = {}
        return cls(
            user_id=user_id,
            current_note_id=data.get("current_note_id"),
            default_category_id=data.get("default_category_id") or "",
            current_folder_id=data.get("current_folder_id"),
            valid_note_ids=set(data.get("valid_note_ids") or []),
            valid_folder_ids=set(data.get("valid_folder_ids") or []),
            valid_category_ids=set(data.get("valid_category_ids") or []),
            valid_annotation_ids=set(data.get("valid_annotation_ids") or []),
            valid_recipe_ids=set(data.get("valid_recipe_ids") or []),
        )


# Which id each body-rewriting action targets. Mirrors the handlers that reach
# `_write_content`: the remaining actions name a note without touching its content,
# and a note whose body is not being rewritten has no reason to go read-only. Both
# guards this feeds are about the body — the editor stops accepting keystrokes, and
# `PUT /notes/{id}` refuses a content write — while title, tags, category and
# annotations never race it.
BODY_WRITING_TARGETS = {
    "edit_note": "noteId",
    "edit_section": "noteId",
    "append_note": "noteId",
    # The child's own row is new, but its block is written into the parent's body,
    # so the parent is what locks.
    "create_child_note": "parentId",
    "add_reference": "noteId",
    "create_diagram": "noteId",
    "edit_diagram": "noteId",
    "generate_image": "noteId",
}


def _declared_refs(plan: Dict[str, Any]) -> Set[str]:
    """The `ref` labels a plan assigns to the things it creates.

    A later action may target one of these instead of a real id. Those notes do not
    exist yet, so nobody has one open and nothing needs holding — but they have to be
    recognised here, or the single-note fallback below would read a ref as a stale id
    and hold whichever note happened to be in context.
    """
    refs = set()
    for action in plan.get("actions") or []:
        if not isinstance(action, dict):
            continue
        ref = action.get("ref")
        if isinstance(ref, str) and ref:
            refs.add(ref)
    return refs


def touched_note_ids(plan: Dict[str, Any], exec_ctx: Dict[str, Any]) -> List[str]:
    """Every note a plan will rewrite, so the editor knows what to hold read-only.

    The plan's targets are the whole answer, and deliberately so. Nothing is held
    before there is a plan, because until one exists there is nothing to say what
    needs holding; and the note the request was made from is not special once there
    is, because asking a question about a note is not the same as editing it.

    Derived from the plan rather than trusting a client-supplied list, and intersected
    with the ids the run is allowed to touch — a note the plan names but the context
    does not contain would be refused by the executor anyway.

    Lives here rather than in the router because the resolution below has to mirror
    `PlanExecutor._resolve_note`, and because both callers need it: the router when a
    plan arrives already approved, and the worker the moment it finishes planning one
    of its own.
    """
    allowed = set(exec_ctx.get("valid_note_ids") or [])
    current = exec_ctx.get("current_note_id")
    refs = _declared_refs(plan)
    touched = set()
    for action in plan.get("actions") or []:
        if not isinstance(action, dict):
            continue
        key = BODY_WRITING_TARGETS.get(action.get("type"))
        if key is None:
            continue
        value = action.get(key)
        if not isinstance(value, str) or value in refs:
            continue
        if value in allowed:
            touched.add(value)
        elif value.lower() in ("current", "this", "thisnote", "this_note") and current:
            touched.add(current)
        elif len(allowed) == 1:
            # Mirrors the executor's single-note fallback.
            touched.update(allowed)
    return sorted(touched)


# ─── block helpers ───────────────────────────────────────────────────────────


def parse_blocks(content: Optional[str]) -> List[Any]:
    try:
        parsed = json.loads(content or "[]")
    except (ValueError, TypeError):
        return []
    return parsed if isinstance(parsed, list) else []


def normalize_heading(text: str) -> str:
    """Reduce a heading to a canonical form for matching.

    Heading blocks store only their plain text — the level lives in props, so
    "## Chapter 1" is stored as "Chapter 1" — but the model is given note bodies as
    Markdown and routinely copies a decorated form into `section`. Normalising both
    sides means "## Chapter 1", "**Chapter 1**" and "Chapter 1." all match.
    """
    out = text
    out = re.sub(r"[‘’]", "'", out)
    out = re.sub(r"[“”]", '"', out)
    out = re.sub(r"[*_]+", "", out)
    out = out.strip()
    out = re.sub(r"^#{1,6}\s*", "", out)
    out = re.sub(r"\s+#+$", "", out)
    out = re.sub(r"\s+", " ", out)
    out = re.sub(r"[.,:;!?]+$", "", out)
    return out.strip().lower()


def block_text(block: Any) -> str:
    """A block's concatenated top-level inline text."""
    if not isinstance(block, dict):
        return ""
    content = block.get("content")
    if not isinstance(content, list):
        return ""
    return "".join(str(c.get("text") or "") for c in content if isinstance(c, dict))


def _atx_level(text: str) -> int:
    """Leading ATX level of a literal Markdown line, or 0. A run of "#" with no
    following space and text ("#tag") is not a heading."""
    match = re.match(r"^(#{1,6})\s+\S", text.strip())
    return len(match.group(1)) if match else 0


def _bold_pseudo_heading(block: Any) -> Optional[str]:
    """A short, entirely-bold paragraph read as a heading.

    Pasted articles often use "**Section title**" lines instead of real headings, and
    the model targets them by name like any other section.
    """
    if not isinstance(block, dict) or block.get("type") != "paragraph":
        return None
    content = block.get("content")
    if not isinstance(content, list) or not content:
        return None
    text = ""
    for node in content:
        # Any non-text run, or any run that isn't bold, means this isn't a bold line.
        if not isinstance(node, dict) or node.get("type") != "text":
            return None
        if (node.get("styles") or {}).get("bold") is not True:
            return None
        text += str(node.get("text") or "")
    trimmed = text.strip()
    return trimmed if trimmed and len(trimmed) <= PSEUDO_HEADING_MAX_LEN else None


def section_heading(block: Any) -> Optional[Tuple[int, str]]:
    """`(level, text)` if this block acts as a section heading, else None."""
    text = block_text(block)
    if isinstance(block, dict) and block.get("type") == "heading":
        try:
            level = int((block.get("props") or {}).get("level", 1))
        except (TypeError, ValueError):
            level = 1
        return level, text
    level = _atx_level(text)
    if level:
        return level, text
    bold = _bold_pseudo_heading(block)
    return (PSEUDO_HEADING_LEVEL, bold) if bold else None


def find_section_index(blocks: Sequence[Any], section: str) -> int:
    """Index of the block acting as `section`, or -1.

    Exact normalised match first, then substring — shared by edit_section,
    add_reference and generate_image so section targeting behaves identically in all
    three.
    """
    target = normalize_heading(section or "")
    if not target:
        return -1

    def search(exact: bool) -> int:
        for index, block in enumerate(blocks):
            found = section_heading(block)
            if not found:
                continue
            heading = normalize_heading(found[1])
            if (heading == target) if exact else (target in heading):
                return index
        return -1

    hit = search(exact=True)
    return hit if hit != -1 else search(exact=False)


def collect_embeds(blocks: Sequence[Any]) -> List[Any]:
    """Child-note, reference and diagram blocks found anywhere in `blocks`.

    None of them can be expressed in Markdown, so a section rewritten from the
    model's Markdown cannot reproduce them; they are re-appended instead of dropped.
    """
    out: List[Any] = []

    def walk(block: Any) -> None:
        if not isinstance(block, dict):
            return
        if block.get("type") in ("childNote", "noteReference", "diagram"):
            out.append(block)
        for child in block.get("children") or []:
            walk(child)

    for block in blocks:
        walk(block)
    return out


def block_texts_with_ids(blocks: Sequence[Any]) -> List[Tuple[str, str]]:
    """`(block_id, text)` for every block carrying an id, children included.

    The Python twin of `extractBlockTexts`: the model only sees Markdown, so it
    anchors an annotation by quoting a snippet rather than naming a block id.
    """
    out: List[Tuple[str, str]] = []

    def walk(block: Any) -> None:
        if not isinstance(block, dict):
            return
        block_id = block.get("id")
        if isinstance(block_id, str):
            out.append((block_id, block_text(block)))
        for child in block.get("children") or []:
            walk(child)

    for block in blocks:
        walk(block)
    return out


# ─── the executor ────────────────────────────────────────────────────────────


class PlanExecutor:
    def __init__(
        self,
        session: Session,
        ctx: ExecContext,
        *,
        check_cancelled: Callable[[], None] = lambda: None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> None:
        self.session = session
        self.ctx = ctx
        self.check_cancelled = check_cancelled
        self.on_progress = on_progress
        # Forward references: a `ref` on a create_* action, resolved once it exists.
        self.refs: Dict[str, str] = {}
        self.snapshotted: Set[str] = set()
        self.touched: Set[str] = set()

    # ─── plumbing ────────────────────────────────────────────────────────────

    def run(self, plan: Dict[str, Any]) -> List[ActionResult]:
        actions = plan.get("actions") or []
        results: List[ActionResult] = []
        for index, action in enumerate(actions):
            self.check_cancelled()
            if self.on_progress:
                self.on_progress(index, len(actions))
            try:
                results.append(self._run_action(action))
            except Cancelled:
                raise
            except Exception as exc:  # one bad action never abandons the rest
                logger.exception("Assistant action %s failed", action.get("type"))
                results.append(
                    ActionResult(
                        ok=False,
                        message=f'Action "{action.get("type")}" failed: {exc}'[:500],
                    )
                )
        return results

    def _note(self, note_id: str) -> Optional[Note]:
        note = self.session.get(Note, note_id)
        if not note or note.user_id != self.ctx.user_id:
            return None
        return note

    def _snapshot_once(self, note: Note) -> None:
        """One pre-run version per note. Snapshotting per step would leave an N-step
        plan with N versions — the original plus N-1 mid-plan intermediates."""
        if note.id in self.snapshotted:
            return
        self.snapshotted.add(note.id)
        try:
            from app.routers.notes import _snapshot_note

            _snapshot_note(self.session, note)
            self.session.commit()
        except Exception:
            logger.exception("Could not snapshot note %s before an assistant run", note.id)
            self.session.rollback()

    def _write_content(self, note: Note, blocks: Sequence[Any]) -> None:
        """Persist new block content, with the same side effects `PUT /notes/{id}` has.

        The cancellation check sits here rather than only between actions: this is the
        last moment before the write, and a run stopped while the worker was inside a
        slow call must not still land an edit.
        """
        self.check_cancelled()
        note.content = json.dumps(list(blocks))
        note.modified_at = datetime.now(timezone.utc)
        self.session.add(note)
        self.session.commit()
        self.touched.add(note.id)
        try:
            from app.asset_utils import sync_note_assets

            sync_note_assets(self.session, note)
        except Exception:
            # Asset bookkeeping must not turn a completed edit into a failure.
            logger.exception("Could not sync assets for note %s", note.id)

    def _resolve_note(self, id_or_ref: str) -> Tuple[Optional[str], Optional[str]]:
        """`(note_id, error)`. Refs first, then in-context ids, then the sentinels."""
        mapped = self.refs.get(id_or_ref)
        if mapped:
            return mapped, None
        if id_or_ref in self.ctx.valid_note_ids:
            return id_or_ref, None
        if re.fullmatch(r"(current|this|this_?note)", id_or_ref or "", re.IGNORECASE):
            if self.ctx.current_note_id:
                return self.ctx.current_note_id, None
        # When exactly one note is in context an unrecognised id can only sensibly
        # mean that note — models do copy stale ids out of earlier turns. Ambiguous
        # multi-note contexts still fail, so we never silently target the wrong note.
        if len(self.ctx.valid_note_ids) == 1:
            return next(iter(self.ctx.valid_note_ids)), None
        return None, f'Note "{id_or_ref}" is not in context — skipped.'

    def _resolve_folder(self, id_or_ref: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        if id_or_ref is None:
            return None, None
        mapped = self.refs.get(id_or_ref)
        if mapped:
            return mapped, None
        if id_or_ref in self.ctx.valid_folder_ids:
            return id_or_ref, None
        return None, f'Folder "{id_or_ref}" is not in context — skipped.'

    def _touches_current(self, note_id: str) -> bool:
        return note_id == self.ctx.current_note_id

    def _md(self, markdown: Optional[str]) -> List[Any]:
        return markdown_to_blocks(markdown or "")

    # ─── actions ─────────────────────────────────────────────────────────────

    def _run_action(self, action: Dict[str, Any]) -> ActionResult:
        handler = getattr(self, f"_do_{action.get('type')}", None)
        if handler is None:
            return ActionResult(ok=False, message=f'Unknown action "{action.get("type")}" — skipped.')
        return handler(action)

    # Conversational and retrieval steps. find_notes / web_search are resolved in the
    # browser before a run is ever created; handled here for completeness.

    def _do_respond(self, action: Dict[str, Any]) -> ActionResult:
        return ActionResult(ok=True, message=action.get("text") or "", kind="respond")

    def _do_find_notes(self, action: Dict[str, Any]) -> ActionResult:
        query = action.get("query")
        message = f"Searched notes for “{query}”." if query else "Searched notes."
        return ActionResult(ok=True, message=message, kind="respond")

    def _do_web_search(self, action: Dict[str, Any]) -> ActionResult:
        return ActionResult(ok=True, message=f'Searched the web for “{action.get("query")}”.', kind="respond")

    # ── notes ────────────────────────────────────────────────────────────────

    def _do_create_note(self, action: Dict[str, Any]) -> ActionResult:
        if not self.ctx.default_category_id:
            return ActionResult(ok=False, message="Cannot create note: no category available.")
        self.check_cancelled()
        now = datetime.now(timezone.utc)
        note = Note(
            id=str(uuid.uuid4()),
            title=action.get("title") or "Untitled",
            content=json.dumps(self._md(action.get("content"))),
            category_id=self.ctx.default_category_id,
            folder_id=self.ctx.current_folder_id,
            tags="[]",
            created_at=now,
            modified_at=now,
            user_id=self.ctx.user_id,
        )
        self.session.add(note)
        self.session.commit()
        self.session.refresh(note)
        self.touched.add(note.id)
        try:
            from app.asset_utils import sync_note_assets

            sync_note_assets(self.session, note)
        except Exception:
            logger.exception("Could not sync assets for new note %s", note.id)

        if action.get("ref"):
            self.refs[action["ref"]] = note.id
        return ActionResult(
            ok=True, message=f"Created note “{note.title}”.", notes_changed=True,
            note_id=note.id, note_title=note.title,
        )

    def _do_edit_note(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self._snapshot_once(note)
        new_blocks = self._md(action.get("content"))
        amend = action.get("mode") == "amend"
        blocks = [*parse_blocks(note.content), *new_blocks] if amend else new_blocks
        self._write_content(note, blocks)
        return ActionResult(
            ok=True,
            message=f'{"Amended" if amend else "Replaced"} note “{note.title}”.',
            notes_changed=True, touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    def _do_edit_section(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self._snapshot_once(note)
        blocks = parse_blocks(note.content)
        new_blocks = self._md(action.get("content"))
        section = action.get("section") or ""
        start = find_section_index(blocks, section)

        if start == -1:
            # Not found: append it as a new section rather than failing outright.
            self._write_content(note, [*blocks, *new_blocks])
            return ActionResult(
                ok=True,
                message=f'Section “{section}” not found in “{note.title}” — added as a new section.',
                notes_changed=True, touched_current_note=self._touches_current(note.id),
                note_id=note.id, note_title=note.title,
            )

        # The section runs until the next heading of the same or higher level.
        found = section_heading(blocks[start])
        level = found[0] if found else 1
        end = len(blocks)
        for index in range(start + 1, len(blocks)):
            info = section_heading(blocks[index])
            if info and info[0] <= level:
                end = index
                break

        preserved = collect_embeds(blocks[start:end])
        blocks[start:end] = [*new_blocks, *preserved]
        self._write_content(note, blocks)

        kept = ""
        if preserved:
            kept = f' Kept {len(preserved)} embedded reference{"" if len(preserved) == 1 else "s"}.'
        return ActionResult(
            ok=True, message=f'Updated section “{section}” in “{note.title}”.{kept}',
            notes_changed=True, touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    def _do_append_note(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self._snapshot_once(note)
        self._write_content(note, [*parse_blocks(note.content), *self._md(action.get("content"))])
        return ActionResult(
            ok=True, message=f"Appended to note “{note.title}”.", notes_changed=True,
            touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    def _do_rename_note(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self.check_cancelled()
        note.title = action.get("title") or note.title
        note.modified_at = datetime.now(timezone.utc)
        self.session.add(note)
        self.session.commit()
        return ActionResult(
            ok=True, message=f"Renamed note to “{note.title}”.", notes_changed=True,
            touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    def _do_create_child_note(self, action: Dict[str, Any]) -> ActionResult:
        parent_id, error = self._resolve_note(action.get("parentId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        parent = self._note(parent_id)
        if not parent:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self.check_cancelled()
        now = datetime.now(timezone.utc)
        child = Note(
            id=str(uuid.uuid4()),
            title=action.get("title") or "Untitled",
            content=json.dumps(self._md(action.get("content"))),
            category_id=parent.category_id,   # inherit, as POST /notes/{id}/children does
            folder_id=parent.folder_id,
            parent_note_id=parent.id,
            tags="[]",
            created_at=now,
            modified_at=now,
            user_id=self.ctx.user_id,
        )
        self.session.add(child)
        self.session.commit()
        self.session.refresh(child)
        if action.get("ref"):
            self.refs[action["ref"]] = child.id

        # The children endpoint only sets parent_note_id; the parent needs a childNote
        # block or the child is invisible in the UI (mirrors EditorView.insertEmptyChild).
        self._snapshot_once(parent)
        blocks = parse_blocks(parent.content)
        blocks.append({
            "id": str(uuid.uuid4()),
            "type": "childNote",
            "props": {"childNoteId": child.id, "title": child.title},
            "children": [],
        })
        self._write_content(parent, blocks)

        return ActionResult(
            ok=True,
            message=f"Created child note “{child.title}” under “{parent.title}”.",
            notes_changed=True, touched_current_note=self._touches_current(parent.id),
            note_id=child.id, note_title=child.title,
        )

    def _do_move_note(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        folder_id, folder_error = self._resolve_folder(action.get("folderId"))
        if folder_error:
            return ActionResult(ok=False, message=folder_error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self.check_cancelled()
        note.folder_id = folder_id
        note.modified_at = datetime.now(timezone.utc)
        self.session.add(note)
        self.session.commit()
        return ActionResult(
            ok=True, message=f'Moved note to {"folder" if folder_id else "the root"}.',
            notes_changed=True, touched_current_note=self._touches_current(note.id),
            note_id=note.id,
        )

    def _do_set_tags(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self.check_cancelled()
        tags = list(action.get("tags") or [])
        if action.get("mode") == "add":
            existing = parse_blocks(note.tags)  # same JSON-array-as-text convention
            merged = [*existing, *tags]
            seen: Set[str] = set()
            tags = [t for t in merged if not (t in seen or seen.add(t))]
        note.tags = json.dumps(tags)
        note.modified_at = datetime.now(timezone.utc)
        self.session.add(note)
        self.session.commit()
        return ActionResult(
            ok=True, message=f'Updated tags: {", ".join(tags) or "(none)"}.',
            notes_changed=True, touched_current_note=self._touches_current(note.id),
            note_id=note.id,
        )

    def _do_set_category(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        category_id = action.get("categoryId") or ""
        if category_id not in self.ctx.valid_category_ids:
            return ActionResult(ok=False, message=f'Category "{category_id}" is not available — skipped.')
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self.check_cancelled()
        note.category_id = category_id
        note.modified_at = datetime.now(timezone.utc)
        self.session.add(note)
        self.session.commit()
        return ActionResult(
            ok=True, message="Changed category.", notes_changed=True,
            touched_current_note=self._touches_current(note.id), note_id=note.id,
        )

    def _do_create_folder(self, action: Dict[str, Any]) -> ActionResult:
        parent_id, error = self._resolve_folder(action.get("parentFolderId"))
        if error:
            return ActionResult(ok=False, message=error)

        self.check_cancelled()
        now = datetime.now(timezone.utc)
        folder = Folder(
            id=str(uuid.uuid4()),
            name=action.get("name") or "New Folder",
            parent_folder_id=parent_id,
            user_id=self.ctx.user_id,
            created_at=now,
            modified_at=now,
        )
        self.session.add(folder)
        self.session.commit()
        self.session.refresh(folder)
        if action.get("ref"):
            self.refs[action["ref"]] = folder.id
        return ActionResult(ok=True, message=f"Created folder “{folder.name}”.", notes_changed=True)

    def _do_add_reference(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        reference_id = action.get("referenceNoteId") or ""
        reference_title = action.get("referenceTitle") or ""
        if reference_id not in self.ctx.valid_note_ids:
            return ActionResult(ok=False, message=f'Note reference “{reference_title}” is not in context — skipped.')
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        self._snapshot_once(note)
        blocks = parse_blocks(note.content)
        block = {
            "id": str(uuid.uuid4()),
            "type": "noteReference",
            "props": {"noteId": reference_id, "noteTitle": reference_title},
            "children": [],
        }
        section = action.get("insertAfterSection")
        after = find_section_index(blocks, section) if section else -1
        blocks.insert(len(blocks) if after == -1 else after + 1, block)
        self._write_content(note, blocks)

        where = f" under “{section}”" if section else ""
        return ActionResult(
            ok=True, message=f"Added reference to “{reference_title}”{where}.",
            notes_changed=True, touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    # ── annotations ──────────────────────────────────────────────────────────

    def _do_add_annotation(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        anchor = (action.get("anchorText") or "").strip().lower()
        candidates = block_texts_with_ids(parse_blocks(note.content))
        match = next((bid for bid, text in candidates if text.lower() == anchor), None)
        if match is None:
            match = next((bid for bid, text in candidates if anchor and anchor in text.lower()), None)
        if match is None:
            return ActionResult(
                ok=False,
                message=f'Could not find a block matching “{action.get("anchorText")}” in “{note.title}” — annotation skipped.',
            )

        self.check_cancelled()
        now = datetime.now(timezone.utc)
        self.session.add(Annotation(
            id=str(uuid.uuid4()), note_id=note.id, user_id=self.ctx.user_id,
            block_id=match, text=action.get("text") or "",
            created_at=now, modified_at=now,
        ))
        self.session.commit()
        return ActionResult(
            ok=True, message=f"Added annotation to “{note.title}”.",
            annotations_changed=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    def _annotation(self, note_id: str, annotation_id: str) -> Optional[Annotation]:
        row = self.session.get(Annotation, annotation_id)
        if not row or row.note_id != note_id:
            return None
        if row.user_id and row.user_id != self.ctx.user_id:
            return None
        return row

    def _do_edit_annotation(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        row = self._annotation(note_id, action.get("annotationId") or "")
        if not row:
            return ActionResult(ok=False, message="That annotation no longer exists — skipped.")

        self.check_cancelled()
        row.text = action.get("text") or ""
        row.modified_at = datetime.now(timezone.utc)
        self.session.add(row)
        self.session.commit()
        return ActionResult(
            ok=True, message="Edited annotation.",
            annotations_changed=self._touches_current(note_id), note_id=note_id,
        )

    def _do_delete_annotation(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        row = self._annotation(note_id, action.get("annotationId") or "")
        if not row:
            return ActionResult(ok=False, message="That annotation no longer exists — skipped.")

        self.check_cancelled()
        self.session.delete(row)
        self.session.commit()
        return ActionResult(
            ok=True, message="Deleted annotation.",
            annotations_changed=self._touches_current(note_id), note_id=note_id,
        )

    # ── diagrams ─────────────────────────────────────────────────────────────

    def _do_create_diagram(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")
        source = action.get("source") or ""
        if not source.strip():
            return ActionResult(ok=False, message="Diagram not created: the source is empty.")

        self._snapshot_once(note)
        blocks = parse_blocks(note.content)
        blocks.append({
            "id": str(uuid.uuid4()),
            "type": "diagram",
            # Mirrors newDiagramId() in utils/diagram.ts — a stable handle edit_diagram
            # can target later.
            "props": {"diagramId": f"dg-{uuid.uuid4().hex[:12]}", "source": source},
            "children": [],
        })
        self._write_content(note, blocks)
        return ActionResult(
            ok=True, message=f"Added diagram to “{note.title}”.", notes_changed=True,
            touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    def _do_edit_diagram(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")
        source = action.get("source") or ""
        diagram_id = action.get("diagramId") or ""

        blocks = parse_blocks(note.content)
        found = False

        def walk(items: List[Any]) -> List[Any]:
            nonlocal found
            out = []
            for block in items:
                if isinstance(block, dict):
                    props = block.get("props") or {}
                    if block.get("type") == "diagram" and props.get("diagramId") == diagram_id:
                        found = True
                        block = {**block, "props": {**props, "source": source}}
                    if isinstance(block.get("children"), list):
                        block = {**block, "children": walk(block["children"])}
                out.append(block)
            return out

        updated = walk(blocks)
        if not found:
            return ActionResult(ok=False, message=f'Diagram “{diagram_id}” not found in “{note.title}” — skipped.')

        self._snapshot_once(note)
        self._write_content(note, updated)
        return ActionResult(
            ok=True, message=f"Updated diagram in “{note.title}”.", notes_changed=True,
            touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    # ── images ───────────────────────────────────────────────────────────────

    def _do_generate_image(self, action: Dict[str, Any]) -> ActionResult:
        note_id, error = self._resolve_note(action.get("noteId") or "")
        if error:
            return ActionResult(ok=False, message=error)
        note = self._note(note_id)
        if not note:
            return ActionResult(ok=False, message="That note no longer exists — skipped.")

        # Generate first: it is a paid, fallible call, and a failure must leave the
        # note untouched rather than half-edited.
        self.check_cancelled()
        try:
            url = self._generate_image_url(action.get("prompt") or "")
        except Exception as exc:
            from app.jobs.runner import readable_error

            return ActionResult(ok=False, message=f"Image not generated: {readable_error(exc)}"[:500])

        self._snapshot_once(note)
        blocks = parse_blocks(note.content)
        block = {
            "id": str(uuid.uuid4()),
            "type": "image",
            "props": {"url": url, "name": action.get("alt") or "", "caption": "", "showPreview": True},
            "children": [],
        }
        section = action.get("section")
        index = find_section_index(blocks, section) if section else -1
        placed = index != -1
        blocks.insert(len(blocks) if not placed else index + 1, block)
        self._write_content(note, blocks)

        if section:
            where = f" under “{section}”" if placed else f" (section “{section}” not found — added at the end)"
        else:
            where = ""
        return ActionResult(
            ok=True, message=f"Generated image{where} in “{note.title}”.", notes_changed=True,
            touched_current_note=self._touches_current(note.id),
            note_id=note.id, note_title=note.title,
        )

    def _generate_image_url(self, prompt: str) -> str:
        """Call the image generator in-process rather than spawning a nested job.

        Thumbnailing runs inline: this is already a worker thread, so there is no
        request to defer it off.
        """
        import asyncio

        from app.routers.images import generate_image_for_user
        from app.thumbnails import generate_thumbnail

        result = asyncio.run(
            generate_image_for_user(
                self.session, self.ctx.user_id, prompt, on_file=generate_thumbnail
            )
        )
        return result.url

    # ── recipes ──────────────────────────────────────────────────────────────

    def _recipe(self, recipe_id: str) -> Optional[Recipe]:
        if recipe_id not in self.ctx.valid_recipe_ids:
            return None
        row = self.session.get(Recipe, recipe_id)
        if not row or row.user_id != self.ctx.user_id:
            return None
        return row

    def _do_create_recipe(self, action: Dict[str, Any]) -> ActionResult:
        self.check_cancelled()
        now = datetime.now(timezone.utc)
        recipe = Recipe(
            id=str(uuid.uuid4()),
            user_id=self.ctx.user_id,
            name=action.get("name") or "Untitled recipe",
            prompt=action.get("prompt") or "",
            tags=json.dumps(action.get("tags") or []),
            created_at=now,
            updated_at=now,   # Recipe tracks updated_at, unlike Note/Folder
        )
        self.session.add(recipe)
        self.session.commit()
        return ActionResult(ok=True, message=f"Created recipe “{recipe.name}”.", recipes_changed=True)

    def _do_update_recipe(self, action: Dict[str, Any]) -> ActionResult:
        recipe = self._recipe(action.get("recipeId") or "")
        if not recipe:
            return ActionResult(ok=False, message=f'Recipe "{action.get("recipeId")}" is not in context — skipped.')

        self.check_cancelled()
        if action.get("name") is not None:
            recipe.name = action["name"]
        if action.get("prompt") is not None:
            recipe.prompt = action["prompt"]
        if action.get("tags") is not None:
            recipe.tags = json.dumps(action["tags"])
        recipe.updated_at = datetime.now(timezone.utc)
        self.session.add(recipe)
        self.session.commit()
        return ActionResult(ok=True, message=f"Updated recipe “{recipe.name}”.", recipes_changed=True)

    def _do_delete_recipe(self, action: Dict[str, Any]) -> ActionResult:
        recipe = self._recipe(action.get("recipeId") or "")
        if not recipe:
            return ActionResult(ok=False, message=f'Recipe "{action.get("recipeId")}" is not in context — skipped.')

        self.check_cancelled()
        self.session.delete(recipe)
        self.session.commit()
        return ActionResult(ok=True, message="Deleted recipe.", recipes_changed=True)


# ─── the summary written back into the chat ──────────────────────────────────


def build_result_summary(results: Sequence[ActionResult]) -> str:
    """The Markdown the chat shows when a run finishes.

    Deliberately *not* including the plan's `respond` prose, even though it is in
    `results`. The browser puts that answer in the chat the moment the run starts
    rather than making the user wait minutes for it, so repeating it here would show
    it twice. The rows below are what only the finished run can report.
    """
    rows = []
    for result in results:
        if result.kind == "respond":
            continue
        icon = "✅" if result.ok else "❌"
        pill = f" [{result.note_title}](/notes/{result.note_id})" if result.ok and result.note_id and result.note_title else ""
        rows.append(f"| {icon} | {result.message}{pill} |")

    text = "\n".join(["| | |", "|:---:|:---|", *rows]) if rows else ""
    failures = sum(1 for r in results if r.kind != "respond" and not r.ok)
    if failures:
        text += f'\n\n_({failures} action{"" if failures == 1 else "s"} could not be completed.)_'
    return text
