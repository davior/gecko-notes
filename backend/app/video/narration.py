"""Narration: text -> chunked TTS -> one WAV per shot, plus subtitle cues.

The TTS endpoints cap a request at 2000 characters, so a section of an article
has to be split, synthesised piece by piece and rejoined. Splitting on sentence
boundaries (rather than at a fixed offset) is what keeps the prosody natural,
and knowing each piece's duration is what makes accurate subtitles free.

Joining is done by decoding to PCM rather than concatenating the MP3s: joined
MP3 frames click at the seams and their padding makes the measured duration
drift, and every shot length and subtitle cue is derived from that measurement.
"""

import asyncio
import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from app.video import ffmpeg as F
from app.video import pause_markup
from app.video.options import RenderOptions
from app.video.pause_markup import Chunk

logger = logging.getLogger(__name__)

# Comfortably under the backend's 2000-char TTS cap, and the same budget the
# read-aloud player uses client-side, so the two share disk-cache entries.
MAX_CHUNK_CHARS = 1500

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+|\n+")
_WHITESPACE = re.compile(r"[ \t]+")

# Matches emoji (pictographs, flag letters, misc symbol blocks with emoji
# presentation) plus the zero-width joiner / variation-selector / keycap marks
# used to build compound emoji, so they can be dropped before synthesis —
# otherwise the TTS engine reads them out by description (e.g. "🚗" becomes
# the spoken word "car"). `re` has no \p{Extended_Pictographic}, so the
# ranges are spelled out by hand; mirrors EMOJI_REGEX in the frontend's
# useTextToSpeech hook so a note read aloud there and rendered into a video
# here drop the same characters (and keep sharing chunk_text's cache keys).
_EMOJI = re.compile(
    "["
    "\U0001F1E6-\U0001F1FF"  # regional indicators (flag letters)
    "\U0001F300-\U0001F5FF"  # misc symbols & pictographs (incl. skin-tone modifiers)
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F680-\U0001F6FF"  # transport & map symbols
    "\U0001F700-\U0001F77F"  # alchemical symbols
    "\U0001F780-\U0001F7FF"  # geometric shapes extended
    "\U0001F800-\U0001F8FF"  # supplemental arrows-C
    "\U0001F900-\U0001F9FF"  # supplemental symbols & pictographs
    "\U0001FA00-\U0001FA6F"  # chess symbols
    "\U0001FA70-\U0001FAFF"  # symbols & pictographs extended-A
    "\u2600-\u26FF"  # misc symbols (e.g. sun, heart)
    "\u2700-\u27BF"  # dingbats (e.g. scissors, airplane)
    "\u2300-\u23FF"  # misc technical (e.g. watch, alarm clock)
    "\u2B00-\u2BFF"  # misc symbols & arrows (e.g. star, block)
    "\u200D\uFE0F\u20E3"  # ZWJ, variation selector, keycap combiner
    "]"
)


def strip_emoji(text: str) -> str:
    return _EMOJI.sub("", text)


def chunk_text(text: str, max_chars: int = MAX_CHUNK_CHARS) -> List[str]:
    """Greedily pack sentences into chunks of at most `max_chars`.

    A single over-long sentence is only broken when it exceeds the cap on its
    own, and then on a word boundary — never mid-word, and never mid-sentence
    when the sentence would have fit. Mirrors packChunks() in the frontend's
    useTextToSpeech hook so both sides produce the same cache keys.
    """
    clean = _WHITESPACE.sub(" ", strip_emoji(text or "").strip())
    if not clean:
        return []
    if len(clean) <= max_chars:
        return [clean]

    chunks: List[str] = []
    current = ""
    for piece in _SENTENCE_SPLIT.split(clean):
        piece = piece.strip()
        if not piece:
            continue
        if len(piece) > max_chars:
            if current:
                chunks.append(current.strip())
                current = ""
            rest = piece
            while len(rest) > max_chars:
                cut = rest.rfind(" ", 0, max_chars)
                if cut <= 0:
                    cut = max_chars
                chunks.append(rest[:cut].strip())
                rest = rest[cut:].lstrip()
            current = rest
            continue
        trial = f"{current} {piece}".strip()
        if len(trial) <= max_chars:
            current = trial
        else:
            chunks.append(current.strip())
            current = piece
    if current.strip():
        chunks.append(current.strip())
    return [c for c in chunks if c]


