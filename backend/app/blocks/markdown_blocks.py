"""Markdown -> BlockNote JSON.

The AI assistant writes Markdown; a note stores BlockNote blocks. That conversion has
only ever existed in the browser, through the live editor's `tryParseMarkdownToBlocks`
— which is why `routers/import_url.py` returns Markdown and lets the frontend build
the blocks. With plan execution moving to a background worker there is no editor to
borrow, so the conversion has to exist here.

Deliberately hand-written rather than routed through the `markdown` package's HTML.
Going via HTML would add a second lossy hop (HTML -> blocks) on top of the one we are
trying to make faithful, and would drag in nested-structure handling that assistant
output never produces. A line scanner plus a small inline tokenizer maps directly onto
the block shapes below, and is far easier to test.

The shapes are not invented here — they are the ones this codebase already *reads*:

    block        {id, type, props, content, children}   video/worker.py:_attach_to_note
    text         {type, text, styles{bold,italic,underline,strike,code}}
                                                        video/segmenter.py:_inline_text
    link         {type: "link", href, content: [...]}    same, which descends into content
    heading      props.level, 1-6                        planExecutor.ts:sectionHeading
    table        content = {type: "tableContent", rows: [{cells: [...]}]}
                                                        video/segmenter.py:_table_text
    image        props {url, name, caption, showPreview} routers/notes.py:extract_first_image
    codeBlock    props.language                          defaults to "text"

Blocks are given real uuid4 ids. BlockNote will happily hydrate partial blocks without
them, but `Annotation.block_id` anchors to these ids, so emitting them keeps generated
content annotatable.

Where this had to guess, it was checked rather than guessed. The output was diffed
against BlockNote's own parser (`ServerBlockNoteEditor.tryParseMarkdownToBlocks`, the
same version the frontend pins) over a corpus of assistant-shaped Markdown. That is
what settled four things a reading of the docs got wrong: heading levels go to 6, not
3; `divider` is a real default block, so a thematic rule is not dropped; an
unlabelled code fence carries `language: "text"`; and image alt text belongs in
`props.name`, leaving `caption` empty. Where the two still differ, this file follows
BlockNote — an inline image mid-sentence is discarded rather than degraded to its alt
text, because a note must come out the same whether the browser or the worker built
it. Re-run that comparison when bumping @blocknote/core.

Scope note: this covers the Markdown the assistant actually emits. Setext headings
(underlined with === / ---) are not supported, because `---` is ambiguous with a
thematic break and the planner only ever writes ATX headings.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

__all__ = ["markdown_to_blocks"]


# BlockNote's default schema accepts heading levels 1-6 (verified against
# ServerBlockNoteEditor 0.49 — see the differential note in the module docstring).
MAX_HEADING_LEVEL = 6

_ESCAPABLE = set("\\`*_{}[]()#+-.!|~>")

# Longest markers first: "***" has to win over "**", which has to win over "*".
_EMPHASIS: Sequence[Tuple[str, Tuple[str, ...]]] = (
    ("***", ("bold", "italic")),
    ("___", ("bold", "italic")),
    ("**", ("bold",)),
    ("__", ("bold",)),
    ("~~", ("strike",)),
    ("*", ("italic",)),
    ("_", ("italic",)),
)

_ATX_RE = re.compile(r"^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$")
_FENCE_RE = re.compile(r"^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)\s*$")
_THEMATIC_RE = re.compile(r"^ {0,3}([-*_])(?:\s*\1){2,}\s*$")
_QUOTE_RE = re.compile(r"^ {0,3}>\s?(.*)$")
_LIST_RE = re.compile(r"^(?P<indent> *)(?P<marker>[-*+]|\d+[.)])\s+(?P<text>.*)$")
_TASK_RE = re.compile(r"^\[(?P<mark>[ xX])\]\s+(?P<text>.*)$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$")
_IMAGE_ONLY_RE = re.compile(r"^!\[(?P<alt>(?:[^\[\]\\]|\\.)*)\]\((?P<dest>[^)]*)\)$")
_LINK_RE = re.compile(
    r"\[(?P<label>(?:[^\[\]\\]|\\.)*)\]"
    r"\(\s*(?P<dest><[^>]*>|[^()\s]*)"
    r"(?:\s+(?P<quote>[\"'])(?P<title>.*?)(?P=quote))?\s*\)"
)


# ─── public entry point ──────────────────────────────────────────────────────


def markdown_to_blocks(md: Optional[str]) -> List[Dict[str, Any]]:
    """Convert Markdown into a BlockNote document.

    Never returns an empty document: an input that parses to nothing comes back as a
    single paragraph carrying the raw text, mirroring `mdToBlocks` in planExecutor.ts
    so an unparseable body is still visible in the note rather than silently lost.
    """
    raw = md or ""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    blocks = _parse_blocks(text.split("\n"))
    if not blocks:
        return [_block("paragraph", content=[_text_node(raw, {})])]
    return blocks


# ─── block level ─────────────────────────────────────────────────────────────


def _parse_blocks(lines: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    i = 0
    total = len(lines)

    while i < total:
        line = lines[i]

        if not line.strip():
            i += 1
            continue

        fence = _FENCE_RE.match(line)
        if fence:
            block, i = _read_fence(lines, i, fence)
            out.append(block)
            continue

        # Before the list check: "- - -" is a rule, not a bullet holding a bullet.
        if _THEMATIC_RE.match(line):
            out.append(_block("divider"))
            i += 1
            continue

        heading = _ATX_RE.match(line)
        if heading:
            level = min(len(heading.group(1)), MAX_HEADING_LEVEL)
            body = _strip_closing_hashes(heading.group(2) or "")
            out.append(_block("heading", props={"level": level}, content=_parse_inline(body)))
            i += 1
            continue

        if _QUOTE_RE.match(line):
            blocks, i = _read_quote(lines, i)
            out.extend(blocks)
            continue

        if _is_table_start(lines, i):
            block, i = _read_table(lines, i)
            out.append(block)
            continue

        if _LIST_RE.match(line):
            blocks, i = _read_list(lines, i)
            out.extend(blocks)
            continue

        block, i = _read_paragraph(lines, i)
        if block is not None:
            out.append(block)

    return out


def _read_fence(lines: List[str], start: int, fence: "re.Match[str]") -> Tuple[Dict[str, Any], int]:
    indent, ticks, language = fence.group(1), fence.group(2), fence.group(3)
    marker = ticks[0]
    i = start + 1
    body: List[str] = []

    while i < len(lines):
        stripped = lines[i].strip()
        # A closing fence is the same character, at least as long, and nothing else.
        if stripped and set(stripped) == {marker} and len(stripped) >= len(ticks):
            i += 1
            break
        body.append(_drop_indent(lines[i], len(indent)))
        i += 1

    return (
        _block(
            "codeBlock",
            props={"language": language or "text"},
            content=[_text_node("\n".join(body), {})],
        ),
        i,
    )


def _read_quote(lines: List[str], start: int) -> Tuple[List[Dict[str, Any]], int]:
    """A run of `>` lines. Blank quoted lines split it into separate quote blocks,
    because BlockNote's quote holds inline content, not nested paragraphs."""
    i = start
    chunks: List[List[str]] = [[]]

    while i < len(lines):
        match = _QUOTE_RE.match(lines[i])
        if not match:
            break
        content = match.group(1).strip()
        if content:
            chunks[-1].append(content)
        elif chunks[-1]:
            chunks.append([])
        i += 1

    blocks = [
        _block("quote", content=_parse_inline(" ".join(chunk)))
        for chunk in chunks
        if chunk
    ]
    return blocks, i


