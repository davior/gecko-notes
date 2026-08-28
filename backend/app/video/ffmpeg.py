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
import math
import os
import shutil
import subprocess
from typing import Dict, List, Optional, Sequence, Tuple

from app.video.options import (
    DIP_TRANSITIONS, XFADE_NAMES, MusicSpec, RenderOptions,
    encoder_tier, frame_size, is_crossfade, kenburns_geometry,
    kenburns_leg_frames, transition_colour,
)

logger = logging.getLogger(__name__)

# Long enough for a 4K encode of a multi-minute clip, short enough that a wedged
# process can't hold the render queue forever. Mirrors transcription.py's style.
# A flat per-shot cap is wrong, because a shot is not a fixed amount of work: a
# three-second card and an eight-minute still both used to get 900 seconds, and
# the second one cannot possibly finish in it. These bound a shot by how long it
# actually is, with the old value as the floor so short shots are unaffected.
SHOT_TIMEOUT_SECONDS = 900
SHOT_TIMEOUT_FACTOR = 6
SHOT_TIMEOUT_CEILING = 2 * 60 * 60
PROBE_TIMEOUT_SECONDS = 30

# An xfade stitch puts every shot in one filtergraph as its own input. That is
# fine for the ten to thirty shots a normal article produces and absurd at the
# 200 VIDEO_MAX_SHOTS ceiling, so past this many the render degrades to a plain
# concat rather than building a graph that would thrash the box.
XFADE_MAX_SHOTS = 60

# An overlap shorter than this isn't a transition, it's a glitch.
MIN_TRANSITION_SECONDS = 0.05

# Deterministic rotation for the "alternate" Ken Burns effect. Keyed off the shot
# index rather than a random draw so re-rendering a note is reproducible.
KENBURNS_CYCLE = ("zoom_in", "pan_right", "zoom_out", "pan_left")


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


def shot_timeout(duration: float) -> int:
    """How long one shot may take to encode, given how long the shot is.

    Encoding runs slower than real time once a filter chain and a slow x264
    preset are involved, so the budget is a multiple of the shot's length rather
    than a constant — with the old flat value as a floor, so nothing short gets
    less than it had.
    """
    scaled = max(0.0, duration) * SHOT_TIMEOUT_FACTOR
    return int(min(SHOT_TIMEOUT_CEILING, max(SHOT_TIMEOUT_SECONDS, scaled)))