# A blank line marks a break the voice cannot make on its own — see
# segmenter._set_apart. A single newline is an ordinary block join and is left
# to the sentence packer, so marking is opt-in rather than accidental.
_HARD_BREAK = re.compile(r"\n[ \t]*\n+")


def chunk_narration(
    text: str, *, paragraph_pause_ms: int, heading_pause_ms: int,
    max_chars: int = MAX_CHUNK_CHARS,
) -> List[Chunk]:
    """Split a shot's narration into TTS requests and the pauses between them.

    Silence can only be laid between separately synthesised pieces, so a pause
    inside a section means splitting the request there. A whole section is
    normally one chunk, which is exactly why a heading in the middle of it gets
    nothing more than a full stop today.

    Sections split on a blank line and are chunked as before within themselves;
    the gap after a section is the longer heading pause. With that pause turned
    off the marks are ignored entirely, so nothing is split that would otherwise
    have travelled as one request.

    A heading-adjacent chunk therefore stops matching the one the read-aloud
    player would have produced for the same passage, so the two no longer share
    that disk-cache entry. Only passages next to a heading are affected, and the
    chunks a render makes are still cached and reused by later renders.
    """
    body = text or ""
    if heading_pause_ms <= 0:
        packed = chunk_text(body, max_chars)
        return [Chunk(c, 0 if index == len(packed) - 1 else paragraph_pause_ms)
                for index, c in enumerate(packed)]

    sections = [s for s in _HARD_BREAK.split(body) if s.strip()]
    chunks: List[Chunk] = []
    for index, section in enumerate(sections):
        packed = chunk_text(section, max_chars)
        for position, piece in enumerate(packed):
            last_in_section = position == len(packed) - 1
            ends_the_text = last_in_section and index == len(sections) - 1
            if ends_the_text:
                pause = 0
            elif last_in_section:
                pause = heading_pause_ms
            else:
                pause = paragraph_pause_ms
            chunks.append(Chunk(piece, pause))
    return chunks


def build_narration_chunks(text: str, *, options: RenderOptions) -> List[Chunk]:
    """The default split for a shot's narration: heading pauses plus whatever
    pause markup the writer typed into the prose themselves.

    Two independent sources of pauses, combined:

    - `options.heading_pause_ms`, wherever a heading wrapped its section in a
      blank line (see `segmenter._set_apart`) — the coarse, article-structure
      pause `chunk_narration` also makes, driven by the render options rather
      than anything the writer typed.
    - `[pause:...]` markers and an ellipsis ("..." or "…"), via
      `pause_markup.parse_pause_markup` — fine-grained pauses the writer
      places explicitly in the text.

    A bare sentence-ending "." is deliberately not a trigger here, unlike the
    read-aloud player: forcing every sentence into its own TTS request with a
    hard silence after it would cost an ordinary paragraph its natural
    one-breath prosody, which nobody asked for when they typed a normal
    sentence. Only the punctuation someone put there on purpose — an
    ellipsis, an explicit marker, a blank line — becomes a pause.

    Any resulting piece still longer than one TTS request is packed down
    further exactly like `chunk_narration` does, holding
    `options.paragraph_pause_ms` between the pieces that split created.
    """
    pause_ms: Dict[str, int] = {"…": pause_markup.DEFAULT_PAUSE_MS["…"]}
    if options.heading_pause_ms > 0:
        pause_ms["\n\n"] = options.heading_pause_ms

    marked = pause_markup.parse_pause_markup(text, pause_ms=pause_ms)

    chunks: List[Chunk] = []
    for chunk in marked:
        if len(chunk.text) <= MAX_CHUNK_CHARS:
            chunks.append(chunk)
            continue
        pieces = chunk_text(chunk.text, MAX_CHUNK_CHARS)
        for position, piece in enumerate(pieces):
            last = position == len(pieces) - 1
            chunks.append(Chunk(piece, chunk.pause_after_ms if last else options.paragraph_pause_ms))
    return chunks


