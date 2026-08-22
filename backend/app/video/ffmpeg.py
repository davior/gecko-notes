"""ffmpeg/ffprobe argv builders and process helpers.

Every builder is a pure function returning a `list[str]`, so the filtergraphs can
be asserted in unit tests without running ffmpeg — the same approach the repo
already takes for the URL importer's parsers.

The one invariant the whole pipeline rests on: every shot is encoded with
byte-identical codec parameters (see `encode_args`), which is what lets the final
stitch be a `concat -c copy` remux instead of a second full encode. A stray SAR
or pixel format is the usual way that silently breaks, so every video chain ends
with `setsar=1,format=yuv420p`.
"""

import logging
import os
import shutil
import subprocess
from typing import Dict, List, Optional, Sequence, Tuple

from app.video.options import RenderOptions, encoder_tier, frame_size

logger = logging.getLogger(__name__)

# Long enough for a 4K encode of a multi-minute clip, short enough that a wedged
# process can't hold the render queue forever. Mirrors transcription.py's style.
SHOT_TIMEOUT_SECONDS = 900
PROBE_TIMEOUT_SECONDS = 30


class FFmpegError(RuntimeError):
    pass


def ffmpeg_available() -> bool:
    return bool(shutil.which("ffmpeg")) and bool(shutil.which("ffprobe"))


_filter_cache: Optional[frozenset] = None


def available_filters() -> frozenset:
    """Filters this ffmpeg build actually has, probed once and cached.

    Debian's build carries everything we use, but a slimmer base image might not,
    and discovering that four minutes into a render is a bad way to find out.
    Callers degrade (waveform off, burn-in falls back to a sidecar) instead.
    """
    global _filter_cache
    if _filter_cache is not None:
        return _filter_cache
    names = set()
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                             capture_output=True, timeout=PROBE_TIMEOUT_SECONDS)
        for line in out.stdout.decode(errors="replace").splitlines():
            parts = line.split()
            # Rows look like: " T.. showwaves  A->V  Convert input audio to ..."
            if len(parts) >= 3 and not line.startswith("Filters:"):
                names.add(parts[1])
    except Exception as exc:
        logger.warning("Could not probe ffmpeg filters: %s", exc)
    _filter_cache = frozenset(names)
    return _filter_cache


def run(argv: Sequence[str], *, cwd: Optional[str] = None, timeout: int = SHOT_TIMEOUT_SECONDS) -> None:
    """Run ffmpeg, raising FFmpegError with the tail of stderr on failure."""
    result = subprocess.run(list(argv), capture_output=True, timeout=timeout, cwd=cwd)
    if result.returncode != 0:
        tail = result.stderr.decode(errors="replace")[-800:]
        raise FFmpegError(f"ffmpeg failed: {tail}")


