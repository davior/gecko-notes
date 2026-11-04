"""The assistant's tools, for a turn planned by tool calls instead of a JSON plan in text.

Phase one of a turn used to ask the model for `{"actions": [...]}` as text and then dig
it out of whatever came back (`plan_parse.py`, `continuation.py`). With tool calls the
model hands each action over as structured arguments, so none of that rescue is needed.
Everything *after* planning is unchanged, and that is the point of how these are built:

* **Write tools only record.** Each one is an action type the executor already knows.
  Its arguments go through the same `validate_action` the text plan used, and the result
  is appended to a proposal. Nothing touches a note until the turn ends and the person
  approves (or, with plan mode off, the existing run phase applies it). The approval
  panel, the deferred-body writer and the executor see exactly the plan shape they
  always did.
* **Read tools run now**, through the functions the text plan's retrieval rounds used,
  so which notes a search can see stays one rule. A note they surface is added to
  `valid_note_ids`, or the executor would refuse the very note the model looked up.

`respond` is not a tool: the model's own final text is the answer.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional, Sequence

from sqlmodel import Session

from app.assistant.plan_parse import MAX_PLAN_ACTIONS, validate_action
from app.assistant.retrieve import (
    RetrievalContext,
    _load_notes,
    _render_note,
    _run_find_notes,
    format_web_search_results,
)

logger = logging.getLogger(__name__)

# ─── the schemas ─────────────────────────────────────────────────────────────

_S = {"type": "string"}
_ID = {"type": "string", "description": "An id from the lists in context, or a ref assigned earlier in this turn"}
_NULLABLE_ID = {"type": ["string", "null"], "description": "An id from the lists in context, or null for the root"}
_MARKDOWN = {"type": "string", "description": "Markdown. Leave empty and use spec for a long body"}
_SPEC = {"type": "string", "description": "Instead of content: a precise description of what the body must contain, written in a later step"}
_REF = {"type": "string", "description": "Optional short label (e.g. f1) a later call in this turn can use as an id"}
_DESC = {"type": "string", "description": "Optional one short sentence for the approval preview"}
_PLACEMENT = {
    "section": {"type": "string", "description": "A heading's text: where in the note"},
    "anchorText": {"type": "string", "description": "The opening words (6-12, verbatim) of the block to put it next to"},
    "position": {"type": "string", "enum": ["before", "after", "end"]},
}
_TAGS = {"type": "array", "items": {"type": "string"}}

# name: (what it does, properties, required). Field names are the plan's, so a recorded
# call is a plan action as it stands.
WRITE_TOOLS: Dict[str, tuple] = {
    "create_note": ("Create a new note in the current folder.",
                    {"title": _S, "content": _MARKDOWN, "spec": _SPEC, "ref": _REF}, ["title"]),
    "edit_note": ("Rewrite a note (replace) or add to it in place (amend). Prefer edit_section or append_note.",
                  {"noteId": _ID, "mode": {"type": "string", "enum": ["replace", "amend"]},
                   "content": _MARKDOWN, "spec": _SPEC}, ["noteId", "mode"]),
    "edit_section": ("Rewrite one section of a note; every other section is kept.",
                     {"noteId": _ID, "section": {"type": "string", "description": "The section's heading text"},
                      "content": {"type": "string", "description": "Markdown for the whole section, heading included"},
                      "spec": _SPEC}, ["noteId", "section"]),
    "append_note": ("Add content to the end of a note.", {"noteId": _ID, "content": _MARKDOWN, "spec": _SPEC}, ["noteId"]),
    "rename_note": ("Rename a note.", {"noteId": _ID, "title": _S}, ["noteId", "title"]),
    "create_child_note": ("Create a note embedded inside another note.",
                          {"parentId": _ID, "title": _S, "content": _MARKDOWN, "spec": _SPEC, "ref": _REF, **_PLACEMENT},
                          ["parentId", "title"]),
    "move_note": ("Move a note into a folder.", {"noteId": _ID, "folderId": _NULLABLE_ID}, ["noteId", "folderId"]),
    "set_tags": ("Set or add a note's tags.",
                 {"noteId": _ID, "tags": _TAGS, "mode": {"type": "string", "enum": ["replace", "add"]}}, ["noteId", "tags"]),
    "set_category": ("Set a note's category.", {"noteId": _ID, "categoryId": _ID}, ["noteId", "categoryId"]),
    "create_folder": ("Create a folder.", {"name": _S, "parentFolderId": _NULLABLE_ID, "ref": _REF}, ["name"]),
    "add_reference": ("Insert a link to another note into a note.",
                      {"noteId": _ID, "referenceNoteId": _ID, "referenceTitle": _S, **_PLACEMENT},
                      ["noteId", "referenceNoteId", "referenceTitle"]),
    "add_annotation": ("Attach an annotation to a block of a note.",
                       {"noteId": _ID, "anchorText": {"type": "string", "description": "A short verbatim snippet of the block"},
                        "text": _S}, ["noteId", "anchorText", "text"]),
    "edit_annotation": ("Change an annotation's text.", {"noteId": _ID, "annotationId": _ID, "text": _S},
                        ["noteId", "annotationId", "text"]),
    "delete_annotation": ("Delete an annotation.", {"noteId": _ID, "annotationId": _ID}, ["noteId", "annotationId"]),
    "create_diagram": ("Add a Mermaid diagram to a note.",
                       {"noteId": _ID, "source": {"type": "string", "description": "Complete, valid Mermaid source"}, **_PLACEMENT},
                       ["noteId", "source"]),
    "edit_diagram": ("Replace an existing diagram's whole Mermaid source.",
                     {"noteId": _ID, "diagramId": _ID, "source": _S}, ["noteId", "diagramId", "source"]),
    "generate_image": ("Generate an image into a note. Costs money: only the images asked for.",
                       {"noteId": _ID, "prompt": {"type": "string", "description": "A vivid, self-contained text-to-image prompt"},
                        "alt": {"type": "string", "description": "A short title naming the image (3-8 words)"}, **_PLACEMENT},
                       ["noteId", "prompt", "alt"]),
    "create_recipe": ("Save a reusable prompt (a recipe).", {"name": _S, "prompt": _S, "tags": _TAGS}, ["name", "prompt"]),
    "update_recipe": ("Change a recipe; omit what is not changing.",
                      {"recipeId": _ID, "name": _S, "prompt": _S, "tags": _TAGS}, ["recipeId"]),
    "delete_recipe": ("Delete a recipe.", {"recipeId": _ID}, ["recipeId"]),
}

READ_TOOLS: Dict[str, tuple] = {
    "find_notes": ("Search the person's notes by text and/or folder. Use only when the notes you need are not "
                   "already in context. Returns their ids and full text.",
                   {"query": {"type": "string", "description": "Matched as a substring over titles and bodies"},
                    "folderId": {"type": ["string", "null"],
                                 "description": "A folder id, \"current\" for the folder being viewed, or null for the root"},
                    "recursive": {"type": "boolean", "description": "Include every folder nested beneath it"}}, []),
    "read_note": ("Read the full text of one note in context by id.", {"noteId": _S}, ["noteId"]),
    "web_search": ("Search the web. Cite what you use.",
                   {"query": _S, "maxResults": {"type": "integer", "minimum": 1, "maximum": 10}}, ["query"]),
}


def _schema(properties: Dict[str, Any], required: List[str], *, write: bool) -> Dict[str, Any]:
    props = dict(properties)
    if write:
        props["description"] = _DESC
    return {"type": "object", "properties": props, "required": required}


def tool_specs(*, web_search: bool) -> List[Dict[str, Any]]:
    """Every tool as {name, description, parameters}. `web_search` only when it can run:
    a model is never told about a tool it cannot use."""
    specs = [{"name": n, "description": d, "parameters": _schema(p, r, write=True)} for n, (d, p, r) in WRITE_TOOLS.items()]
    for name, (description, props, required) in READ_TOOLS.items():
        if name == "web_search" and not web_search:
            continue
        specs.append({"name": name, "description": description, "parameters": _schema(props, required, write=False)})
    return specs


# ─── what each call does ─────────────────────────────────────────────────────


class Proposal:
    """What one turn's tool calls have gathered: the actions to approve, and what the
    read tools brought into context."""

    def __init__(self, exec_ctx: Dict[str, Any], label_map: Dict[str, str]) -> None:
        self.actions: List[Dict[str, Any]] = []
        self.exec_ctx = exec_ctx
        self.label_map = label_map
        self.found_note_ids: List[str] = []
        self.search_label = ""

    def note_found(self, note_id: str, title: str) -> None:
        if note_id not in self.found_note_ids:
            self.found_note_ids.append(note_id)
        valid = self.exec_ctx.setdefault("valid_note_ids", [])
        if note_id not in valid:
            valid.append(note_id)
        self.label_map[note_id] = title


def handlers(session: Session, user_id: str, proposal: Proposal, retrieval: RetrievalContext,
             *, web_search: bool) -> Dict[str, Callable[[dict], Any]]:
    """The handler for every tool this turn offers."""
    table: Dict[str, Callable[[dict], Any]] = {name: _recorder(name, proposal) for name in WRITE_TOOLS}

    def find_notes(args: dict):
        action = validate_action({"type": "find_notes", **args})
        if action is None:
            return "find_notes needs a query, a folderId, or both.", True
        summary, ids, labels = _run_find_notes(session, user_id, [action], retrieval)
        for note_id in ids:
            proposal.note_found(note_id, labels.get(note_id, "Untitled"))
        proposal.search_label = proposal.search_label or (action.get("query") or "")
        return summary

    def read_note(args: dict):
        note_id = str(args.get("noteId") or "")
        if note_id == "current":
            note_id = proposal.exec_ctx.get("current_note_id") or ""
        notes = _load_notes(session, user_id, [note_id]) if note_id else []
        if not notes:
            return f"There is no note {note_id!r} you can read.", True
        proposal.note_found(notes[0].id, notes[0].title or "Untitled")
        return _render_note(notes[0], retrieval)

    table["find_notes"] = find_notes
    table["read_note"] = read_note
    if web_search:
        table["web_search"] = lambda args: _web_search(session, user_id, args)
    return table


def _recorder(name: str, proposal: Proposal) -> Callable[[dict], Any]:
    required = WRITE_TOOLS[name][2]

    def record(args: dict):
        if len(proposal.actions) >= MAX_PLAN_ACTIONS:
            return f"This turn already has {MAX_PLAN_ACTIONS} changes, the most one turn can hold.", True
        action = validate_action({"type": name, **args})
        if action is None:
            return (f"That {name} could not be used. It needs {', '.join(required) or 'its fields'}; "
                    "call it again with them."), True
        if action.get("content") and action.get("spec"):
            # The text plan's rule: never both. Inline content wins, as the writer would.
            action.pop("spec")
        proposal.actions.append(action)
        return (f"Recorded as change {len(proposal.actions)}. Nothing is applied until the person "
                "approves; carry on, then finish with a short reply saying what you propose.")

    return record


def _web_search(session: Session, user_id: str, args: dict):
    from app.routers.search import search_web_for_user

    query = str(args.get("query") or "").strip()
    if not query:
        return "web_search needs a query.", True
    response = asyncio.run(search_web_for_user(session, user_id, query, args.get("maxResults")))
    return format_web_search_results(response)


# ─── the instructions ────────────────────────────────────────────────────────

# The text plan's rules (PLAN_INSTRUCTIONS in the frontend's aiPlan.ts) without the half
# that existed only because the plan was JSON in text: output format, escaping, fences.
TOOL_INSTRUCTIONS = """You are an AI assistant and research helper for a note-taking app. You help the person in two ways: by ANSWERING questions and discussing their notes, and, ONLY when they explicitly ask, by changing their notes through your tools.