def stitch_chunks_to_mp3(pieces: Sequence[Tuple[bytes, int]]) -> bytes:
    """Join already-synthesised chunks into one MP3, holding each one's pause.

    The whole-file counterpart to `synthesize_shot`'s concat step, for the
    read-aloud export/insert path. It takes the same route for the same reason:
    decode every piece to a common PCM layout first, because joined MP3 frames
    click at the seams and the concat demuxer silently drops inputs that don't
    match the first one — which is exactly how pauses get quietly eaten.

    `pieces` is `(audio_bytes, pause_after_ms)` in playback order. The last
    piece's pause is ignored: there is nothing after it to separate it from.
    """
    if not pieces:
        return b""

    work_dir = tempfile.mkdtemp(prefix="tts_join_")
    try:
        entries: List[str] = []
        for index, (audio, pause_after_ms) in enumerate(pieces):
            raw_name = f"part_{index:04d}.raw"
            with open(os.path.join(work_dir, raw_name), "wb") as f:
                f.write(audio)
            part_name = f"part_{index:04d}.wav"
            F.run(F.build_decode_command(raw_name, part_name), cwd=work_dir, timeout=120)
            entries.append(part_name)
            if index < len(pieces) - 1:
                pad = build_silence(work_dir, pause_after_ms)
                if pad:
                    entries.append(pad)

        list_name = "join.txt"
        F.write_concat_list(os.path.join(work_dir, list_name), entries)
        out_name = "joined.mp3"
        F.run(F.build_join_mp3_command(list_name, out_name), cwd=work_dir, timeout=600)
        with open(os.path.join(work_dir, out_name), "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


# Two lines of roughly 42 characters is the long-standing broadcast convention
# and about as much as anyone can read before the next cue arrives.
SUBTITLE_MAX_CHARS = 84


def split_for_subtitles(text: str, max_chars: int = SUBTITLE_MAX_CHARS) -> List[str]:
    """Break narration into subtitle-sized lines, preferring sentence ends."""
    clean = _WHITESPACE.sub(" ", (text or "").strip())
    if not clean:
        return []

    lines: List[str] = []
    current = ""
    for sentence in _SENTENCE_SPLIT.split(clean):
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > max_chars:
            if current:
                lines.append(current)
                current = ""
            words = sentence.split()
            for word in words:
                trial = f"{current} {word}".strip()
                if len(trial) <= max_chars:
                    current = trial
                else:
                    if current:
                        lines.append(current)
                    current = word
            continue
        trial = f"{current} {sentence}".strip()
        if len(trial) <= max_chars:
            current = trial
        else:
            if current:
                lines.append(current)
            current = sentence
    if current:
        lines.append(current)
    return lines


@dataclass
class Cue:
    """One subtitle cue, in seconds relative to the start of the video."""

    start: float
    end: float
    text: str


@dataclass
class NarrationResult:
    path: Optional[str]        # WAV for this shot, relative to the work dir
    duration: float
    cues: List[Cue] = field(default_factory=list)   # shot-local timings
    chars: int = 0


def _srt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(path: str, cues: Sequence[Cue]) -> bool:
    """Write cues as SubRip. Returns False when there was nothing to write."""
    usable = [c for c in cues if c.text.strip() and c.end > c.start]
    if not usable:
        return False
    with open(path, "w", encoding="utf-8") as f:
        for index, cue in enumerate(usable, start=1):
            f.write(f"{index}\n{_srt_timestamp(cue.start)} --> {_srt_timestamp(cue.end)}\n")
            f.write(f"{cue.text.strip()}\n\n")
    return True


def shift_cues(cues: Sequence[Cue], offset: float) -> List[Cue]:
    return [Cue(c.start + offset, c.end + offset, c.text) for c in cues]


def build_silence(work_dir: str, milliseconds: int) -> Optional[str]:
    """Render (once per job) the pad inserted between narration chunks."""
    if milliseconds <= 0:
        return None
    name = f"silence_{milliseconds}.wav"
    path = os.path.join(work_dir, name)
    if not os.path.isfile(path):
        F.run(F.build_silence_command(name, milliseconds / 1000.0), cwd=work_dir, timeout=60)
    return name


def synthesize_shot(
    text: str,
    *,
    index: int,
    work_dir: str,
    options: RenderOptions,
    tts: Callable[[str], bytes],
    chunks: Optional[List[Chunk]] = None,
) -> NarrationResult:
    """Synthesise one shot's narration and return its WAV, length and cues.

    `tts` is injected (rather than imported) so this stays testable without a
    network call, and so the caller owns provider selection and usage recording.

    `chunks` lets a caller supply its own text/pause split instead of the
    default — heading pauses plus the pause markup in the prose itself, see
    `build_narration_chunks`.
    """
    chunks = chunks if chunks is not None else build_narration_chunks(text, options=options)
    if not chunks:
        # A shot with no text still needs an audio track — the concat demuxer
        # requires every part to have the same stream layout — so it gets
        # silence at the shot's minimum length.
        name = f"narration_{index:04d}.wav"
        F.run(F.build_silence_command(name, options.min_shot_seconds), cwd=work_dir, timeout=60)
        return NarrationResult(path=name, duration=options.min_shot_seconds, cues=[], chars=0)

    parts: List[str] = []
    scratch: List[str] = []
    for position, chunk in enumerate(chunks):
        audio = tts(chunk.text)
        raw_name = f"chunk_{index:04d}_{position:03d}.raw"
        with open(os.path.join(work_dir, raw_name), "wb") as f:
            f.write(audio)
        scratch.append(raw_name)
        # Decode to a common format before joining. Providers return MP3 at
        # whatever rate they like, and the concat demuxer silently drops inputs
        # that don't match the first one — which quietly ate the pauses.
        part_name = f"chunk_{index:04d}_{position:03d}.wav"
        F.run(F.build_decode_command(raw_name, part_name), cwd=work_dir, timeout=120)
        parts.append(part_name)
        scratch.append(part_name)

    # Measure each chunk before joining: after the join the boundaries are gone,
    # and these are what the subtitle cues are built from.
    raw_durations = [F.probe_duration(os.path.join(work_dir, p)) for p in parts]

    entries: List[str] = []
    for position, part in enumerate(parts):
        entries.append(part)
        if position >= len(parts) - 1:
            continue
        # Each gap is the one its own chunk asked for, so a heading break is
        # audibly longer than the join between two halves of a paragraph.
        pad = build_silence(work_dir, chunks[position].pause_after_ms)
        if pad:
            entries.append(pad)

    # Held after the shot's very last word, before the cut to whatever comes
    # next. Without this the shot's audio — and so the shot itself, since its
    # length is measured from this file — ends the instant speech does, often
    # mid-decay on a voice's own trailing intonation; the cut then lands right
    # on top of it and reads as the sentence getting clipped rather than
    # finishing. paragraph_pause_ms and heading_pause_ms only ever sit
    # *between* two chunks above, which is why this needs its own entry here.
    end_pad = build_silence(work_dir, options.shot_end_pause_ms)
    if end_pad:
        entries.append(end_pad)

    list_name = f"narration_{index:04d}.txt"
    F.write_concat_list(os.path.join(work_dir, list_name), entries)

    out_name = f"narration_{index:04d}.wav"
    F.run(
        F.build_narration_command(
            list_name, out_name, speed=options.speed, min_seconds=options.min_shot_seconds,
        ),
        cwd=work_dir, timeout=600,
    )
    duration = F.probe_duration(os.path.join(work_dir, out_name)) or sum(raw_durations)

    # Lay the cues out on the same timeline the join produced: chunk lengths and
    # pauses scaled by the speed change, so they stay aligned end to end. A TTS
    # chunk is far too long to show as one subtitle, so each is split into
    # readable lines and given a proportional slice of its measured duration.
    speed = max(0.25, options.speed)
    cues: List[Cue] = []
    cursor = 0.0
    for position, chunk in enumerate(chunks):
        length = raw_durations[position] / speed if raw_durations[position] else 0.0
        if length <= 0:
            # Fall back to a reading-rate estimate rather than emitting a zero
            # cue, which would be dropped and lose the line entirely.
            length = max(0.6, len(chunk.text) / 15.0 / speed)
        lines = split_for_subtitles(chunk.text)
        total = sum(len(l) for l in lines) or 1
        for line in lines:
            span = length * len(line) / total
            cues.append(Cue(cursor, cursor + span, line))
            cursor += span
        if position < len(chunks) - 1:
            cursor += chunk.pause_after_ms / 1000.0 / speed

    for name in scratch:
        try:
            os.remove(os.path.join(work_dir, name))
        except OSError:
            pass

    return NarrationResult(path=out_name, duration=duration, cues=cues,
                           chars=sum(len(c.text) for c in chunks))