def _read_paragraph(lines: List[str], start: int) -> Tuple[Optional[Dict[str, Any]], int]:
    i = start
    collected: List[str] = []

    while i < len(lines):
        line = lines[i]
        if not line.strip():
            break
        # Anything that starts a block of its own ends the paragraph.
        if (
            _FENCE_RE.match(line)
            or _THEMATIC_RE.match(line)
            or _ATX_RE.match(line)
            or _QUOTE_RE.match(line)
            or _LIST_RE.match(line)
            or _is_table_start(lines, i)
        ):
            break
        collected.append(line.strip())
        i += 1

    if not collected:
        return None, max(i + 1, start + 1)

    # A line that is nothing but an image is a media block, not prose about one.
    if len(collected) == 1:
        image = _IMAGE_ONLY_RE.match(collected[0])
        if image:
            return _image_block(image.group("alt"), image.group("dest")), i

    return _block("paragraph", content=_parse_inline(" ".join(collected))), i


# ─── lists ───────────────────────────────────────────────────────────────────


def _read_list(lines: List[str], start: int) -> Tuple[List[Dict[str, Any]], int]:
    """Read a run of list items, nesting deeper-indented ones as children."""
    i = start
    items: List[Tuple[int, Dict[str, Any]]] = []  # (indent, block)

    while i < len(lines):
        line = lines[i]
        if not line.strip():
            # A blank line only ends the list if what follows is not another item.
            nxt = i + 1
            if nxt < len(lines) and _LIST_RE.match(lines[nxt]):
                i += 1
                continue
            break

        match = _LIST_RE.match(line)
        if not match:
            # An indented non-item line continues the previous item's text.
            if items and line.startswith(" ") and line.strip():
                _append_text(items[-1][1], line.strip())
                i += 1
                continue
            break

        indent = len(match.group("indent"))
        items.append((indent, _list_item(match)))
        i += 1

    return _nest(items), i


