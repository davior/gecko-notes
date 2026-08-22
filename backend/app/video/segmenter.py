"""BlockNote document -> a flat list of shots.

A "shot" is one continuous piece of screen time: a background (still image,
looping video, or a Pillow-composed card) plus the narration heard over it. The
document is walked in order and every image/video acts as a boundary — the text
between one media block and the next becomes that media's narration.

Flattening to shots rather than nesting segments is what keeps the renderer
simple: a clip that carries its own audio is not a special case inside a segment,
it is simply two shots (the clip with its sound, then the same clip looped muted
under the text that follows it), and title/chapter cards are shots too. One
ffmpeg invocation per shot, one progress tick per shot.
"""

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

from app.routers.media import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from app.video.options import RenderOptions

ShotKind = Literal["still", "video_muted", "video_sound", "card"]

# Blocks whose text is spoken. Everything else is either a media boundary or
# skipped outright (see SILENT_TYPES).
NARRATED_TYPES = frozenset({
    "paragraph", "heading", "bulletListItem", "numberedListItem",
    "checkListItem", "quote", "table",
})

# Present in the document but never read aloud: they're navigation affordances
# or players, not prose. codeBlock is handled separately (opt-in via options).
SILENT_TYPES = frozenset({"childNote", "noteReference", "audioFile"})


@dataclass
class Shot:
    """One unit of screen time."""

    kind: ShotKind
    # Absolute path to the background media, or None to use the fallback.
    background: Optional[str] = None
    # Text spoken over this shot. Empty for a sounded clip or a silent card.
    narration: str = ""
    # Text drawn on a title/chapter card.
    card_title: Optional[str] = None
    card_subtitle: Optional[str] = None
    # When set, a chapter mark is emitted at this shot's start.
    chapter: Optional[str] = None
    # Set on the second half of a sounded-clip pair, purely for readable logs.
    label: str = ""


@dataclass
class Segmentation:
    shots: List[Shot] = field(default_factory=list)
    # Media referenced by the note that we could not use (remote URLs, missing
    # files). Surfaced on the job so the user knows why a section is plain.
    warnings: List[str] = field(default_factory=list)

    @property
    def narration_chars(self) -> int:
        return sum(len(s.narration) for s in self.shots)


