"""Configurable pause insertion for spoken-word narration.

Deepgram (Flux, used by `_deepgram_tts` in `app/routers/settings.py`, and
Aura-2, the other TTS family this app can call) has no SSML support at all —
`<break>`/`<prosody>` tags would just be read aloud or rejected, not honoured.
So pauses here are made real the same way `chunk_narration` already does it:
by splitting narration into separate TTS requests (`Chunk`) and letting the
caller stitch real silence between them (`build_silence` + the concat step in
`synthesize_shot`), rather than by emitting markup.

`parse_pause_markup` turns punctuation, blank lines, and explicit
`[pause:...]` markers in the source prose into a `List[Chunk]`. The prose
itself is left untouched other than removing the markers.
"""

import re
from dataclasses import dataclass
from typing import Dict, List


@dataclass
class Chunk:
    """One TTS request, and the silence held after it."""

    text: str
    pause_after_ms: int = 0


# Implicit pause after each trigger, in milliseconds. `\n\n` is the pause for
# *one* blank line; each additional blank line multiplies it (see
# `parse_pause_markup`), so paragraph breaks with more blank lines pause
# longer. Single source of truth — no duration is hardcoded elsewhere.
#
# A trigger absent from the `pause_ms` a caller passes in is not merely a
# zero-length pause — it isn't a boundary at all, so the text around it is
# never split. That's what lets a caller opt a plain sentence-ending "."
# out of becoming a TTS-request boundary (see `narration.build_narration_chunks`)
# while still honouring "…"/"..." and "[pause:...]", rather than forcing
# every sentence into its own request with a 0ms gap, which would cost
# ordinary prose its natural one-breath prosody.
DEFAULT_PAUSE_MS: Dict[str, int] = {".": 900, "…": 1300, "\n\n": 1600}

# Named levels for the `[pause:short|medium|long|xlong]` marker.
NAMED_PAUSE_MS: Dict[str, int] = {"short": 350, "medium": 750, "long": 1200, "xlong": 2000}

# Deepgram Flux's `speed` query param (see `DEEPGRAM_TTS_SPEED_MIN/MAX` in
# `app/routers/settings.py`, range 0.85-1.15) is the real, working equivalent
# of the SSML `<prosody rate='0.88'>` wrap this feature was originally
# specified with. Not applied automatically here — this module has no network
# dependency — a caller synthesising pause-markup narration should pass this
# as `speed` to `_deepgram_tts`/`synthesize_tts_bytes`.
DEFAULT_NARRATION_SPEED = 0.88

_MARKER = r"\[pause:(?P<mval>[A-Za-z]+|\d+)\]"
_PARA_BREAK = r"\n[ \t]*\n+"
_TRIGGER = r"\.\.\.|…|\."
_EVENT = re.compile(f"(?:{_MARKER})|(?P<para>{_PARA_BREAK})|(?P<trig>{_TRIGGER})")
_LOOKAHEAD_MARKER = re.compile(rf"[ \t]*{_MARKER}")


def _resolve_marker(value: str, named_pause_ms: Dict[str, int]) -> int:
    if value.isdigit():
        return int(value)
    return named_pause_ms[value.lower()]


def parse_pause_markup(
    text: str,
    *,
    pause_ms: Dict[str, int] = DEFAULT_PAUSE_MS,
    named_pause_ms: Dict[str, int] = NAMED_PAUSE_MS,
) -> List[Chunk]:
    """Split narration into `Chunk`s at sentence/paragraph/marker boundaries.

    Implicit pauses come from `pause_ms` — `.`/`...`/`…` end a sentence,
    `\\n\\n` (a blank line) ends a paragraph, with each additional blank line
    multiplying that pause. Explicit `[pause:1200]` / `[pause:LEVEL]` markers
    are always stripped from the output text; one directly following (only
    whitespace between) an implicit trigger overrides that trigger's pause
    instead of adding to it — e.g. a period immediately followed by
    `[pause:xlong]` produces one 2000ms gap, not 900 + 2000. A marker
    anywhere else just becomes its own chunk boundary.

    A trigger missing from `pause_ms` entirely is not a boundary at all —
    the text around it just runs on into whatever comes next, as if that
    trigger didn't exist — rather than a boundary with a 0ms gap. That's the
    difference between "pause here for no time" (still a new TTS request,
    still a seam in the prosody) and "don't split here", and it's what lets
    a caller opt the bare "." out without forcing every sentence into its
    own request. An explicit `[pause:...]` marker immediately following a
    disabled trigger still overrides it, same as with an enabled one.

    Two boundaries with no words between them (e.g. a sentence-ending period
    immediately followed by a blank line) don't produce an empty chunk — the
    longer of the two pauses is kept on the previous chunk instead.

    The final chunk always carries `pause_after_ms == 0`; the shot's trailing
    pause is a separate, caller-level concern (e.g.
    `RenderOptions.shot_end_pause_ms`).
    """
    body = text or ""
    chunks: List[Chunk] = []
    current: List[str] = []

    def emit(ms: int) -> None:
        nonlocal current
        segment = "".join(current).strip()
        current = []
        if segment:
            chunks.append(Chunk(segment, ms))
        elif chunks:
            chunks[-1] = Chunk(chunks[-1].text, max(chunks[-1].pause_after_ms, ms))
        # A pause before any spoken text has nothing to attach to — dropped.

    pos = 0
    for m in _EVENT.finditer(body):
        if m.start() < pos:
            continue  # already consumed as an override lookahead below
        gap = body[pos:m.start()]
        mval = m.group("mval")

        if mval is not None:
            current.append(gap)
            pos = m.end()
            emit(_resolve_marker(mval, named_pause_ms))
            continue

        current.append(gap)
        is_para = bool(m.group("para"))
        if is_para:
            blank_lines = m.group("para").count("\n") - 1
            base = pause_ms.get("\n\n")
            ms = None if base is None else base * max(1, blank_lines)
        else:
            trig_text = m.group("trig")
            key = "." if trig_text == "." else "…"
            current.append(trig_text)
            ms = pause_ms.get(key)
        pos = m.end()

        override = _LOOKAHEAD_MARKER.match(body, pos)
        if override:
            ms = _resolve_marker(override.group("mval"), named_pause_ms)
            pos = override.end()

        if ms is not None:
            emit(ms)
        elif is_para:
            # A blank line that isn't a pause boundary is still whitespace
            # between two words — drop it entirely (as opposed to a period,
            # which keeps its own character either way) and "text.\n\nHeading"
            # glues into "text.Heading" with no space at all.
            current.append(" ")

    current.append(body[pos:])
    tail = "".join(current).strip()
    if tail:
        chunks.append(Chunk(tail, 0))
    elif chunks:
        chunks[-1] = Chunk(chunks[-1].text, 0)

    return chunks
