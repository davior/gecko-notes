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

# Offered only when Notes is connected to GAM (`gam_client.enabled()`), like web_search:
# a model is never told about a library it cannot reach.
GAM_WRITE_TOOLS: Dict[str, tuple] = {
    "insert_gam_asset": ("Insert one of the person's GAM assets (an image, video, recording or document found with "
                         "search_gam) into a note as a live block.",
                         {"noteId": _ID, "assetId": {"type": "string", "description": "An asset id from search_gam"},
                          **_PLACEMENT}, ["noteId", "assetId"]),
    "add_to_gam": ("Copy files embedded in a note (videos, images, recordings, documents) into the person's GAM "
                   "library, where they are catalogued and transcribed like any upload. Each copied file's block in "
                   "the note is replaced by a live GAM block. Use addresses from list_note_media, only for the files asked for, and each file once.",
                   {"noteId": _ID,
                    "urls": {"type": "array", "items": _S,
                             "description": "The /media/... addresses from list_note_media, e.g. just the first video's"}},
                   ["noteId", "urls"]),
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

GAM_READ_TOOLS: Dict[str, tuple] = {
    "search_gam": ("Search the person's asset library (GAM: their images, videos, recordings and documents) by "
                   "meaning and keywords. Returns asset ids, names and types.",
                   {"query": _S, "type": {"type": "string", "enum": ["image", "video", "audio", "document"]}},
                   ["query"]),
    "read_gam_asset": ("Read one GAM asset by id: its details, and the text of a document or what is said in a "
                       "video or recording.", {"assetId": _S}, ["assetId"]),
    "list_note_media": ("List the files embedded in a note (videos, images, recordings, documents) in the order "
                        "they appear, with the addresses add_to_gam needs. Files already from GAM are not listed.",
                        {"noteId": {"type": "string", "description": "A note id from context, or \"current\""}},
                        ["noteId"]),
}

# How much of a document or transcript one read_gam_asset hands the model. A long PDF
# would otherwise crowd the notes themselves out of the context.
GAM_TEXT_LIMIT = 12_000


def _schema(properties: Dict[str, Any], required: List[str], *, write: bool) -> Dict[str, Any]:
    props = dict(properties)
    if write:
        props["description"] = _DESC
    return {"type": "object", "properties": props, "required": required}


def tool_specs(*, web_search: bool, gam: bool = False) -> List[Dict[str, Any]]:
    """Every tool as {name, description, parameters}. `web_search` and the GAM tools only
    when they can run: a model is never told about a tool it cannot use."""
    writes = {**WRITE_TOOLS, **(GAM_WRITE_TOOLS if gam else {})}
    reads = {**READ_TOOLS, **(GAM_READ_TOOLS if gam else {})}
    specs = [{"name": n, "description": d, "parameters": _schema(p, r, write=True)} for n, (d, p, r) in writes.items()]
    for name, (description, props, required) in reads.items():
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


Step = Callable[[str, str], None]


def _quoted(value: Any, limit: int = 80) -> str:
    text = " ".join(str(value or "").split())
    return f"“{text[:limit]}{'…' if len(text) > limit else ''}”"


def describe_action(action: Dict[str, Any], label_map: Dict[str, str]) -> str:
    """One line for a recorded change, as the steps list shows it."""
    kind = str(action.get("type") or "")

    def note(key: str = "noteId") -> str:
        ref = str(action.get(key) or "")
        return _quoted(label_map.get(ref) or ref or "a note")

    if kind == "create_note":
        return f"Create note {_quoted(action.get('title'))}"
    if kind == "create_child_note":
        return f"Create note {_quoted(action.get('title'))} inside {note('parentId')}"
    if kind == "edit_section":
        return f"Rewrite section {_quoted(action.get('section'))} of {note()}"
    if kind == "edit_note":
        return f"{'Rewrite' if action.get('mode') == 'replace' else 'Amend'} {note()}"
    if kind == "append_note":
        return f"Add to the end of {note()}"
    if kind == "rename_note":
        return f"Rename {note()} to {_quoted(action.get('title'))}"
    if kind == "create_folder":
        return f"Create folder {_quoted(action.get('name'))}"
    if kind == "generate_image":
        return f"Generate image {_quoted(action.get('alt'))} in {note()}"
    if kind == "insert_gam_asset":
        asset = str(action.get("assetId") or "")
        return f"Insert {_quoted(label_map.get(asset) or 'a GAM asset')} from GAM into {note()}"
    if kind == "add_to_gam":
        count = len(action.get("urls") or [])
        return f"Copy {count} file{'' if count == 1 else 's'} from {note()} to GAM"
    if kind in ("create_recipe", "update_recipe", "delete_recipe"):
        name = action.get("name")
        return f"{kind.split('_')[0].capitalize()} recipe" + (f" {_quoted(name)}" if name else "")
    target = note() if action.get("noteId") else ""
    return " ".join(p for p in (kind.replace("_", " ").capitalize(), "in" if target else "", target) if p)


def handlers(session: Session, user_id: str, proposal: Proposal, retrieval: RetrievalContext,
             *, web_search: bool, gam: bool = False,
             on_step: Step = lambda kind, text: None) -> Dict[str, Callable[[dict], Any]]:
    """The handler for every tool this turn offers. `on_step(kind, text)` is told what
    each one does as it does it: kind is search, read, edit or issue."""
    table: Dict[str, Callable[[dict], Any]] = {name: _recorder(name, proposal, on_step) for name in WRITE_TOOLS}
    if gam:
        table.update(_gam_handlers(session, user_id, proposal, on_step))

    def find_notes(args: dict):
        action = validate_action({"type": "find_notes", **args})
        if action is None:
            return "find_notes needs a query, a folderId, or both.", True
        if action.get("query"):
            on_step("search", f"Searching your notes for {_quoted(action.get('query'))}")
        else:
            where = retrieval.current_folder_id if action.get("folderId") == "current" else action.get("folderId")
            name = "the root" if where is None else retrieval.folder_names.get(where) or "a folder"
            on_step("search", f"Looking through {_quoted(name)}")
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
            on_step("issue", f"Could not read note {_quoted(args.get('noteId'))}")
            return f"There is no note {note_id!r} you can read.", True
        proposal.note_found(notes[0].id, notes[0].title or "Untitled")
        on_step("read", f"Reading {_quoted(notes[0].title or 'Untitled')}")
        return _render_note(notes[0], retrieval)

    table["find_notes"] = find_notes
    table["read_note"] = read_note
    if web_search:
        def search_web(args: dict):
            # The same words as a search the model runs itself (reported by the suite's
            # client), so the steps read alike whichever ran it.
            on_step("search", f"Searching the web: {str(args.get('query') or '').strip()}")
            return _web_search(session, user_id, args)

        table["web_search"] = search_web
    return table


def _recorder(name: str, proposal: Proposal, on_step: Step = lambda kind, text: None) -> Callable[[dict], Any]:
    required = {**WRITE_TOOLS, **GAM_WRITE_TOOLS}[name][2]

    def record(args: dict):
        if len(proposal.actions) >= MAX_PLAN_ACTIONS:
            on_step("issue", f"Too many changes for one turn; {name.replace('_', ' ')} was left out")
            return f"This turn already has {MAX_PLAN_ACTIONS} changes, the most one turn can hold.", True
        action = validate_action({"type": name, **args})
        if action is None:
            on_step("issue", f"A {name.replace('_', ' ')} was missing {', '.join(required) or 'its fields'}; retrying")
            return (f"That {name} could not be used. It needs {', '.join(required) or 'its fields'}; "
                    "call it again with them."), True
        if action.get("content") and action.get("spec"):
            # The text plan's rule: never both. Inline content wins, as the writer would.
            action.pop("spec")
        proposal.actions.append(action)
        on_step("edit", f"Proposed: {describe_action(action, proposal.label_map)}")
        return (f"Recorded as change {len(proposal.actions)}. Nothing is applied until the person "
                "approves; carry on, then finish with a short reply saying what you propose.")

    return record


def _gam_handlers(session: Session, user_id: str, proposal: Proposal, on_step: Step) -> Dict[str, Callable[[dict], Any]]:
    """GAM's looking tools, and the recorders for inserting what they found or filing a
    note's own files into the library.

    They run on the worker, which has no request token, so each call mints a
    five-minute one for this turn's owner (`gam_client.token_for`); GAM then applies its
    own ownership checks exactly as for the person's browser. A failure is a tool result
    the model can read and work around, never a failed turn: GAM being down must not
    stop the assistant answering about the notes.
    """
    from app import gam_client
    from app.gam_client import GamClient, GamError

    def client() -> GamClient:
        return GamClient(gam_client.token_for(user_id))

    def search_gam(args: dict):
        query = str(args.get("query") or "").strip()
        if not query:
            return "search_gam needs a query.", True
        kind = args.get("type") if args.get("type") in gam_client.ASSET_TYPES else None
        on_step("search", f"Searching your asset library for {_quoted(query)}")
        try:
            with client() as gam:
                result = gam.search(query, asset_type=kind, limit=12)
        except GamError as exc:
            on_step("issue", f"The asset library did not answer: {exc.message}")
            return f"The asset library could not be searched: {exc.message}", True
        if not result["data"]:
            return f"No assets in the library match {query!r}."
        lines = []
        for i, hit in enumerate(result["data"], 1):
            asset = hit["asset"]
            proposal.label_map[asset["id"]] = asset["name"]
            extra = []
            if asset.get("duration_seconds"):
                extra.append(f"{round(asset['duration_seconds'])} s")
            if hit.get("page_label"):
                extra.append(f"match on {hit['page_label']}")
            line = f"{i}. {asset['name']} — {asset['asset_type']}{' (' + ', '.join(extra) + ')' if extra else ''} — id {asset['id']}"
            if hit.get("snippet"):
                line += f"\n   “{' '.join(hit['snippet'].split())[:200]}”"
            lines.append(line)
        return "\n".join(lines)

    def read_gam_asset(args: dict):
        asset_id = str(args.get("assetId") or "").strip()
        try:
            with client() as gam:
                asset = gam.get_asset(asset_id) if asset_id else None
                if asset is None:
                    on_step("issue", f"Could not read asset {_quoted(asset_id)}")
                    return f"There is no asset {asset_id!r} in the person's library.", True
                proposal.label_map[asset["id"]] = asset["name"]
                on_step("read", f"Reading {_quoted(asset['name'])} from your asset library")
                if asset["asset_type"] == "document":
                    parts = [f"[{p.get('label') or 'Part ' + str(p.get('idx', 0) + 1)}]\n{p.get('text') or ''}"
                             for p in gam.document_text(asset["id"])]
                elif asset["asset_type"] in ("video", "audio"):
                    parts = [f"[{round(seg.get('start_time') or 0)} s] {seg.get('text') or ''}"
                             for seg in gam.transcript(asset["id"])]
                else:
                    parts = []
        except GamError as exc:
            on_step("issue", f"The asset library did not answer: {exc.message}")
            return f"The asset library could not be read: {exc.message}", True
        head = [f"{asset['name']} ({asset['asset_type']}), id {asset['id']}"]
        for key, label in (("description", "Description"), ("credit", "Credit")):
            if asset.get(key):
                head.append(f"{label}: {asset[key]}")
        text = "\n".join(parts)
        if len(text) > GAM_TEXT_LIMIT:
            text = text[:GAM_TEXT_LIMIT] + "\n[… the rest is cut off]"
        if not text and asset["asset_type"] != "image":
            text = "(GAM has no text for this asset.)"
        return "\n".join(head) + ("\n\n" + text if text else "")

    def list_note_media(args: dict):
        from app.asset_utils import note_media_files

        note_id = str(args.get("noteId") or "")
        if note_id == "current":
            note_id = proposal.exec_ctx.get("current_note_id") or ""
        notes = _load_notes(session, user_id, [note_id]) if note_id else []
        if not notes:
            on_step("issue", f"Could not read note {_quoted(args.get('noteId'))}")
            return f"There is no note {note_id!r} you can read.", True
        note = notes[0]
        proposal.note_found(note.id, note.title or "Untitled")
        on_step("read", f"Listing the files in {_quoted(note.title or 'Untitled')}")
        files = note_media_files(note.content, user_id)
        if not files:
            return "This note has no embedded files of its own to copy (files already from GAM are not listed)."
        lines = []
        for f in files:
            size = f["size_bytes"]
            size_text = f"{size / (1024 * 1024):.1f} MB" if size else "file missing on disk"
            lines.append(f"{f['index']}. {f['kind']} “{f['name']}” — {size_text} — {f['url']}")
        return "\n".join(lines)

    return {
        "search_gam": search_gam,
        "read_gam_asset": read_gam_asset,
        "list_note_media": list_note_media,
        "insert_gam_asset": _recorder("insert_gam_asset", proposal, on_step),
        "add_to_gam": _recorder("add_to_gam", proposal, on_step),
    }


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
- When offered, search_gam and read_gam_asset look in the person's asset library (their images, videos, recordings and documents); insert_gam_asset puts one into a note, as a change to approve. Use ids search_gam returned, never invented ones.
- When offered, list_note_media lists the files embedded in a note in order, and add_to_gam copies chosen ones into the person's asset library and swaps their blocks in the note for live GAM ones. Call list_note_media first, then add_to_gam with only the addresses it returned for the files asked for ("the first video" is the first video in that list). Do not propose a file twice.

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
