"""BlockNote document -> a flat list of shots.

A "shot" is one continuous piece of screen time: a background (still image,
looping video, or a Pillow-composed card) plus the narration heard over it. The
document is walked in order and every image/video acts as a boundary — the text
between one media block and the next becomes that media's narration. The walk
itself is in `importer`, which records it as a VideoSpec; `segment()` compiles
that spec back to shots. This module keeps the shot model and the reading of
blocks — what counts as media, what text a block speaks — that both share.

Flattening to shots rather than nesting segments is what keeps the renderer
simple: a clip that carries its own audio is not a special case inside a segment,
it is simply two shots (the clip with its sound, then the same clip looped muted
under the text that follows it), and title/chapter cards are shots too. One
ffmpeg invocation per shot, one progress tick per shot.
"""

import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Tuple

from app.routers.media import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from app.video.options import RenderOptions
from app.video.pause_markup import strip_pause_markup

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
    # "title" or "chapter" — the two are sized independently.
    card_kind: Optional[str] = None
    # When set, a chapter mark is emitted at this shot's start.
    chapter: Optional[str] = None
    # A pull quote drawn over this shot's background while it is read.
    quote_text: Optional[str] = None
    quote_attribution: Optional[str] = None
    # A code block drawn over this shot's background. Always drawn when set;
    # `narration` above only carries its text when narrate_code is on — see
    # the importer's codeBlock branch.
    code_text: Optional[str] = None
    # "intro" or "outro" for a clip bracketing the article (see importer._bumper).
    # The renderer draws nothing of its own over one of these.
    bumper: Optional[str] = None
    # Set on the second half of a sounded-clip pair, purely for readable logs.
    label: str = ""
    # Joined to the shot before by a straight cut, whatever the video's
    # transition: it carries on over the same picture (a heading partway
    # through a section), so a dip or blend would show nothing changing.
    cut_in: bool = False

    def __post_init__(self) -> None:
        # A pause marker is an instruction to the voice, not something to look
        # at. `narration` keeps its markers — `parse_pause_markup` needs them
        # to place the silence and strips them itself on the way to the TTS
        # request — but every field below is *drawn* by `compose`, and nothing
        # downstream of here would have taken them out, so `[pause:2s]` typed
        # into a heading was rendered onto the video. `code_text` is left
        # alone: bracketed text inside a code block is code.
        for drawn in ("card_title", "card_subtitle", "chapter",
                      "quote_text", "quote_attribution"):
            value = getattr(self, drawn)
            if value:
                setattr(self, drawn, strip_pause_markup(value) or None)


@dataclass
class Segmentation:
    shots: List[Shot] = field(default_factory=list)
    # Media referenced by the note that we could not use (remote URLs, missing
    # files). Surfaced on the job so the user knows why a section is plain.
    warnings: List[str] = field(default_factory=list)

    @property
    def narration_chars(self) -> int:
        # Pause markers never reach a TTS request, so they are not narration:
        # counting them would inflate the figure the options dialog shows and
        # push a note over `max_narration_chars` on text nobody will hear.
        return sum(len(strip_pause_markup(s.narration)) for s in self.shots)


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
    if btype in ("videoFile", "video"):
        # "videoFile" is this app's own block (the camera recorder, and a
        # finished article-to-video render inserted back into its note).
        # "video" is BlockNote's own built-in block, which is what a plain
        # drag-and-drop or paste of an .mp4 produces — same `props.url` shape,
        # and just as much a video, so it has to be recognised the same way or
        # it silently isn't a media boundary at all: not skipped with a
        # warning, just invisible to the whole pipeline.
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


# How long a trailing fragment may be and still read as "who said it" rather
# than as more of the sentence. A source is short and usually starts with a name
# or a year; a clause that happens to follow an em dash starts with a function
# word and runs on, so an unnamed fragment is held to a much tighter word count.
_MAX_ATTRIBUTION_CHARS = 60
_MAX_ATTRIBUTION_WORDS = 6
_MAX_UNNAMED_ATTRIBUTION_WORDS = 3


def _split_attribution(text: str) -> Tuple[str, str]:
    """Peel a trailing attribution off a quotation.

    BlockNote has no attribution field on a quote block, so the convention
    writers already use is what gets read: a closing dash. An em dash is also
    ordinary punctuation mid-sentence, so a trailing fragment only counts as an
    attribution when it is short and carries no sentence of its own.
    """
    body = (text or "").strip()
    if not body:
        return "", ""

    lines = [line.strip() for line in body.splitlines() if line.strip()]
    if len(lines) >= 2:
        for marker in ("\u2014", "\u2013", "--", "-"):
            if lines[-1].startswith(marker):
                credit = lines[-1][len(marker):].strip()
                if credit:
                    return "\n".join(lines[:-1]), credit

    for marker in ("\u2014", "\u2013", " -- ", " - "):
        index = body.rfind(marker)
        if index <= 0:
            continue
        credit = body[index + len(marker):].strip()
        quoted = body[:index].strip()
        if not quoted or not credit or len(credit) > _MAX_ATTRIBUTION_CHARS:
            continue
        if any(ch in credit[:-1] for ch in ".!?"):
            continue
        words = len(credit.split())
        named = credit[0].isupper() or credit[0].isdigit()
        if words <= (_MAX_ATTRIBUTION_WORDS if named else _MAX_UNNAMED_ATTRIBUTION_WORDS):
            return quoted, credit.rstrip(".")
    return body, ""


def _set_apart(text: str) -> str:
    """Mark a block as needing a real pause on either side of it.

    Blank lines are the marker, for two reasons: whitespace can never be spoken
    if it somehow reaches a provider, and the narration stays a plain string
    that `narration_chars` and the estimate can still measure. `chunk_narration`
    turns each one into an actual gap in the audio.
    """
    return f"\n{text}\n"


def _block_narration(block: Dict[str, Any], options: RenderOptions) -> str:
    btype = block.get("type")
    if btype in SILENT_TYPES:
        return ""
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
    """Turn note content into shots, by way of a VideoSpec.

    The note is imported as a spec (app/video/importer.py) and compiled back to
    the shots the renderer works from (app/video/compiler.py), so what a render
    does is always something a spec can say. `has_audio` is a callable(path) ->
    bool used to decide whether a video clip carries its own audio track; the
    renderer passes an ffprobe-backed one, and tests pass a stub. When it is
    None every clip is treated as silent.
    """
    # Imported here: the importer is built on this module's helpers.
    from app.video.importer import segment_via_spec

    return segment_via_spec(
        content, user_id=user_id, media_dir=media_dir, options=options,
        note_title=note_title, author=author, has_audio=has_audio,
    )
