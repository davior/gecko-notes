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

The marker grammar is deliberately forgiving. Anything it fails to recognise
is not silently ignored — it is *spoken*, because the literal text travels on
to the TTS engine — so `[Pause: 2s]` missing by a capital letter and a space
is far worse than a marker that never existed. Separator, spacing, case, unit
and even the value itself are all optional; see `_MARKER`.
"""

import re
from dataclasses import dataclass
from typing import Dict, List, Optional


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
#
# These are *added* silence, on top of the gap a chunk boundary already
# creates: every chunk is its own TTS request, so its audio arrives with the
# engine's own trailing fall and leading lead-in, and the player needs a moment
# to swap clips (the export stitches the same silence in with ffmpeg, so both
# sides hear the same thing). Read the numbers as "how much longer than an
# ordinary sentence break", not as the length of the gap a listener hears.
#
# Hence the ordinary "." is small. It is the one trigger nobody opts into —
# every sentence in every note ends with one — so it has to sound like prose,
# not like a beat. It sits below even `NAMED_PAUSE_MS["short"]`, so a writer
# who actually types `[pause:short]` still gets something audibly longer than
# the full stop they'd have got for free. The deliberate marks — an ellipsis, a
# blank line — are where the long pauses belong.
DEFAULT_PAUSE_MS: Dict[str, int] = {".": 250, "…": 1300, "\n\n": 1600}

# Named levels for the `[pause:short|medium|long|xlong]` marker.
NAMED_PAUSE_MS: Dict[str, int] = {"short": 350, "medium": 750, "long": 1200, "xlong": 2000}

# What a marker means when it names no duration (`[pause]`) or names one that
# isn't in `named_pause_ms` (`[pause:xxlong]`). An unrecognised level resolves
# here rather than raising: a typo in a note must not take down a render
# worker halfway through a job.
DEFAULT_MARKER_MS = NAMED_PAUSE_MS["medium"]

# Ceiling on one explicit marker. A bare number is milliseconds, so somebody
# reaching for seconds and writing `[pause:120000]` would otherwise wedge two
# minutes of silence into the middle of a render.
MAX_PAUSE_MS = 10_000

# Deepgram Flux's `speed` query param (see `DEEPGRAM_TTS_SPEED_MIN/MAX` in
# `app/routers/settings.py`, range 0.85-1.15) is the real, working equivalent
# of the SSML `<prosody rate='0.88'>` wrap this feature was originally
# specified with. Not applied automatically here — this module has no network
# dependency — a caller synthesising pause-markup narration should pass this
# as `speed` to `_deepgram_tts`/`synthesize_tts_bytes`.
DEFAULT_NARRATION_SPEED = 0.88

# `[pause]`, `[pause:long]`, `[Pause: 2s]`, `[PAUSE 1500]`, `[pause=400ms]` —
# the separator, the value and the unit are each optional, and the whole thing
# is matched case-insensitively (see `_EVENT`). Only spaces and tabs are
# allowed inside, never a newline: a marker must not be able to swallow the
# blank line that a paragraph break is made of.
_MARKER = (
    r"(?P<marker>\[[ \t]*pause[ \t]*"
    r"(?:(?:[:=][ \t]*|[ \t]+)(?P<mval>[A-Za-z]+|\d+(?:\.\d+)?)[ \t]*"
    r"(?P<munit>ms|seconds|second|secs|sec|s)?[ \t]*)?"
    r"\])"
)
_PARA_BREAK = r"\n[ \t]*\n+"
# Quote and bracket characters that close a sentence *after* its full stop.
# Both triggers below swallow them so `He said "go." Then left.` keeps the
# closing quote on the chunk it belongs to instead of opening the next one.
_CLOSERS = r"[\"'’”)\]]*"
# Two or more periods, however they're spaced, are one ellipsis. Matching them
# as a single event is what stops "Wait...." leaving a stray "." to open the
# next chunk — which the TTS engine then reads aloud as its own utterance.
_ELLIPSIS = rf"(?:\.(?:[ \t]*\.)+|…){_CLOSERS}"
# A lone period. Never inside a number ("3.5", "$1,200.50"); `_ends_a_sentence`
# rules out the rest.
_SENTENCE_END = rf"(?<!\d)\.(?!\d){_CLOSERS}"

_EVENT = re.compile(
    f"(?:{_MARKER})|(?P<para>{_PARA_BREAK})"
    f"|(?P<ell>{_ELLIPSIS})|(?P<dot>{_SENTENCE_END})",
    re.IGNORECASE,
)
_LOOKAHEAD_MARKER = re.compile(rf"[ \t]*{_MARKER}", re.IGNORECASE)
_MARKER_ONLY = re.compile(_MARKER, re.IGNORECASE)

# A voice can say letters and digits; punctuation, symbols and emoji on their
# own are not speech. `[^\W_]` excludes emoji naturally — they are
# symbol-category, not word characters — while keeping accented, Greek and CJK
# text speakable.
_SPEAKABLE = re.compile(r"[^\W_]", re.UNICODE)


def has_speech(text: str) -> bool:
    """Is there anything here a TTS engine could actually pronounce?

    A chunk of pure punctuation is not a smaller request, it is a broken one:
    the provider has nothing to synthesise and answers with an empty or
    non-audio body, which then reaches ffmpeg as an undecodable file and fails
    the whole render with a message about pixel formats. So a beat written as
    "...", a "---" separator, or a paragraph holding nothing but an emoji must
    never become a request of its own.
    """
    return bool(_SPEAKABLE.search(text or ""))


# Words that end in a period without ending a sentence. Lowercased for lookup.
_ABBREVIATIONS = frozenset({
    "dr", "mr", "mrs", "ms", "prof", "rev", "sr", "jr", "st", "mt", "ft",
    "vs", "etc", "al", "cf", "approx", "est", "dept", "no", "fig", "vol",
    "ch", "pp", "inc", "ltd", "co", "corp", "univ",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
    "nov", "dec",
    "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
})

# Longest abbreviation above, plus room for the word to start mid-slice.
_ABBREV_WINDOW = 32
_WORD_BEFORE = re.compile(r"([A-Za-z]+)$")
_AFTER_DOT = re.compile(r"\s|$")


def _ends_a_sentence(body: str, start: int, end: int) -> bool:
    """Is the "." at `body[start:end]` a sentence end, or part of a word?

    A period only ends a sentence when what follows it (past any closing quote
    or bracket, which `_SENTENCE_END` has already consumed) is whitespace or the
    end of the text, and what precedes it is neither a single letter — an initial, or one leg of "e.g."/"U.S." — nor a
    known abbreviation. Without this the read-aloud player pauses inside "3.5",
    after "Dr", and three separate times inside "www.example.com".
    """
    if not _AFTER_DOT.match(body, end):
        return False
    word = _WORD_BEFORE.search(body[max(0, start - _ABBREV_WINDOW):start])
    if word is None:
        return True
    token = word.group(1)
    return len(token) > 1 and token.lower() not in _ABBREVIATIONS


def _resolve_marker(
    value: Optional[str], unit: Optional[str], named_pause_ms: Dict[str, int],
) -> int:
    """Resolve one `[pause:...]` marker to milliseconds.

    A bare number is milliseconds — `[pause:1500]` is a second and a half — and
    an `s`/`sec`/`second` suffix opts into seconds instead. A bare *decimal* is
    read as seconds as well: `[pause:1.5]` can only have meant 1.5 seconds,
    since a millisecond and a half is far below anything a listener could hear.

    A marker with no value at all, or with a level this caller doesn't define,
    falls back to `DEFAULT_MARKER_MS` rather than raising — see that constant.
    """
    if value is None:
        return DEFAULT_MARKER_MS
    if not value[0].isdigit():
        return named_pause_ms.get(value.lower(), DEFAULT_MARKER_MS)

    amount = float(value)
    suffix = (unit or "").lower()
    if suffix == "ms":
        milliseconds = amount
    elif suffix or "." in value:
        milliseconds = amount * 1000
    else:
        milliseconds = amount
    return max(0, min(MAX_PAUSE_MS, int(round(milliseconds))))


def strip_pause_markup(text: str) -> str:
    """Remove `[pause:...]` markers from text that is *drawn* rather than spoken.

    `parse_pause_markup` already strips them out of narration, but a heading and
    a quote are also rendered to the screen — see `segmenter`'s `card_title` and
    `quote_text` — and those paths never went through the parser, so a marker
    typed into a heading was drawn onto the video.
    """
    if not text:
        return text
    cleaned = _MARKER_ONLY.sub("", text)
    # Close up the gap a mid-line marker leaves behind, without touching
    # newlines: a card's line breaks are laid out on purpose.
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return "\n".join(line.strip() for line in cleaned.split("\n")).strip()


def parse_pause_markup(
    text: str,
    *,
    pause_ms: Dict[str, int] = DEFAULT_PAUSE_MS,
    named_pause_ms: Dict[str, int] = NAMED_PAUSE_MS,
) -> List[Chunk]:
    """Split narration into `Chunk`s at sentence/paragraph/marker boundaries.

    Implicit pauses come from `pause_ms` — `.`/`...`/`…` end a sentence,
    `\\n\\n` (a blank line) ends a paragraph, with each additional blank line
    multiplying that pause. Explicit `[pause:1500]` / `[pause:LEVEL]` markers
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

    A period that doesn't actually end a sentence — inside a decimal, an
    initial, or an abbreviation — is never a boundary regardless of
    `pause_ms`; see `_ends_a_sentence`.

    Two boundaries with no words between them (e.g. a sentence-ending period
    immediately followed by a blank line) don't produce an empty chunk — the
    longer of the two pauses is kept on the previous chunk instead. The same
    holds for anything between them that isn't speech: a "..." beat on its own
    line, a "---" rule, a lone emoji. Those mark a pause without being one, so
    the pause survives on the previous chunk and no chunk is emitted for them —
    see `has_speech`, and never remove that guard: a wordless TTS request comes
    back as a non-audio body and fails the render at the ffmpeg decode.

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
        if has_speech(segment):
            chunks.append(Chunk(segment, ms))
        elif chunks:
            # Nothing sayable between this boundary and the last one — a beat
            # written as "..." on its own line, a "---" rule, a lone emoji.
            # It still marks a pause, so the pause is kept on the chunk before
            # it; what must not happen is a TTS request with no words in it.
            chunks[-1] = Chunk(chunks[-1].text, max(chunks[-1].pause_after_ms, ms))
        # A pause before any spoken text has nothing to attach to — dropped.

    pos = 0
    for m in _EVENT.finditer(body):
        if m.start() < pos:
            continue  # already consumed as an override lookahead below
        # A period mid-word isn't a boundary at all: leave it where it is and
        # let the next event's `gap` carry it into the chunk being built.
        if m.group("dot") is not None and not _ends_a_sentence(body, m.start(), m.end()):
            continue

        gap = body[pos:m.start()]

        if m.group("marker") is not None:
            current.append(gap)
            pos = m.end()
            emit(_resolve_marker(m.group("mval"), m.group("munit"), named_pause_ms))
            continue

        current.append(gap)
        para = m.group("para")
        is_para = para is not None
        if is_para:
            blank_lines = para.count("\n") - 1
            base = pause_ms.get("\n\n")
            ms = None if base is None else base * max(1, blank_lines)
        else:
            ellipsis = m.group("ell")
            current.append(ellipsis if ellipsis is not None else m.group("dot"))
            ms = pause_ms.get("…" if ellipsis is not None else ".")
        pos = m.end()

        override = _LOOKAHEAD_MARKER.match(body, pos)
        if override:
            ms = _resolve_marker(
                override.group("mval"), override.group("munit"), named_pause_ms,
            )
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
    if has_speech(tail):
        chunks.append(Chunk(tail, 0))
    elif chunks:
        chunks[-1] = Chunk(chunks[-1].text, 0)

    return chunks
