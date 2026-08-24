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
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence, Tuple

from app.video import ffmpeg as F
from app.video.options import RenderOptions

logger = logging.getLogger(__name__)

# Comfortably under the backend's 2000-char TTS cap, and the same budget the
# read-aloud player uses client-side, so the two share disk-cache entries.
MAX_CHUNK_CHARS = 1500

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+|\n+")
_WHITESPACE = re.compile(r"[ \t]+")


def chunk_text(text: str, max_chars: int = MAX_CHUNK_CHARS) -> List[str]:
    """Greedily pack sentences into chunks of at most `max_chars`.

    A single over-long sentence is only broken when it exceeds the cap on its
    own, and then on a word boundary — never mid-word, and never mid-sentence
    when the sentence would have fit. Mirrors packChunks() in the frontend's
    useTextToSpeech hook so both sides produce the same cache keys.
    """
    clean = _WHITESPACE.sub(" ", (text or "").strip())
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


@dataclass
class Chunk:
    """One TTS request, and the silence held after it."""

    text: str
    pause_after_ms: int = 0


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
) -> NarrationResult:
    """Synthesise one shot's narration and return its WAV, length and cues.

    `tts` is injected (rather than imported) so this stays testable without a
    network call, and so the caller owns provider selection and usage recording.
    """
    chunks = chunk_narration(
        text,
        paragraph_pause_ms=options.paragraph_pause_ms,
        heading_pause_ms=options.heading_pause_ms,
    )
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