def _list_item(match: "re.Match[str]") -> Dict[str, Any]:
    text = match.group("text")
    task = _TASK_RE.match(text)
    if task:
        return _block(
            "checkListItem",
            props={"checked": task.group("mark").lower() == "x"},
            content=_parse_inline(task.group("text")),
        )
    ordered = match.group("marker")[0].isdigit()
    return _block(
        "numberedListItem" if ordered else "bulletListItem",
        content=_parse_inline(text),
    )


def _nest(items: List[Tuple[int, Dict[str, Any]]]) -> List[Dict[str, Any]]:
    roots: List[Dict[str, Any]] = []
    stack: List[Tuple[int, Dict[str, Any]]] = []

    for indent, block in items:
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if stack:
            stack[-1][1]["children"].append(block)
        else:
            roots.append(block)
        stack.append((indent, block))

    return roots


def _append_text(block: Dict[str, Any], text: str) -> None:
    content = block.get("content")
    if isinstance(content, list):
        block["content"] = _parse_inline(f"{_inline_to_source(content)} {text}")


def _inline_to_source(content: List[Dict[str, Any]]) -> str:
    """Flatten already-parsed inline content back to plain text, so a continuation
    line can be re-parsed with it as one string."""
    parts: List[str] = []
    for item in content:
        if item.get("type") == "text":
            parts.append(str(item.get("text") or ""))
        elif isinstance(item.get("content"), list):
            parts.append(_inline_to_source(item["content"]))
    return "".join(parts)


# ─── tables ──────────────────────────────────────────────────────────────────


def _is_table_start(lines: List[str], i: int) -> bool:
    """A GFM table is a header row followed by a separator row. Without the
    separator a line with pipes in it is just prose."""
    if "|" not in lines[i]:
        return False
    return i + 1 < len(lines) and bool(_TABLE_SEP_RE.match(lines[i + 1]))