def run(argv: Sequence[str], *, cwd: Optional[str] = None, timeout: int = SHOT_TIMEOUT_SECONDS) -> None:
    """Run ffmpeg, raising FFmpegError with something readable on failure.

    A timeout is converted here rather than left to propagate. `TimeoutExpired`
    stringifies as the entire argv followed by the reason, which runs past a
    thousand characters — so by the time the worker truncates it for the UI the
    reason has been cut off the end and all the user sees is a severed command
    line. The original is chained, so the full argv still reaches the log, which
    is where it is actually useful.
    """
    try:
        result = subprocess.run(list(argv), capture_output=True, timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(
            f"ffmpeg gave up on a segment after {timeout}s. It is probably a very "
            f"long section on one image — try a lower resolution or a faster "
            f"encoding preset."
        ) from exc
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


def _even(value: float) -> int:
    """Round down to an even integer — libx264 with yuv420p requires it."""
    n = max(2, int(value))
    return n - n % 2


def kenburns_effect_for(kind: str, index: int, options: RenderOptions) -> Optional[str]:
    """Which drift, if any, this shot gets.

    A video background already moves, so only stills and (opt-in) cards drift. A
    card has its text drawn into the picture, so it is only ever allowed to zoom
    from the centre — a pan would walk the type out of frame.

    Every qualifying shot gets its drift regardless of how long it runs — a shot
    long enough that one sweep across it would be too slow to see gets the drift
    cycled by `kenburns_chain` instead of dropped.
    """
    effect = options.ken_burns.effect
    if effect == "none":
        return None
    if kind == "card":
        if not options.ken_burns.include_cards:
            return None
    elif kind != "still":
        return None

    if effect == "alternate":
        effect = KENBURNS_CYCLE[index % len(KENBURNS_CYCLE)]
    if kind == "card" and effect.startswith("pan"):
        return "zoom_in"
    return effect


def kenburns_chain(
    src: str, out: str, *,
    width: int, height: int, fps: int, duration: float,
    effect: str, amount: float,
) -> str:
    """A `zoompan` drift over a still, rendered above `width`x`height` and scaled back.

    `width`/`height` are the output frame; the caller must have fitted the source
    at `kenburns_geometry`'s read size, which is what makes this smooth. zoompan
    truncates its crop origin to whole pixels of the frame it is given, and a
    slow drift moves that origin by a fraction of an output pixel per frame — so
    reading a much larger picture, and writing one larger than the frame before
    scaling down, are what turn a visible step into a glide.

    Two other details carry it. The travel is written against `on/N` rather than
    ffmpeg's usual incremental `zoom+step`, so it is linear and identical at any
    fps or resolution instead of drifting with the frame rate. And `zoompan`
    restarts its ramp every `d` output frames while `-loop 1` feeds frames
    forever, so `d` is set a couple of frames beyond the shot and the caller's
    `-t` cuts before the ramp can begin again.

    A shot longer than `kenburns_leg_frames` would spread the same travel over
    so many frames that the sweep crawls below the perceptible floor — so past
    that length the progress no longer runs A to B once across the whole shot;
    it cycles A to B to A in legs of that length instead, a rubber band, which
    holds the same speed regardless of how long the shot runs.

    No expression here — including the cycling one — contains a comma or a
    colon, which is what keeps the filtergraph free of any escaping: `on mod
    period` and the triangle wave's peak are written out with `floor` and `abs`
    rather than ffmpeg's own `mod` and `min`, both of which take a
    comma-separated argument list.
    """
    read_width, _read_height, write_width, write_height = kenburns_geometry(width, height)
    frames = max(1, int(math.ceil(max(0.1, duration) * max(1, fps))))
    # What is read is the only headroom the zoom has; travelling past it would
    # start magnifying pixels, which is the softness this arrangement avoids.
    span = max(0.01, min(amount, read_width / max(1, width) - 1.0))

    leg = kenburns_leg_frames(amount, width)
    if frames <= leg:
        progress = f"on/{frames}"
    else:
        # A triangle wave of period 2*leg: 0 at on=0, 1 at on=leg, back to 0 at
        # on=2*leg, repeating. `on mod period` is `on - period*floor(on/period)`
        # rather than ffmpeg's own `mod(on,period)`, and the peak is
        # `1-abs(...)` rather than `min(...)`, because both of those take a
        # comma — see the no-escaping note above.
        period = 2 * leg
        progress = f"(1-abs((on-{period}*floor(on/{period}))/{leg}-1))"

    if effect == "zoom_out":
        z = f"{1.0 + span:.4f}-{span:.4f}*{progress}"
    elif effect.startswith("pan"):
        z = f"{1.0 + span:.4f}"
    else:  # zoom_in and anything unrecognised
        z = f"1+{span:.4f}*{progress}"

    # Centre the frame by default; a pan sweeps one axis end to end instead.
    x, y = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    if effect == "pan_left":
        x = f"(iw-iw/zoom)*(1-{progress})"
    elif effect == "pan_right":
        x = f"(iw-iw/zoom)*{progress}"
    elif effect == "pan_up":
        y = f"(ih-ih/zoom)*(1-{progress})"
    elif effect == "pan_down":
        y = f"(ih-ih/zoom)*{progress}"

    chain = (f"[{src}]zoompan=z={z}:x={x}:y={y}:"
             f"d={frames + 2}:s={write_width}x{write_height}:fps={fps}")
    if (write_width, write_height) != (width, height):
        # Scaling back down halves whatever step survived and averages it away.
        chain += f",scale={width}:{height}"
    return f"{chain}[{out}]"


def dip_seconds(style: str, requested: float, shot_duration: float) -> float:
    """How long a dip-through-colour transition may last on a shot this short.

    A shot has to hold a fade out as well as a fade in, so a third of its length
    is the ceiling; below that the two would overlap and the picture would never
    be fully visible.
    """
    if style not in DIP_TRANSITIONS:
        return 0.0
    seconds = min(max(0.0, requested), max(0.0, shot_duration) / 3.0)
    return seconds if seconds >= MIN_TRANSITION_SECONDS else 0.0


def crossfade_overlap(
    style: str, durations: Sequence[float], requested: float,
    *, filters: Optional[frozenset] = None,
) -> Optional[float]:
    """The overlap an xfade stitch should use, or None to fall back to concat.

    Every reason a crossfade can't run lives here so the renderer branches once
    and the guards can be tested without ffmpeg: the style isn't a blend, there
    is nothing to blend between, the graph would be unreasonably large, the host
    ffmpeg lacks the filters, or the shots are too short to absorb an overlap.
    """
    if not is_crossfade(style) or len(durations) < 2:
        return None
    if len(durations) > XFADE_MAX_SHOTS:
        return None
    names = available_filters() if filters is None else filters
    if "xfade" not in names or "concat" not in names:
        return None
    overlap = min(max(0.0, requested), 0.5 * min(durations))
    return overlap if overlap >= MIN_TRANSITION_SECONDS else None


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
    index: int = 0,
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
    filters = available_filters()

    # A drifting shot is fitted larger than the output frame so `zoompan` has
    # real pixels to zoom into, and zoompan's own `s=` brings it back down.
    # Fitting at the output size first would just magnify its softness.
    drift = (kenburns_effect_for(kind, index, options)
             if "zoompan" in filters else None)
    if drift:
        read_width, read_height, _w, _h = kenburns_geometry(width, height)
        chains = [fit_chain(video_in, "fit", read_width, read_height, options.fit)]
        chains.append(kenburns_chain(
            "fit", "kb", width=width, height=height, fps=options.fps, duration=duration,
            effect=drift, amount=options.ken_burns.amount,
        ))
        stage = "kb"
    else:
        chains = [fit_chain(video_in, "fit", width, height, options.fit)]
        stage = "fit"

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

    # A dip through black or white is drawn inside the shot, so its duration is
    # unchanged and the stitch stays a `concat -c copy` remux. A blending
    # transition cannot be expressed here at all — see build_xfade_command.
    dip = dip_seconds(options.transition.style, options.transition.duration, duration)
    if dip > 0:
        colour = transition_colour(options.transition.style)
        chains.append(
            f"[{stage}]fade=t=in:st=0:d={dip:.3f}:color={colour},"
            f"fade=t=out:st={duration - dip:.3f}:d={dip:.3f}:color={colour}[fd]"
        )
        stage = "fd"

    chains.append(f"[{stage}]setsar=1,format=yuv420p[v]")

    # Pad the audio so a shot always reaches its target length even when the
    # narration is shorter (a media block with little text under it).
    audio_chain = f"[{audio_main}]aresample=48000,aformat=channel_layouts=stereo,apad"
    if dip > 0:
        # Only the tail is faded, to match the picture dipping to colour there —
        # and it lands in the trailing hold `shot_end_pause_ms` leaves after the
        # last word, not on speech itself. The start has no equivalent lead-in
        # silence: narration begins at st=0 of the shot, so a matching fade-in
        # there was ramping up through the sentence's actual first word,
        # sometimes past the point of being audible at all.
        audio_chain += f",afade=t=out:st={duration - dip:.3f}:d={dip:.3f}"
    chains.append(f"{audio_chain}[a]")

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


def build_xfade_command(
    shot_files: Sequence[str], durations: Sequence[float], output: str,
    *, options: RenderOptions, preview: bool, style: str, overlap: float,
) -> List[str]:
    """Stitch the shots with a blending transition instead of a plain concat.

    Unlike `build_concat_command` this is a real encode, because a blend needs
    adjacent shots to be on screen at the same time and no per-shot filter can
    express that. It is still only one pass over the joined stream, and it reuses
    `encode_args` so the result matches every other path's quality settings.

    Each shot is its own input and the graph chains pairwise, carrying the
    running total so every `offset` lands where the previous blend left off:
    shot k starts `overlap` seconds before the accumulated stream ends.

    The audio does not blend the way the picture does. An `acrossfade` here
    would mix the outgoing shot's trailing hold — the very silence
    `shot_end_pause_ms`/`heading_pause_ms` puts there — with the incoming
    shot's opening words ramping up underneath it, which is exactly what
    used to muffle the start of every segment after the first and swallow
    the configured pause along with it. Instead the accumulated audio is
    trimmed to end exactly where the picture starts blending, and the next
    shot's track is appended untouched: a clean cut under a blended
    picture, eating the same `overlap` seconds the video xfade does so the
    two streams stay in sync without the words ever overlapping.
    """
    argv = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    for name in shot_files:
        argv += ["-i", name]

    transition = XFADE_NAMES.get(style, "dissolve")
    chains: List[str] = []
    video, audio = "0:v", "0:a"
    total = durations[0]
    for index in range(1, len(shot_files)):
        offset = max(0.0, total - overlap)
        chains.append(
            f"[{video}][{index}:v]xfade=transition={transition}:"
            f"duration={overlap:.3f}:offset={offset:.3f}[vx{index}]"
        )
        chains.append(f"[{audio}]atrim=end={offset:.3f},asetpts=PTS-STARTPTS[at{index}]")
        chains.append(f"[at{index}][{index}:a]concat=n=2:v=0:a=1[ax{index}]")
        video, audio = f"vx{index}", f"ax{index}"
        total += durations[index] - overlap

    chains.append(f"[{video}]setsar=1,format=yuv420p[v]")
    argv += ["-filter_complex", ";".join(chains), "-map", "[v]", "-map", f"[{audio}]"]
    argv += encode_args(options, preview)
    argv += ["-movflags", "+faststart", output]
    return argv


def crossfade_total(durations: Sequence[float], overlap: float) -> float:
    """Length of an xfade stitch: every join eats `overlap` seconds."""
    if not durations:
        return 0.0
    return max(0.0, sum(durations) - overlap * (len(durations) - 1))


def build_music_command(
    source: str, music: str, output: str,
    *, duration: float, spec: MusicSpec, duck: bool,
) -> List[str]:
    """Mix a background bed under the finished video, without touching the picture.

    Music has to run continuously across shot boundaries, so it cannot be a
    per-shot input — it goes on after the stitch. `-c:v copy` is the point: the
    video stream is passed through untouched and only the audio is re-encoded,
    so scoring a render costs seconds rather than a second full encode.

    `-stream_loop -1` covers a bed shorter than the video and the output `-t`
    truncates one that is longer. `normalize=0` stops `amix` halving the
    narration to make room, which is the default and never what anyone wants.
    """
    fade_out_at = max(0.0, duration - max(0.0, spec.fade_out))
    bed = (f"[1:a]volume={max(0.0, min(1.0, spec.volume)):.3f},"
           f"aresample=48000,aformat=channel_layouts=stereo")
    if spec.fade_in > 0:
        bed += f",afade=t=in:st=0:d={spec.fade_in:.3f}"
    if spec.fade_out > 0:
        bed += f",afade=t=out:st={fade_out_at:.3f}:d={spec.fade_out:.3f}"
    chains = [f"{bed}[m]"]

    if duck:
        # Compress the bed against the narration so it drops under speech and
        # comes back up in the gaps. The main input comes first, the key second.
        chains.append("[0:a]asplit=2[nar][key]")
        chains.append("[m][key]sidechaincompress="
                      "threshold=0.060:ratio=8:attack=15:release=350[bed]")
        chains.append("[nar][bed]amix=inputs=2:normalize=0:duration=first[a]")
    else:
        chains.append("[0:a][m]amix=inputs=2:normalize=0:duration=first[a]")

    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", source, "-stream_loop", "-1", "-i", music,
        "-filter_complex", ";".join(chains),
        "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", f"{max(0.1, duration):.3f}", "-movflags", "+faststart", output,
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