def _inline_text(content: Any) -> str:
    """Flatten BlockNote inline content, descending into links.

    notes.extract_full_text only reads `type == "text"` nodes, which drops the
    label of every hyperlink — fine for a word count, wrong for narration.
    """
    if not isinstance(content, list):
        return ""
    parts: List[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            if item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif isinstance(item.get("content"), list):
                parts.append(_inline_text(item["content"]))
    return "".join(parts)


def _table_text(block: Dict[str, Any]) -> str:
    """Read a table row by row so cells are spoken in a sensible order."""
    content = block.get("content")
    if not isinstance(content, dict):
        return ""
    lines: List[str] = []
    for row in content.get("rows") or []:
        if not isinstance(row, dict):
            continue
        cells = [_inline_text(c.get("content") if isinstance(c, dict) else c).strip()
                 for c in (row.get("cells") or [])]
        cells = [c for c in cells if c]
        if cells:
            lines.append(", ".join(cells))
    return "\n".join(lines)


def _extension(url: str) -> str:
    path = url.split("?", 1)[0].split("#", 1)[0]
    _, ext = os.path.splitext(path)
    return ext.lower()


def resolve_media_path(url: str, user_id: str, media_dir: str) -> Optional[str]:
    """Map a `/media/<user_id>/<file>` URL to a path inside that user's directory.

    Returns None for anything else — a remote URL, another user's file, or a
    traversal attempt. Remote media is deliberately not fetched here: the render
    worker must never make outbound requests to a URL taken from note content.
    """
    if not isinstance(url, str) or not url.startswith("/media/"):
        return None
    rest = url[len("/media/"):].split("?", 1)[0].split("#", 1)[0]
    parts = rest.split("/")
    if len(parts) != 2:
        return None
    owner, filename = parts
    if owner != user_id:
        return None
    if not filename or "\\" in filename or ".." in filename:
        return None
    user_dir = os.path.realpath(os.path.join(media_dir, user_id))
    path = os.path.realpath(os.path.join(user_dir, filename))
    if path != user_dir and not path.startswith(user_dir + os.sep):
        return None
    return path if os.path.isfile(path) else None


def _media_kind(url: str) -> Optional[str]:
    ext = _extension(url)
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    return None


def _classify(block: Dict[str, Any], options: RenderOptions) -> Optional[str]:
    """Return "image" / "video" if this block is a media boundary, else None."""
    btype = block.get("type")
    props = block.get("props") or {}
    url = props.get("url")

    if btype == "image":
        return "image" if isinstance(url, str) and url else None
    if btype == "videoFile":
        return "video" if isinstance(url, str) and url else None
    if btype == "file" and isinstance(url, str) and url:
        # BlockNote's generic file block is used for transcripts and downloads as
        # well as media, so go by extension rather than by block type.
        return _media_kind(url)
    if btype == "diagram":
        # Mermaid is rendered client-side; the browser uploads a PNG for us and
        # passes the block id in options.diagram_images. Without one, skip it.
        block_id = block.get("id")
        return "image" if isinstance(block_id, str) and block_id in options.diagram_images else None
    return None


def _media_url(block: Dict[str, Any], options: RenderOptions) -> Optional[str]:
    if block.get("type") == "diagram":
        return options.diagram_images.get(str(block.get("id") or ""))
    return ((block.get("props") or {}).get("url")) or None


# Terminators the sentence splitter (and a TTS voice) already pause on.
_TERMINATORS = ".!?…:;,"


def _as_sentence(text: str) -> str:
    """Give a block's text a terminator so it doesn't run into the next one.

    Headings and list items are usually written without punctuation, which makes
    a TTS voice read straight through them and puts two unrelated thoughts in
    one subtitle line. A full stop restores the pause the layout implied.
    """
    stripped = (text or "").strip()
    if not stripped or stripped[-1] in _TERMINATORS:
        return stripped
    return stripped + "."


def _block_narration(block: Dict[str, Any], options: RenderOptions) -> str:
    btype = block.get("type")
    if btype in SILENT_TYPES:
        return ""
    if btype == "codeBlock":
        return _inline_text(block.get("content")) if options.narrate_code else ""
    if btype == "table":
        return _table_text(block)
    if btype in NARRATED_TYPES:
        return _inline_text(block.get("content"))
    return ""


def _flatten(blocks: Any) -> List[Dict[str, Any]]:
    """Depth-first document order, parents before their children."""
    out: List[Dict[str, Any]] = []

    def walk(block_list: Any) -> None:
        if not isinstance(block_list, list):
            return
        for block in block_list:
            if not isinstance(block, dict):
                continue
            out.append(block)
            walk(block.get("children") or [])

    walk(blocks)
    return out


def segment(
    content: str,
    *,
    user_id: str,
    media_dir: str,
    options: RenderOptions,
    note_title: str = "",
    author: str = "",
    has_audio: Optional[Any] = None,
) -> Segmentation:
    """Turn note content into shots.

    `has_audio` is a callable(path) -> bool used to decide whether a video clip
    carries its own audio track; the renderer passes an ffprobe-backed one, and
    tests pass a stub. When it is None every clip is treated as silent.
    """
    result = Segmentation()

    try:
        blocks = json.loads(content or "[]")
    except (ValueError, TypeError):
        blocks = []
    if not isinstance(blocks, list):
        blocks = []

    if options.title_card and (note_title or author):
        result.shots.append(Shot(
            kind="card",
            card_title=note_title or "Untitled",
            card_subtitle=author,
            chapter=note_title or None,
            label="title card",
        ))

    # Text accumulated since the last media boundary, plus the shot it belongs to.
    pending_text: List[str] = []
    # The shot that pending_text will be attached to when the next boundary lands.
    open_shot: Optional[Shot] = None
    # A heading seen since the last boundary, to hang a chapter mark on.
    pending_chapter: Optional[str] = None
    pending_card: Optional[Shot] = None

    def flush(next_shot: Optional[Shot]) -> None:
        """Close the open shot with whatever narration has accumulated."""
        nonlocal pending_text, open_shot, pending_chapter, pending_card
        text = "\n".join(t for t in pending_text if t).strip()

        if open_shot is None and text:
            # Text before the first media block: give it the fallback background.
            open_shot = Shot(kind="still", background=None, label="opening")
        if open_shot is not None:
            open_shot.narration = text
            if pending_chapter and not open_shot.chapter:
                open_shot.chapter = pending_chapter
            if pending_card is not None:
                result.shots.append(pending_card)
                pending_card = None
            result.shots.append(open_shot)
        elif pending_card is not None:
            result.shots.append(pending_card)
            pending_card = None

        pending_text = []
        pending_chapter = None
        open_shot = next_shot

    for block in _flatten(blocks):
        kind = _classify(block, options)

        if kind is None:
            btype = block.get("type")
            if btype == "heading":
                heading = _inline_text(block.get("content")).strip()
                if heading:
                    if options.chapter_screens:
                        # A chapter screen interrupts: close the current shot so
                        # the card lands between sections rather than mid-thought.
                        # Nothing from this heading is recorded before the flush,
                        # or the section *above* it would be labelled with the
                        # chapter this heading is opening.
                        flush(None)
                        # The card reads its own heading. Letting the heading fall
                        # through to the next section instead would show it in
                        # silence and then speak it over the following shot, once
                        # the words were no longer on screen.
                        pending_card = Shot(
                            kind="card", card_title=heading, chapter=heading,
                            narration=_as_sentence(heading), label="chapter card",
                        )
                        # The card carries the chapter mark, so the section after
                        # it must not claim the same one and duplicate the entry.
                        pending_chapter = None
                        continue
                    # Without a chapter screen the heading is read inside the
                    # section it introduces, so that shot carries the mark.
                    if pending_chapter is None:
                        pending_chapter = heading
            text = _block_narration(block, options)
            if text.strip():
                pending_text.append(_as_sentence(text))
            continue

        url = _media_url(block, options)
        path = resolve_media_path(url, user_id, media_dir) if url else None
        if path is None:
            if url and not url.startswith("/media/"):
                result.warnings.append(f"Skipped remote media: {url[:120]}")
            elif url:
                result.warnings.append(f"Skipped missing media: {url[:120]}")
            # Not usable as a background — but it is still a boundary, so close
            # the current shot and open a fallback-background one in its place.
            flush(Shot(kind="still", background=None, label="fallback"))
            continue

        if kind == "image":
            flush(Shot(kind="still", background=path))
            continue

        # A video clip. If it carries audio it plays whole with its own sound and
        # the narration waits; the text below it then runs over the same clip
        # looped silently, so the section stays visually continuous.
        sounded = bool(has_audio(path)) if callable(has_audio) else False
        if sounded:
            flush(None)
            result.shots.append(Shot(kind="video_sound", background=path, label="clip with audio"))
            open_shot = Shot(kind="video_muted", background=path, label="clip continued, muted")
        else:
            flush(Shot(kind="video_muted", background=path))

    flush(None)

    # Drop a trailing shot that ended up with nothing to show or say. A media
    # shot with no narration is kept — it still displays for min_shot_seconds.
    result.shots = [
        s for s in result.shots
        if s.kind != "still" or s.background is not None or s.narration.strip()
    ]
    return result
