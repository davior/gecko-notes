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
    # segment()'s codeBlock branch.
    code_text: Optional[str] = None
    # Set on the second half of a sounded-clip pair, purely for readable logs.
    label: str = ""

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
            card_kind="title",
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
                        #
                        # The section after the card resumes on the same picture
                        # — cutting to the plain fallback for one screen and back
                        # again would read as a mistake, the same reasoning the
                        # quote handler below uses. A card interrupting a sounded
                        # clip resumes muted, matching how the clip is carried
                        # elsewhere; only a genuinely new image or video changes
                        # the background from here.
                        carry_kind: ShotKind = (
                            "video_muted"
                            if open_shot is not None and open_shot.kind.startswith("video")
                            else "still"
                        )
                        carry_background = open_shot.background if open_shot is not None else None
                        flush(Shot(kind=carry_kind, background=carry_background,
                                   label="after chapter card"))
                        # The card reads its own heading. Letting the heading fall
                        # through to the next section instead would show it in
                        # silence and then speak it over the following shot, once
                        # the words were no longer on screen.
                        pending_card = Shot(
                            kind="card", card_title=heading, chapter=heading,
                            card_kind="chapter", narration=_as_sentence(heading),
                            label="chapter card",
                        )
                        # The card carries the chapter mark, so the section after
                        # it must not claim the same one and duplicate the entry.
                        pending_chapter = None
                        continue
                    # Without a chapter screen the heading is read inside the
                    # section it introduces, so that shot carries the mark.
                    if pending_chapter is None:
                        pending_chapter = heading

            if btype == "quote" and options.quotes.enabled:
                quoted = _split_attribution(_inline_text(block.get("content")))
                if quoted[0]:
                    # A quote gets its own screen time so the words can be on
                    # screen while they are read, but it keeps the background of
                    # the section it interrupts — cutting to a different picture
                    # for one sentence would read as a mistake. A sounded clip is
                    # carried muted, or it would replay its audio underneath.
                    carry_kind: ShotKind = (
                        "video_muted"
                        if open_shot is not None and open_shot.kind.startswith("video")
                        else "still"
                    )
                    carry_background = open_shot.background if open_shot is not None else None
                    quote_shot = Shot(
                        kind=carry_kind, background=carry_background,
                        quote_text=quoted[0], quote_attribution=quoted[1] or None,
                        label="quote",
                    )
                    if (any(t.strip() for t in pending_text)
                            or pending_chapter is not None or pending_card is not None):
                        flush(quote_shot)
                    else:
                        # The open shot has nothing of its own to say, so the
                        # quote takes it over rather than being preceded by a
                        # blank copy of itself held for min_shot_seconds.
                        open_shot = quote_shot
                    # Closing the quote's own shot immediately is what keeps the
                    # quotation as its narration rather than whatever follows it.
                    pending_text.append(_as_sentence(quoted[0]))
                    flush(Shot(kind=carry_kind, background=carry_background,
                               label="after quote"))
                    continue

            if btype == "codeBlock":
                code = _inline_text(block.get("content"))
                if code.strip():
                    # A code block gets its own screen time the same way a
                    # quote does — its own shot, over whatever background the
                    # section it interrupts was already showing — but unlike a
                    # quote it is drawn unconditionally: only whether it is
                    # *narrated* depends on narrate_code, not whether it shows
                    # up at all.
                    carry_kind: ShotKind = (
                        "video_muted"
                        if open_shot is not None and open_shot.kind.startswith("video")
                        else "still"
                    )
                    carry_background = open_shot.background if open_shot is not None else None
                    code_shot = Shot(
                        kind=carry_kind, background=carry_background,
                        code_text=code, label="code",
                    )
                    if (any(t.strip() for t in pending_text)
                            or pending_chapter is not None or pending_card is not None):
                        flush(code_shot)
                    else:
                        open_shot = code_shot
                    if options.narrate_code:
                        pending_text.append(_as_sentence(code))
                    flush(Shot(kind=carry_kind, background=carry_background,
                               label="after code"))
                continue

            text = _block_narration(block, options)
            if text.strip():
                spoken = _as_sentence(text)
                # A heading is a section boundary, not another sentence of the
                # paragraph above it, so it gets a pause on both sides. A card
                # already has the boundary of its own shot and needs no marking.
                if btype == "heading" and options.heading_pause_ms > 0:
                    spoken = _set_apart(spoken)
                pending_text.append(spoken)
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
    # So is a silent code block (narrate_code off, nothing narrated yet) — it
    # still has its panel to show, even with no background of its own.
    result.shots = [
        s for s in result.shots
        if s.kind != "still" or s.background is not None or s.narration.strip() or s.code_text
    ]

    # The section reopened after a quote or a code block is a continuation,
    # not a shot of its own: when nothing followed it, it would replay the
    # same background in silence, so drop it.
    trimmed: List[Shot] = []
    for shot in result.shots:
        previous = trimmed[-1] if trimmed else None
        if (previous is not None and (previous.quote_text is not None or previous.code_text is not None)
                and shot.quote_text is None and shot.code_text is None
                and not shot.narration.strip()
                and shot.chapter is None
                and shot.kind == previous.kind
                and shot.background == previous.background):
            continue
        trimmed.append(shot)
    result.shots = trimmed
    return result
