"""The segmenter's walk as it was before it went through a VideoSpec — kept as
the oracle the spec path is held to.

`segment()` now imports a note as a VideoSpec and compiles it back to shots
(app/video/importer.py, app/video/compiler.py). This is the original, verbatim
but for the chapter-mark fixes (docs/gecko-video-creator.md §3.2 and open
decision 15, each marked "Fixed:" below), so test_video_spec.py can keep proving that the spec path
changes nothing else: every segmenter case, a generated corpus and real
renders must come out identical. A deliberate behaviour change lands here too,
written independently of the importer, or this is retired.
"""

import json
from typing import Any, List, Optional

from app.video.options import RenderOptions
from app.video.pause_markup import strip_pause_markup
from app.video.segmenter import (
    Segmentation, Shot, ShotKind, _as_sentence, _block_narration, _classify, _flatten,
    _inline_text, _media_kind, _media_url, _set_apart, _split_attribution,
    resolve_media_path,
)


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
    # Fixed: a heading after something was said splits the section there, so
    # its mark is where it stands: (lines before it, its mark) for each.
    splits: List[tuple] = []
    # Whether anything but a heading was said since the section began or the
    # last split — if not, a heading now is the same moment as the last one.
    said_plain = False
    pending_card: Optional[Shot] = None

    def flush(next_shot: Optional[Shot]) -> Optional[str]:
        """Close the open shot with whatever narration has accumulated.

        Fixed: returns the chapter mark it would have handed to `next_shot`
        when there is none, rather than dropping it."""
        nonlocal pending_text, open_shot, pending_chapter, pending_card, splits, said_plain
        text = "\n".join(t for t in pending_text if t).strip()

        if open_shot is None and text:
            # Text before the first media block: give it the fallback background.
            open_shot = Shot(kind="still", background=None, label="opening")
        # Fixed: a last split with only headings after it has nothing to show
        # under its mark; that heading stays here and marks the next shot.
        late_mark = splits.pop()[1] if splits and not said_plain else None
        if open_shot is not None:
            ends = [at for at, _ in splits] + [len(pending_text)]
            open_shot.narration = "\n".join(t for t in pending_text[:ends[0]] if t).strip()
            if pending_chapter and not open_shot.chapter:
                open_shot.chapter = pending_chapter
                pending_chapter = None
            elif pending_chapter and not pending_text:
                # Fixed: the shot already has its mark, so this one used to be
                # dropped. Unread, with nothing said under it, the heading sits
                # where the next shot starts: that shot gets it, below.
                pass
            else:
                pending_chapter = None
            if pending_card is not None:
                result.shots.append(pending_card)
                pending_card = None
            result.shots.append(open_shot)
            carry_kind: ShotKind = "video_muted" if open_shot.kind.startswith("video") else "still"
            for (at, mark), end in zip(splits, ends[1:]):
                result.shots.append(Shot(
                    kind=carry_kind, background=open_shot.background,
                    narration="\n".join(t for t in pending_text[at:end] if t).strip(),
                    chapter=mark, label="after heading", cut_in=True,
                ))
        elif pending_card is not None:
            result.shots.append(pending_card)
            pending_card = None

        # A heading with nothing spoken under it (read_chapters off) has no shot
        # to hang its mark on; hand it to the shot that starts here instead.
        carried_chapter = pending_chapter or late_mark
        pending_text = []
        pending_chapter = None
        splits = []
        said_plain = False
        open_shot = next_shot
        if carried_chapter and open_shot is None:
            return carried_chapter
        if carried_chapter and not open_shot.chapter:
            open_shot.chapter = carried_chapter
        return None

    for block in _flatten(blocks):
        kind = _classify(block, options)

        if kind is None:
            btype = block.get("type")
            if btype == "heading":
                # Fixed: the chapter list and the card show the heading without
                # its [pause:…] markers, and one that is only markers is no chapter.
                heading = _inline_text(block.get("content")).strip()
                mark = strip_pause_markup(heading)
                if mark:
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
                            kind="card", card_title=mark, chapter=mark,
                            card_kind="chapter",
                            narration=_as_sentence(heading) if options.read_chapters else "",
                            label="chapter card",
                        )
                        # The card carries the chapter mark, so the section after
                        # it must not claim the same one and duplicate the entry.
                        pending_chapter = None
                        continue
                    # Without a chapter screen the heading is read inside the
                    # section it introduces, so that shot carries the mark.
                    if said_plain:
                        # Fixed: partway through the section, where this used
                        # to mark its start or nothing at all.
                        splits.append((len(pending_text), mark))
                        said_plain = False
                    elif pending_chapter is None and not splits:
                        pending_chapter = mark

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
                        # Fixed: and the chapter it was to start, too.
                        if open_shot is not None and not quote_shot.chapter:
                            quote_shot.chapter = open_shot.chapter
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
                        if open_shot is not None and not code_shot.chapter:
                            code_shot.chapter = open_shot.chapter  # Fixed, as for a quote.
                        open_shot = code_shot
                    if options.narrate_code:
                        pending_text.append(_as_sentence(code))
                    flush(Shot(kind=carry_kind, background=carry_background,
                               label="after code"))
                continue

            if btype == "heading" and not options.read_chapters:
                # The chapter mark was taken above; the words are just not read.
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
                said_plain = said_plain or btype != "heading"
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
            # Fixed: a chapter mark with no shot before the clip starts the clip.
            unplaced = flush(None)
            result.shots.append(Shot(kind="video_sound", background=path, chapter=unplaced,
                                     label="clip with audio"))
            open_shot = Shot(kind="video_muted", background=path, label="clip continued, muted")
        else:
            flush(Shot(kind="video_muted", background=path))

    flush(None)

    # Drop a trailing shot that ended up with nothing to show or say. A media
    # shot with no narration is kept — it still displays for min_shot_seconds.
    # So is a silent code block (narrate_code off, nothing narrated yet) — it
    # still has its panel to show, even with no background of its own.
    # Fixed: a chapter mark on a dropped shot starts the next one kept instead.
    # Its heading came first, so it wins over a mark that shot has of its own,
    # as the first of two headings in a row does.
    kept: List[Shot] = []
    unplaced: Optional[str] = None
    for s in result.shots:
        if s.kind != "still" or s.background is not None or s.narration.strip() or s.code_text:
            if unplaced:
                s.chapter = unplaced
            unplaced = None
            kept.append(s)
        elif unplaced is None:
            unplaced = s.chapter
    result.shots = kept

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

    # The intro and outro bracket the article rather than stand in for it, so a
    # note with nothing of its own to show still renders nothing.
    if result.shots:
        intro = _bumper_shot("intro", options, user_id, media_dir, result.warnings)
        outro = _bumper_shot("outro", options, user_id, media_dir, result.warnings)
        if intro is not None:
            result.shots.insert(0, intro)
        if outro is not None:
            result.shots.append(outro)
    return result


def _bumper_shot(
    which: str, options: RenderOptions, user_id: str, media_dir: str, warnings: List[str],
) -> Optional[Shot]:
    """The intro or outro clip as a shot, or None when it is off or unusable.

    It is a sounded clip like any other in a note: played whole, with its own
    audio when it has some and silence when it doesn't, which the renderer
    probes for itself.
    """
    spec = options.intro if which == "intro" else options.outro
    if not spec.enabled or not spec.url:
        return None
    path = resolve_media_path(spec.url, user_id, media_dir)
    if path is None or _media_kind(spec.url) != "video":
        warnings.append(f"The {which} was skipped: that clip could not be read.")
        return None
    return Shot(
        kind="video_sound", background=path,
        chapter=which.capitalize(), bumper=which, label=which,
    )