def probe_duration(path: str) -> float:
    """Container duration in seconds, or 0.0 if it can't be read."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, timeout=PROBE_TIMEOUT_SECONDS,
        )
        return float((out.stdout.decode(errors="replace").strip() or "0") or 0)
    except (ValueError, OSError, subprocess.SubprocessError):
        return 0.0


def probe_has_audio(path: str) -> bool:
    """True when the file carries at least one audio stream.

    This is the test that decides whether a clip plays with its own sound (and
    pauses the narration) or is looped silently as a background.
    """
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
            capture_output=True, timeout=PROBE_TIMEOUT_SECONDS,
        )
        return "audio" in out.stdout.decode(errors="replace")
    except (OSError, subprocess.SubprocessError):
        return False


def encode_args(options: RenderOptions, preview: bool) -> List[str]:
    """Codec flags shared by every shot. Identical output = concat can `-c copy`."""
    preset, crf = encoder_tier(options.quality, preview)
    fps = options.fps
    return [
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
        "-r", str(fps), "-g", str(fps * 2), "-keyint_min", str(fps),
        "-video_track_timescale", "90000",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-max_muxing_queue_size", "1024",
    ]


def _hex_to_ffmpeg(colour: str) -> str:
    """'#00FF41' -> '0x00FF41'. Falls back to white on anything unparseable."""
    c = (colour or "").strip().lstrip("#")
    if len(c) == 8:  # RGBA from a colour picker — drop the alpha, we set it separately
        c = c[:6]
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in c):
        return "0xffffff"
    return f"0x{c.lower()}"


def fit_chain(src: str, out: str, width: int, height: int, fit: str) -> str:
    """Scale arbitrary media into the output frame.

    blur — a scaled-up, blurred copy fills the frame with the real media
           contained and centred on top. Never crops, and reads as deliberate at
           every aspect ratio, which matters most for 9:16 where article images
           are almost always the wrong shape.
    pad  — letterbox against black.
    crop — fill the frame and lose the edges.
    """
    if fit == "crop":
        return (f"[{src}]scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height},setsar=1[{out}]")
    if fit == "pad":
        return (f"[{src}]scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{out}]")
    sigma = max(8, width // 40)
    return (
        f"[{src}]split[{out}_a][{out}_b];"
        f"[{out}_a]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},gblur=sigma={sigma},eq=brightness=-0.08[{out}_bg];"
        f"[{out}_b]scale={width}:{height}:force_original_aspect_ratio=decrease[{out}_fg];"
        f"[{out}_bg][{out}_fg]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1[{out}]"
    )


def waveform_chain(
    audio_src: str, video_src: str, out: str,
    width: int, height: int, fps: int, spec,
) -> str:
    """Animated showwaves band composited over the background.

    Two details matter: `rate` must equal the output frame rate or the wave
    drifts against the picture, and the alpha is set once — the reference
    formula's repeated colorchannelmixer passes collapse to a single value.
    """
    band = max(24, int(height * max(5, min(60, spec.height_pct)) / 100))
    band -= band % 2
    if spec.position == "top":
        y = 0
    elif spec.position == "center":
        y = (height - band) // 2
    else:
        y = height - band
    alpha = max(0.05, min(1.0, spec.opacity))
    colour = _hex_to_ffmpeg(spec.color)

    parts = [
        f"[{audio_src}]aformat=channel_layouts=mono,"
        f"showwaves=s={width}x{band}:mode={spec.mode}:draw=full:scale=sqrt:"
        f"rate={fps}:colors={colour},format=rgba,"
        f"colorchannelmixer=aa={alpha}[{out}_w]"
    ]
    base = video_src
    scrim = max(0.0, min(1.0, spec.scrim))
    if scrim > 0.01:
        parts.append(
            f"[{base}]drawbox=x=0:y={y}:w={width}:h={band}:"
            f"color=black@{scrim}:t=fill[{out}_s]"
        )
        base = f"{out}_s"
    parts.append(f"[{base}][{out}_w]overlay=0:{y}[{out}]")
    return ";".join(parts)


def build_shot_command(
    *,
    kind: str,
    background: Optional[str],
    audio: Optional[str],
    duration: float,
    output: str,
    options: RenderOptions,
    preview: bool,
    overlay_png: Optional[str] = None,
    subtitle_file: Optional[str] = None,
    background_has_audio: bool = False,
) -> List[str]:
    """Full argv for rendering one shot to its own MP4.

    Paths are expected to be relative to the working directory the caller runs
    this in, which keeps the `subtitles=` filter free of any escaping.
    """
    width, height = frame_size(options.aspect, options.resolution, preview)
    argv: List[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]

    # ── inputs ────────────────────────────────────────────────────────────────
    if kind in ("still", "card"):
        argv += ["-loop", "1", "-framerate", str(options.fps), "-i", background or ""]
    elif kind == "video_muted":
        # Loop the clip for as long as the narration runs, and cut the moment it
        # ends — the two halves of the spec's rule fall out of these flags.
        argv += ["-stream_loop", "-1", "-i", background or ""]
    else:  # video_sound
        argv += ["-i", background or ""]

    video_in = "0:v"
    audio_in: Optional[str] = None
    next_index = 1

    if kind == "video_sound":
        if background_has_audio:
            audio_in = "0:a"
        else:
            argv += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
            audio_in = f"{next_index}:a"
            next_index += 1
    else:
        argv += ["-i", audio or ""]
        audio_in = f"{next_index}:a"
        next_index += 1

    overlay_index: Optional[int] = None
    if overlay_png:
        argv += ["-i", overlay_png]
        overlay_index = next_index
        next_index += 1

    # ── filtergraph ───────────────────────────────────────────────────────────
    chains = [fit_chain(video_in, "fit", width, height, options.fit)]
    stage = "fit"

    filters = available_filters()
    draw_wave = bool(options.waveform.enabled and audio_in and "showwaves" in filters)

    # An input pad may only be consumed once in a filtergraph, and the waveform
    # reads the same track that gets muxed, so it needs an explicit asplit.
    audio_main = audio_in
    if draw_wave:
        chains.append(f"[{audio_in}]asplit=2[a_wave][a_main]")
        audio_main = "a_main"
        chains.append(waveform_chain("a_wave", stage, "wv", width, height, options.fps, options.waveform))
        stage = "wv"

    if overlay_index is not None:
        chains.append(f"[{stage}][{overlay_index}:v]overlay=0:0[ov]")
        stage = "ov"

    if subtitle_file and "subtitles" in filters:
        chains.append(f"[{stage}]subtitles={subtitle_file}[sub]")
        stage = "sub"

    chains.append(f"[{stage}]setsar=1,format=yuv420p[v]")

    # Pad the audio so a shot always reaches its target length even when the
    # narration is shorter (a media block with little text under it).
    chains.append(f"[{audio_main}]aresample=48000,aformat=channel_layouts=stereo,apad[a]")

    argv += ["-filter_complex", ";".join(chains), "-map", "[v]", "-map", "[a]"]
    argv += ["-t", f"{max(0.1, duration):.3f}"]
    argv += encode_args(options, preview)
    argv += [output]
    return argv


def build_concat_command(list_file: str, output: str) -> List[str]:
    """Stitch the shots. `-c copy` is valid only because every shot shares
    encode_args() — this is a remux, not a re-encode."""
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", list_file,
        "-c", "copy", "-movflags", "+faststart", output,
    ]


def build_mux_command(
    source: str, output: str,
    *, chapters_file: Optional[str] = None, subtitle_file: Optional[str] = None,
) -> List[str]:
    """Attach chapter marks and/or a soft subtitle track, still without re-encoding."""
    argv = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", source]
    index = 1
    chapters_index = subtitle_index = None
    if chapters_file:
        argv += ["-i", chapters_file]
        chapters_index = index
        index += 1
    if subtitle_file:
        argv += ["-i", subtitle_file]
        subtitle_index = index
        index += 1

    argv += ["-map", "0"]
    if subtitle_index is not None:
        argv += ["-map", str(subtitle_index)]
    if chapters_index is not None:
        argv += ["-map_metadata", str(chapters_index), "-map_chapters", str(chapters_index)]

    argv += ["-c", "copy"]
    if subtitle_index is not None:
        argv += ["-c:s", "mov_text"]
    argv += ["-movflags", "+faststart", output]
    return argv


def build_poster_command(source: str, output: str, at_seconds: float = 1.0) -> List[str]:
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, at_seconds):.3f}", "-i", source,
        "-frames:v", "1", "-q:v", "3", output,
    ]


def build_narration_command(
    list_file: str, output: str, *, speed: float = 1.0, min_seconds: float = 0.0,
) -> List[str]:
    """Join the TTS chunks into one WAV.

    Decoding to PCM rather than concatenating MP3s avoids the frame-padding gaps
    that make joined MP3 audio click and make durations drift — and the durations
    are what every shot length and subtitle cue is derived from.
    """
    filters: List[str] = []
    # atempo only accepts 0.5-2.0, so an extreme rate is applied in stages.
    remaining = max(0.25, min(4.0, speed))
    while abs(remaining - 1.0) > 0.01:
        step = max(0.5, min(2.0, remaining))
        filters.append(f"atempo={step:.4f}")
        remaining /= step
        if len(filters) >= 4:
            break
    if min_seconds > 0:
        filters.append(f"apad=whole_dur={min_seconds:.3f}")

    argv = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", list_file]
    if filters:
        argv += ["-filter:a", ",".join(filters)]
    argv += ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", output]
    return argv


def build_decode_command(source: str, output: str) -> List[str]:
    """Normalise a TTS clip to 48 kHz stereo PCM.

    The concat demuxer needs every input to share a codec and stream layout, so
    provider output (MP3 at whatever rate the model emits) is decoded before it
    is joined with the silence pads. It also makes the per-chunk durations that
    the subtitle cues are built from exact rather than frame-quantised.
    """
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", source,
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", output,
    ]


def build_silence_command(output: str, seconds: float) -> List[str]:
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-t", f"{max(0.01, seconds):.3f}", "-c:a", "pcm_s16le", output,
    ]


def write_concat_list(path: str, filenames: Sequence[str]) -> None:
    """Concat-demuxer playlist. Single quotes in a name are escaped per its
    (unusual) quoting rules; in practice every name here is a generated one."""
    with open(path, "w", encoding="utf-8") as f:
        for name in filenames:
            safe = name.replace("'", "'\\''")
            f.write(f"file '{safe}'\n")
