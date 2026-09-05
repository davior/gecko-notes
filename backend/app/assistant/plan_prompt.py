"""The prompts a run builds for itself once it knows the plan.

The browser used to assemble these and ship them with the approved run, because the
plan only existed in React state. Now the plan is produced server-side, so the two
turns that ask for one deferred body — the compact plan summary and the per-step
instruction — are built here instead.

Only the *messages* moved. The request body they are appended to is still assembled in
`services/ai.ts` and shipped with the turn, cache breakpoints and all, for the reasons
`provider.py` sets out: the layout rules for three protocols have nothing to check a
second copy against. Everything here is plain text, which is why it could come across
at all.

Ported from `aiPlan.ts`; `default_action_label` also carries `detectMermaidKind` over
from `utils/diagram.ts` so it is a complete twin rather than one that quietly falls
back on the action types nothing here happens to defer.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Mapping, Optional

# Content-bearing action types: the only ones that can defer a body.
GENERATED_TYPES = frozenset({
    "create_note", "edit_note", "edit_section", "append_note", "create_child_note",
})

_WHITESPACE_RUN = re.compile(r"\s+")
_ATX_PREFIX = re.compile(r"^#{1,6}\s*")


def truncate(text: str, max_len: int = 80) -> str:
    """One line, capped, with an ellipsis when it had to be cut."""
    one_line = _WHITESPACE_RUN.sub(" ", text).strip()
    return f"{one_line[:max_len - 1]}…" if len(one_line) > max_len else one_line


# ─── diagram kinds ───────────────────────────────────────────────────────────

DIAGRAM_KIND_LABELS: Dict[str, str] = {
    "flowchart": "Flow chart",
    "sequence": "Sequence diagram",
    "class": "Class diagram",
    "state": "State diagram",
    "er": "ER diagram",
    "gantt": "Gantt chart",
    "pie": "Pie chart",
    "timeline": "Timeline",
    "mindmap": "Mind map",
    "other": "Diagram",
}


def detect_mermaid_kind(source: str) -> str:
    """The diagram's type, from its first non-comment line.

    Kind is never stored — always derived — so an edit that changes the real type can't
    leave a stale label behind. Ported from `utils/diagram.ts`.
    """
    line = ""
    for candidate in (source or "").split("\n"):
        stripped = candidate.strip()
        if stripped and not stripped.startswith("%%"):
            line = stripped
            break
    head = (line.split()[0].lower() if line.split() else "")
    if head in ("flowchart", "graph"):
        return "flowchart"
    if head == "sequencediagram":
        return "sequence"
    if head.startswith("classdiagram"):
        return "class"
    if head.startswith("statediagram"):
        return "state"
    if head == "erdiagram":
        return "er"
    if head in ("gantt", "pie", "timeline", "mindmap"):
        return head
    return "other"


# ─── labels ──────────────────────────────────────────────────────────────────


def default_action_label(action: Mapping[str, Any], label_map: Mapping[str, str]) -> str:
    """Human-readable label for one action.

    `label_map` resolves note/folder/category ids — and forward-ref labels — to names.
    An explicit `description` from the model always wins.
    """
    described = action.get("description")
    if described:
        return str(described)

    def name(value: Optional[str]) -> str:
        return label_map.get(value, value) if value else str(value)

    kind = action.get("type")

    if kind == "respond":
        return f"Reply: {truncate(action.get('text') or '')}"

    if kind == "find_notes":
        parts: List[str] = []
        query = action.get("query")
        if query:
            parts.append(f"“{truncate(query, 60)}”")
        if "folderId" in action:
            folder_id = action["folderId"]
            if folder_id == "current":
                folder_label = "the current folder"
            elif folder_id is None:
                folder_label = "the root"
            else:
                folder_label = name(folder_id)
            parts.append(
                f"in {folder_label} and its subfolders"
                if action.get("recursive")
                else f"in {folder_label}"
            )
        return f"Search notes{' for ' + ' '.join(parts) if parts else ''}"

    if kind == "web_search":
        return f"Search the web for “{truncate(action.get('query') or '', 60)}”"

    if kind == "create_note":
        return f"Create note “{action.get('title') or 'Untitled'}”"

    if kind == "edit_note":
        verb = "Amend" if action.get("mode") == "amend" else "Replace"
        return f"{verb} note “{name(action.get('noteId'))}”"

    if kind == "edit_section":
        return f"Update section “{action.get('section')}” in “{name(action.get('noteId'))}”"

    if kind == "append_note":
        return f"Append to note “{name(action.get('noteId'))}”"

    if kind == "rename_note":
        return f"Rename “{name(action.get('noteId'))}” → “{action.get('title')}”"

    if kind == "create_child_note":
        title = action.get("title") or "Untitled"
        return f"Create child note “{title}” under “{name(action.get('parentId'))}”"

    if kind == "move_note":
        folder_id = action.get("folderId")
        target = f"folder “{name(folder_id)}”" if folder_id else "the root"
        return f"Move “{name(action.get('noteId'))}” to {target}"

    if kind == "set_tags":
        verb = "Add tags to" if action.get("mode") == "add" else "Set tags on"
        tags = ", ".join(action.get("tags") or [])
        return f"{verb} “{name(action.get('noteId'))}”: {tags}"

    if kind == "set_category":
        return (
            f"Set category of “{name(action.get('noteId'))}” "
            f"to “{name(action.get('categoryId'))}”"
        )

    if kind == "create_folder":
        return f"Create folder “{action.get('name')}”"

    if kind == "add_reference":
        under = action.get("insertAfterSection")
        suffix = f" under “{under}”" if under else ""
        return (
            f"Add reference to “{action.get('referenceTitle')}” "
            f"in “{name(action.get('noteId'))}”{suffix}"
        )

    if kind == "add_annotation":
        anchor = truncate(action.get("anchorText") or "", 40)
        return f"Annotate “{anchor}” in “{name(action.get('noteId'))}”"

    if kind == "edit_annotation":
        return f"Edit annotation in “{name(action.get('noteId'))}”"

    if kind == "delete_annotation":
        return f"Delete annotation in “{name(action.get('noteId'))}”"

    if kind == "create_diagram":
        label = DIAGRAM_KIND_LABELS[detect_mermaid_kind(action.get("source") or "")].lower()
        return f"Create {label} in “{name(action.get('noteId'))}”"

    if kind == "edit_diagram":
        return f"Update diagram in “{name(action.get('noteId'))}”"

    if kind == "generate_image":
        section = action.get("section")
        where = f" under “{section}”" if section else ""
        prompt = truncate(action.get("prompt") or "", 60)
        return f"Generate image{where} in “{name(action.get('noteId'))}”: {prompt}"

    if kind == "create_recipe":
        return f"Create recipe “{action.get('name')}”"

    if kind == "update_recipe":
        return f"Update recipe “{name(action.get('recipeId'))}”"

    if kind == "delete_recipe":
        return f"Delete recipe “{name(action.get('recipeId'))}”"

    return str(kind)


# ─── two-phase content generation ────────────────────────────────────────────


def action_spec(action: Mapping[str, Any]) -> str:
    """The deferred-body description on a content-bearing action, else ''."""
    if action.get("type") not in GENERATED_TYPES:
        return ""
    return action.get("spec") or ""


def action_needs_generation(action: Mapping[str, Any]) -> bool:
    """True when an action deferred its body: content-bearing, a non-empty `spec`, and
    an empty `content`. Its body is written by its own model call."""
    if action.get("type") not in GENERATED_TYPES:
        return False
    return bool((action.get("spec") or "").strip()) and not (action.get("content") or "").strip()


def build_plan_summary(plan: Mapping[str, Any]) -> str:
    """The whole plan with note bodies elided — the assistant turn shown to the model
    while it writes one body, so it knows where that body fits.

    Serialised the way JSON.stringify does it (no spaces between tokens, non-ASCII left
    alone) so the turn is byte-identical to the one the browser used to send and the
    model sees no change.
    """
    actions = []
    for action in plan.get("actions") or []:
        copy = dict(action)
        if isinstance(copy.get("content"), str) and copy["content"]:
            copy["content"] = "<written in a later step>"
        actions.append(copy)
    return json.dumps({"actions": actions}, ensure_ascii=False, separators=(",", ":"))


def build_content_step_instruction(
    action: Mapping[str, Any], index: int, label_map: Mapping[str, str]
) -> str:
    """The user turn for one generation call: write a single body, Markdown only.

    The per-type hint mirrors the inline-content rules in PLAN_INSTRUCTIONS, so a
    deferred body behaves the same as an inline one when the executor applies it.
    """
    spec = action_spec(action)
    hint = ""
    if action.get("type") == "edit_section":
        # `section` often carries ATX markers already — the model copies "### Title"
        # verbatim — so strip them or the example heading doubles up ("## ### Title").
        bare = _ATX_PREFIX.sub("", action.get("section") or "").strip()
        hint = f'\n\nBegin with the section\'s heading line (e.g. "## {bare}") and rewrite that whole section.'
    elif action.get("type") == "edit_note" and action.get("mode") == "replace":
        hint = "\n\nThis is the FULL replacement body for the note."

    spec_block = f"\n\nWhat the body must contain:\n{spec}" if spec else ""
    return (
        f"Write the Markdown body for step {index + 1} — "
        f"{default_action_label(action, label_map)}.{spec_block}{hint}"
        "\n\nOutput ONLY the Markdown body for this one item — no JSON, no code fences, "
        "no preamble, no commentary."
    )


def build_generation_steps(
    plan: Mapping[str, Any], label_map: Mapping[str, str]
) -> List[Dict[str, Any]]:
    """One `{index, messages}` step per deferred body, in the shape
    `PromptContext.body_for` appends.

    This is what `runPlan` used to build in the browser via `buildGenerationRequest`;
    it could only be built after the plan existed, which is exactly why it had to
    follow the plan onto the server.
    """
    summary = build_plan_summary(plan)
    steps: List[Dict[str, Any]] = []
    for index, action in enumerate(plan.get("actions") or []):
        if not action_needs_generation(action):
            continue
        steps.append({
            "index": index,
            "messages": [
                {"role": "assistant", "content": summary},
                {"role": "user", "content": build_content_step_instruction(action, index, label_map)},
            ],
        })
    return steps


__all__ = [
    "GENERATED_TYPES",
    "DIAGRAM_KIND_LABELS",
    "truncate",
    "detect_mermaid_kind",
    "default_action_label",
    "action_spec",
    "action_needs_generation",
    "build_plan_summary",
    "build_content_step_instruction",
    "build_generation_steps",
]