def _read_table(lines: List[str], start: int) -> Tuple[Dict[str, Any], int]:
    header = _split_row(lines[start])
    columns = len(header)
    rows = [header]

    i = start + 2  # skip the separator
    while i < len(lines) and lines[i].strip() and "|" in lines[i]:
        rows.append(_split_row(lines[i]))
        i += 1

    content = {
        "type": "tableContent",
        "columnWidths": [None] * columns,
        "headerRows": 1,
        "rows": [{"cells": [_table_cell(cell) for cell in _fit(row, columns)]} for row in rows],
    }
    return _block("table", content=content), i


def _split_row(line: str) -> List[str]:
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|") and not stripped.endswith("\\|"):
        stripped = stripped[:-1]

    cells: List[str] = []
    buf: List[str] = []
    i = 0
    while i < len(stripped):
        char = stripped[i]
        if char == "\\" and i + 1 < len(stripped) and stripped[i + 1] == "|":
            buf.append("|")
            i += 2
            continue
        if char == "|":
            cells.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(char)
        i += 1
    cells.append("".join(buf).strip())
    return cells


def _fit(row: List[str], columns: int) -> List[str]:
    """Pad or trim a row so every row has the header's column count — a ragged table
    would otherwise render with missing cells."""
    return (row + [""] * columns)[:columns]


def _table_cell(text: str) -> Dict[str, Any]:
    return {
        "type": "tableCell",
        "content": _parse_inline(text),
        "props": {
            "colspan": 1,
            "rowspan": 1,
            "backgroundColor": "default",
            "textColor": "default",
            "textAlignment": "left",
        },
    }


# ─── inline level ────────────────────────────────────────────────────────────


def _parse_inline(text: str, styles: Optional[Dict[str, bool]] = None) -> List[Dict[str, Any]]:
    """Tokenize inline Markdown into BlockNote inline content.

    Recursive descent over an explicit marker set. `styles` carries the marks of the
    enclosing span, so nesting composes: "**a *b* c**" gives bold, bold+italic, bold.
    """
    active = dict(styles or {})
    out: List[Dict[str, Any]] = []
    buf: List[str] = []

    def flush() -> None:
        if buf:
            out.append(_text_node("".join(buf), active))
            buf.clear()

    i = 0
    total = len(text)

    while i < total:
        char = text[i]

        if char == "\\" and i + 1 < total and text[i + 1] in _ESCAPABLE:
            buf.append(text[i + 1])
            i += 2
            continue

        if char == "`":
            span = _code_span(text, i)
            if span is not None:
                code, end = span
                flush()
                out.append(_text_node(code, {**active, "code": True}))
                i = end
                continue

        # `image` is a block, so an image mid-sentence has no inline equivalent.
        # BlockNote's own parser drops it; matching that matters more than salvaging
        # the alt text, because the two execution paths must produce the same note.
        if char == "!" and i + 1 < total and text[i + 1] == "[":
            match = _LINK_RE.match(text, i + 1)
            if match:
                i = match.end()
                continue

        if char == "[":
            match = _LINK_RE.match(text, i)
            if match:
                flush()
                href = _clean_destination(match.group("dest"))
                label = _flatten_links(_parse_inline(match.group("label"), active))
                out.append({
                    "type": "link",
                    "href": href,
                    "content": label or [_text_node(href, active)],
                })
                i = match.end()
                continue

        emphasis = _emphasis_at(text, i, text[i - 1] if i else "")
        if emphasis is not None:
            marker, added, inner_start, inner_end = emphasis
            flush()
            nested = dict(active)
            for style in added:
                nested[style] = True
            out.extend(_parse_inline(text[inner_start:inner_end], nested))
            i = inner_end + len(marker)
            continue

        buf.append(char)
        i += 1

    flush()
    return out