How a turn works:
- Answer by default. A question, an explanation, research or a summary in the chat is answered in your reply, with no tools. Never create, edit, rename, move, tag, annotate or otherwise change a note unless the person explicitly asks you to change their notes. When a request is ambiguous, answer instead.
- Changes are proposals. Each change tool records one change; nothing is applied until the person approves. Make every change the request needs, then finish with a short reply saying what you propose. Do not describe changes you did not record.
- Look things up with find_notes, read_note and (when offered) web_search, but only when the notes you need are not already in context.

Rules for changes:
- Note bodies are Markdown, and so are the notes given to you. Preserve existing formatting when editing.
- Long bodies: for create_note, create_child_note, edit_note, edit_section and append_note, either write the body in "content" or, for a long body or several notes, describe it precisely in "spec" and leave "content" empty. A spec'd body is written in a later step. Never set both.
- Ids: noteId, parentId, folderId and categoryId must be ids from the lists in context, a note found with find_notes, or a "ref" you assigned earlier in this turn. Never invent one. "current" means the note the person has open; its live text is in their latest message.
- A text selection, when present, is what "this" refers to. Answer questions about it; change only that part when asked.
- Dates: notes carry ISO-8601 UTC created/modified times and the reference block states today's date and the current folder; "here" means the current folder.
- Choosing how to edit: to add, use append_note or edit_note "amend"; to change a section, use edit_section with the whole new section; use edit_note "replace" only when asked to rewrite the entire note.
- Placing blocks (generate_image, create_diagram, add_reference, create_child_note): "anchorText" is the opening words of an existing block, copied verbatim, with "position" before or after; "section" alone places it relative to that heading; neither appends at the end. For one per paragraph, make one call per paragraph, each anchored to it.
- Annotations, diagrams and recipes: use the ids listed in context. A diagram's source is complete Mermaid; node links ("click <id> href ...") only in flowchart, classDiagram and stateDiagram-v2. A recipe's prompt must stand alone, using {{title}}, {{selected text}} and {{date}}.
- Images cost money: generate only the images asked for, each with a vivid prompt of your own and a short "alt" title.
- If you lack the context to do what is asked, say what the person needs to add instead of guessing."""

VOICE_INSTRUCTIONS = """VOICE MODE: the person is talking to you out loud and will hear your reply read aloud. Make it sound like natural speech: short sentences, no Markdown, no lists, no links or ids read out. Every rule above still applies."""


def system_blocks(*, reference_block: str, voice: bool) -> List[str]:
    """Most stable first, so the cached prefix survives from turn to turn."""
    blocks = [TOOL_INSTRUCTIONS + (f"\n\n{VOICE_INSTRUCTIONS}" if voice else "")]
    if reference_block:
        blocks.append(reference_block)
    return blocks


def prompt_text(*, current_note_text: Optional[str], user_request: str) -> str:
    """The live note last, after the cached prefix, as the text plan sends it."""
    if current_note_text:
        return f"Current note — live:\n\n{current_note_text}\n\n---\n\n{user_request}"
    return user_request


def history_pairs(history: Sequence[Dict[str, Any]]) -> List[tuple]:
    pairs = []
    for turn in history:
        role = "user" if turn.get("role") == "user" else "assistant"
        content = str(turn.get("content") or "").strip()
        if content:
            pairs.append((role, content))
    return pairs
