"""BlockNote blocks back to Markdown.

`markdown_blocks.py` is the writing half — Markdown in, blocks out — so a worker can
put generated prose into a note. This is the reading half, and it exists for the same
reason: planning runs on the server now, so when a `find_notes` round turns up notes
mid-turn, the worker has to put their bodies in front of the model. The browser used
to do this with the editor's own `blocksToMarkdownLossy`; there is no editor here.

Plain text would not do. The model targets sections by heading (`edit_section` names
one), so a body flattened to prose is a body it can no longer edit precisely —
`extract_full_text` in routers/notes.py is the right tool for word counts and the
wrong one for this.

This is deliberately NOT byte-compatible with BlockNote's serializer, which writes
`*` bullets with blank lines between them but `*` checklist items without, and `***`
for a divider. Matching those quirks would buy nothing: the only consumer is a prompt,
and the model neither notices nor cares. What matters is that the structure survives,
so the conventions here are the ones `markdown_to_blocks` parses most cleanly — which
makes round-tripping the real test, and the one `tests/test_block_markdown.py` runs.

Blocks Markdown cannot express — diagrams, note references, child notes — are written
as a labelled line carrying their id, rather than dropped. The model is told what is
in the note and can name it in an action; silently omitting them is how you get a plan
that "rewrites" a section and deletes the diagram in it.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Mapping, Optional, Sequence

# Inline marks, in the order they wrap: the outermost is applied last so
# bold+italic reads `***text***` rather than `*​**text**​*`.
_MARKS = (
    ("code", "`"),
    ("strike", "~~"),
    ("italic", "*"),
    ("bold", "**"),
)

# Bullet and check markers. `-` rather than BlockNote's `*` because it is what
# markdown_to_blocks parses and what the model itself emits.
_BULLET = "-"


def blocks_to_markdown(blocks: Any) -> str:
    """A note body as Markdown. Accepts the parsed list or the stored JSON string."""
    if isinstance(blocks, str):
        try:
            blocks = json.loads(blocks or "[]")
        except (ValueError, TypeError):
            return blocks or ""
    if not isinstance(blocks, list):
        return ""
    return "\n".join(_render(blocks, depth=0)).strip() + "\n" if blocks else ""


def note_to_markdown(content: Any) -> str:
    """The stored `Note.content` column as Markdown, never raising."""
    try:
        return blocks_to_markdown(content)
    except Exception:  # a malformed body must not take a whole turn down
        return ""


# ─── block level ─────────────────────────────────────────────────────────────


def _render(blocks: Sequence[Any], depth: int) -> List[str]:
    """Lines for a run of blocks, with `depth` levels of list indentation.

    Consecutive items of the SAME list kind are kept tight (no blank line between) and
    everything else is separated by one. Same-kind matters: a bulleted list running
    straight into a numbered one with no blank line between them is a single list to
    most parsers, which is not what the document said.
    """
    lines: List[str] = []
    previous_list_kind: Optional[str] = None

    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        list_kind = kind if kind in (
            "bulletListItem", "numberedListItem", "checkListItem"
        ) else None

        rendered = _render_block(block, depth, index=_list_index(blocks, block))
        if not rendered:
            continue
        if lines and not (list_kind and list_kind == previous_list_kind):
            lines.append("")
        lines.extend(rendered)
        previous_list_kind = list_kind

    return lines


def _list_index(blocks: Sequence[Any], block: Mapping[str, Any]) -> int:
    """Position of a numbered item within its own unbroken run, 1-based.

    Counting the run rather than the whole list is what makes a numbered list that
    follows a paragraph start at 1 again.
    """
    if block.get("type") != "numberedListItem":
        return 1
    index = 0
    for candidate in blocks:
        if not isinstance(candidate, dict):
            continue
        if candidate.get("type") != "numberedListItem":
            index = 0
            continue
        index += 1
        if candidate is block:
            return index
    return index or 1


def _render_block(block: Mapping[str, Any], depth: int, index: int = 1) -> List[str]:
    kind = block.get("type")
    props = block.get("props") or {}
    pad = "  " * depth
    text = _inline(block.get("content"))
    children = block.get("children") or []

    if kind == "heading":
        level = props.get("level")
        level = level if isinstance(level, int) and 1 <= level <= 6 else 1
        lines = [f"{'#' * level} {text}".rstrip()]
    elif kind == "paragraph":
        # An empty paragraph is a spacer in the editor and noise in a prompt.
        lines = [text] if text.strip() else []
    elif kind == "quote":
        lines = [f"> {text}".rstrip()]
    elif kind == "bulletListItem":
        lines = [f"{pad}{_BULLET} {text}".rstrip()]
    elif kind == "numberedListItem":
        lines = [f"{pad}{index}. {text}".rstrip()]
    elif kind == "checkListItem":
        box = "x" if props.get("checked") else " "
        lines = [f"{pad}{_BULLET} [{box}] {text}".rstrip()]
    elif kind == "codeBlock":
        language = props.get("language") or ""
        lines = [f"```{language}", *(_raw_text(block.get("content")).split("\n")), "```"]
    elif kind == "divider":
        lines = ["---"]
    elif kind == "table":
        lines = _render_table(block.get("content"))
    elif kind == "image":
        lines = [f"![{props.get('name') or ''}]({props.get('url') or ''})"]
        caption = props.get("caption")
        if caption:
            lines.append(f"*{caption}*")
    elif kind in ("video", "audio", "file"):
        label = props.get("name") or kind
        lines = [f"[{label}]({props.get('url') or ''})"]
    elif kind == "diagram":
        lines = _render_embed(kind, props)
    elif kind in ("childNote", "noteReference"):
        lines = _render_embed(kind, props)
    else:
        # An unknown block still has text worth showing more often than not.
        lines = [text] if text.strip() else []

    if children:
        # List children nest one level deeper; anything else keeps its own indent.
        child_depth = depth + 1 if kind in (
            "bulletListItem", "numberedListItem", "checkListItem"
        ) else depth
        child_lines = _render(children, child_depth)
        if child_lines:
            if lines and child_depth == depth:
                lines.append("")
            lines.extend(child_lines)

    return lines


def _render_embed(kind: str, props: Mapping[str, Any]) -> List[str]:
    """Blocks Markdown has no syntax for, written so the model can still name them.

    The id is included deliberately: `edit_diagram` and the annotation actions target
    by id, and a body that mentions a diagram without saying which one is a body the
    model has to guess about.
    """
    if kind == "diagram":
        source = props.get("source") or ""
        diagram_id = props.get("diagramId") or ""
        head = f"[diagram{f' {diagram_id}' if diagram_id else ''}]"
        return [head, "```mermaid", *source.split("\n"), "```"]
    if kind == "childNote":
        title = props.get("title") or "Untitled"
        return [f"[child note “{title}” — id {props.get('childNoteId') or ''}]"]
    title = props.get("noteTitle") or "Untitled"
    return [f"[reference to “{title}” — id {props.get('noteId') or ''}]"]


def _render_table(content: Any) -> List[str]:
    rows = (content or {}).get("rows") if isinstance(content, dict) else None
    if not isinstance(rows, list) or not rows:
        return []

    grid: List[List[str]] = []
    for row in rows:
        cells = (row or {}).get("cells") if isinstance(row, dict) else None
        if not isinstance(cells, list):
            continue
        grid.append([_cell_text(cell) for cell in cells])
    if not grid:
        return []

    width = max(len(row) for row in grid)
    lines = [_table_row(grid[0], width), _table_row(["-"] * width, width)]
    lines.extend(_table_row(row, width) for row in grid[1:])
    return lines


def _table_row(cells: Sequence[str], width: int) -> str:
    padded = list(cells) + [""] * (width - len(cells))
    # A literal pipe inside a cell would end the cell early.
    return "| " + " | ".join(c.replace("|", "\\|") for c in padded) + " |"


def _cell_text(cell: Any) -> str:
    if isinstance(cell, dict):
        return _inline(cell.get("content"))
    return _inline(cell)


# ─── inline level ────────────────────────────────────────────────────────────


def _inline(content: Any) -> str:
    """Inline content as Markdown, marks and links included."""
    if isinstance(content, str):
        return _escape(content)
    if not isinstance(content, list):
        return ""

    parts: List[str] = []
    runs: List[Mapping[str, Any]] = []

    def flush() -> None:
        if runs:
            parts.append(_marked(runs, frozenset()))
            runs.clear()

    for item in content:
        if isinstance(item, str):
            flush()
            parts.append(_escape(item))
            continue
        if not isinstance(item, dict):
            continue
        if item.get("type") == "link":
            flush()
            label = _inline(item.get("content"))
            href = item.get("href") or ""
            parts.append(f"[{label}]({href})" if href else label)
            continue
        runs.append(item)
    flush()
    return "".join(parts)


def _marks_of(item: Mapping[str, Any]) -> frozenset:
    styles = item.get("styles")
    if not isinstance(styles, dict):
        return frozenset()
    return frozenset(mark for mark, _ in _MARKS if styles.get(mark))


def _marked(runs: Sequence[Mapping[str, Any]], active: frozenset) -> str:
    """A run of text nodes, factoring out the marks they share.

    Wrapping each node on its own is what BlockNote's own serializer does, and it
    turns `**bold with *italic* inside**` into `**bold with&#x20;*****italic*****&#x20;
    inside**` — technically re-readable, unreadable to a person, and not what the note
    said. Grouping instead finds the longest neighbouring run sharing a mark and wraps
    that once, which reproduces the original nesting.
    """
    # Inside a code span every character is already literal, so a backslash added
    # there is a backslash the reader sees.
    literal = "code" in active

    out: List[str] = []
    i = 0
    while i < len(runs):
        pending = _marks_of(runs[i]) - active
        if not pending:
            out.append(_text_of(runs[i], literal))
            i += 1
            continue

        # Whichever pending mark covers the most neighbours becomes the outer wrapper,
        # so the common mark ends up outside and the exception nests inside it.
        best_mark, best_end = None, i
        for mark, _marker in _MARKS:
            if mark not in pending:
                continue
            end = i
            while end < len(runs) and mark in _marks_of(runs[end]):
                end += 1
            if end > best_end:
                best_mark, best_end = mark, end
        if best_mark is None:  # unreachable while pending is non-empty
            out.append(_text_of(runs[i], literal))
            i += 1
            continue

        marker = dict(_MARKS)[best_mark]
        inner = _marked(runs[i:best_end], active | {best_mark})
        out.append(_wrap(inner, marker))
        i = best_end
    return "".join(out)


def _text_of(run: Mapping[str, Any], literal: bool) -> str:
    text = str(run.get("text") or "")
    return text if literal else _escape(text)


def _wrap(inner: str, marker: str) -> str:
    """Apply a mark, keeping the surrounding spaces outside it.

    `** bold **` is not bold to any Markdown parser, so a marker that swallowed its
    own leading or trailing whitespace would come back as literal asterisks.
    """
    if not inner:
        return ""
    core = inner.strip()
    if not core:
        return inner
    lead = inner[: len(inner) - len(inner.lstrip())]
    trail = inner[len(inner.rstrip()):]
    return f"{lead}{marker}{core}{marker}{trail}"


# Characters `markdown_to_blocks` acts on wherever they appear. `_`, `~` and `[` are
# not here: each is only meaningful in a context the checks below test for, and
# escaping them unconditionally would litter ordinary prose — `snake_case_name` and
# `~/notes` and `[sic]` all read back unchanged, so none of them earns a backslash.
_ALWAYS_ESCAPE = frozenset("\\`*")

_LINK_AHEAD = re.compile(r"[^\]]*\]\(")


def _escape(text: str) -> str:
    """Backslash the characters that would otherwise be read back as markup.

    Only where it changes the reading. The parser is conservative — intraword `_` is
    not emphasis, a lone `~` is not strike, and `[brackets]` with no `(url)` after them
    are just brackets — so matching its rules here keeps the output legible instead of
    escaping every underscore in every identifier.
    """
    out: List[str] = []
    for i, char in enumerate(text):
        if char in _ALWAYS_ESCAPE:
            out.append("\\" + char)
        elif char == "_" and _at_word_edge(text, i):
            out.append("\\_")
        elif char == "~" and (text[i - 1: i] == "~" or text[i + 1: i + 2] == "~"):
            out.append("\\~")
        elif char == "[" and _LINK_AHEAD.match(text, i + 1):
            out.append("\\[")
        else:
            out.append(char)
    return "".join(out)


def _at_word_edge(text: str, i: int) -> bool:
    """True where an underscore could open or close emphasis — i.e. not inside a word."""
    before = text[i - 1: i] if i else ""
    after = text[i + 1: i + 2]
    return not (before.isalnum() and after.isalnum())


def _raw_text(content: Any) -> str:
    """Unstyled text, for a code block — where a `*` is a `*`."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: List[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            if item.get("type") == "link":
                parts.append(_raw_text(item.get("content")))
            else:
                parts.append(str(item.get("text") or ""))
    return "".join(parts)


__all__ = ["blocks_to_markdown", "note_to_markdown"]