def _emphasis_at(
    text: str, i: int, prev: str
) -> Optional[Tuple[str, Tuple[str, ...], int, int]]:
    """If an emphasis span opens at `i`, return (marker, styles, inner_start, inner_end)."""
    for marker, styles in _EMPHASIS:
        if not text.startswith(marker, i):
            continue

        # Underscores only open at a word boundary, so snake_case_names survive.
        if marker[0] == "_" and prev.isalnum():
            continue

        inner_start = i + len(marker)
        if inner_start >= len(text) or text[inner_start].isspace():
            continue

        close = _find_unescaped(text, inner_start, marker)
        # A closer preceded by whitespace ("a ** b") is not a closer; keep looking.
        while close != -1 and close > inner_start and text[close - 1].isspace():
            close = _find_unescaped(text, close + len(marker), marker)

        if close in (-1, inner_start):
            continue

        if marker[0] == "_":
            after = text[close + len(marker):close + len(marker) + 1]
            if after.isalnum():
                continue

        return marker, styles, inner_start, close

    return None


def _find_unescaped(text: str, start: int, marker: str) -> int:
    i = start
    total = len(text)
    while i < total:
        if text[i] == "\\":
            i += 2
            continue
        if text.startswith(marker, i):
            return i
        i += 1
    return -1


def _code_span(text: str, i: int) -> Optional[Tuple[str, int]]:
    """A backtick run opens a code span that ends at a run of the same length.
    Nothing inside is interpreted — that is the point of a code span."""
    total = len(text)
    j = i
    while j < total and text[j] == "`":
        j += 1
    ticks = text[i:j]

    k = j
    while k < total:
        if text[k] == "`":
            end = k
            while end < total and text[end] == "`":
                end += 1
            if text[k:end] == ticks:
                return text[j:k], end
            k = end
            continue
        k += 1
    return None


def _flatten_links(content: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """BlockNote link content holds styled text, not further links. A nested link in
    a label is flattened to its text."""
    out: List[Dict[str, Any]] = []
    for item in content:
        if item.get("type") == "text":
            out.append(item)
        elif isinstance(item.get("content"), list):
            out.extend(_flatten_links(item["content"]))
    return out


# ─── small shared pieces ─────────────────────────────────────────────────────


def _block(
    block_type: str,
    props: Optional[Dict[str, Any]] = None,
    content: Optional[Any] = None,
    children: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    block: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "type": block_type,
        "props": dict(props or {}),
    }
    if content is not None:
        block["content"] = content
    block["children"] = children if children is not None else []
    return block


def _image_block(alt: str, dest: str) -> Dict[str, Any]:
    # Alt text lands in `name`, not `caption` — that is where BlockNote's parser puts
    # it, and `caption` stays empty for the user to fill in.
    return _block(
        "image",
        props={
            "url": _clean_destination(dest),
            "name": _unescape(alt),
            "caption": "",
            "showPreview": True,
        },
    )


def _text_node(text: str, styles: Optional[Dict[str, bool]]) -> Dict[str, Any]:
    return {
        "type": "text",
        "text": text,
        "styles": {key: True for key, value in (styles or {}).items() if value},
    }


def _clean_destination(dest: str) -> str:
    cleaned = (dest or "").strip()
    if cleaned.startswith("<") and cleaned.endswith(">"):
        cleaned = cleaned[1:-1]
    return cleaned.strip()


def _unescape(text: str) -> str:
    out: List[str] = []
    i = 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text) and text[i + 1] in _ESCAPABLE:
            out.append(text[i + 1])
            i += 2
            continue
        out.append(text[i])
        i += 1
    return "".join(out)


def _strip_closing_hashes(text: str) -> str:
    """"## Title ##" is a closed ATX heading; the trailing run is markup, not text."""
    return re.sub(r"\s+#+$", "", text.strip()).strip()


def _drop_indent(line: str, amount: int) -> str:
    """Remove up to `amount` leading spaces, leaving deeper indentation intact —
    code block bodies keep their own structure."""
    i = 0
    while i < amount and i < len(line) and line[i] == " ":
        i += 1
    return line[i:]
