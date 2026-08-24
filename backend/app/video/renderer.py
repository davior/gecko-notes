"""Job orchestration: a note plus options in, an MP4 out.

The pipeline is deliberately made of small, independently-checkable steps:

    segment -> narrate every shot -> render every shot -> stitch -> mux extras

Each shot is encoded to its own MP4 with identical codec parameters, so the
stitch is a `concat -c copy` remux rather than a second full encode, and a shot
is the natural unit of progress. Everything happens in a scratch directory that
is removed on every exit path; only the finished artefacts are moved into the
user's media directory.
"""

import json
import logging
import os
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, List, Optional, Sequence, Tuple

from app.video import compose, ffmpeg as F
from app.video.narration import (
    Cue, NarrationResult, chunk_narration, shift_cues, synthesize_shot, write_srt,
)
from app.video.options import RenderOptions, frame_size, is_crossfade, kenburns_prescale
from app.video.segmenter import Segmentation, Shot, resolve_media_path, segment

logger = logging.getLogger(__name__)

WORK_ROOT_NAME = "_video_work"

# Progress is split between narration and encoding because they take comparable
# wall-clock time: TTS is network-bound per chunk, encoding is CPU-bound per shot.
NARRATION_SHARE = 40
RENDER_SHARE = 50


class RenderCancelled(Exception):
    """Raised from the progress callback to unwind a cancelled job."""


@dataclass
class RenderResult:
    video_filename: str
    subtitle_filename: Optional[str]
    thumbnail_filename: Optional[str]
    duration: float
    size_bytes: int
    warnings: List[str]


# A callback the worker supplies: (stage, percent, detail) -> None. It raises
# RenderCancelled when the job has been cancelled, which unwinds the render.
Progress = Callable[[str, int, str], None]


def _chapters_file(path: str, marks: Sequence[Tuple[float, float, str]]) -> bool:
    """Write an ffmetadata chapter list. Times are in milliseconds."""
    usable = [(s, e, t) for s, e, t in marks if t.strip() and e > s + 0.5]
    if not usable:
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(";FFMETADATA1\n")
        for start, end, title in usable:
            # '=', ';', '#' and '\' are the characters ffmetadata treats specially.
            safe = (title.replace("\\", "\\\\").replace("=", "\\=")
                         .replace(";", "\\;").replace("#", "\\#").replace("\n", " "))
            f.write("[CHAPTER]\nTIMEBASE=1/1000\n")
            f.write(f"START={int(start * 1000)}\nEND={int(end * 1000)}\ntitle={safe}\n")
    return True


def build_timeline(
    shots: Sequence[Shot], durations: Sequence[float],
    shot_cues: Sequence[Sequence[Cue]], overlap: float,
) -> Tuple[List[Tuple[float, float, str]], List[Cue], float]:
    """Lay the rendered shots out on the finished video's timeline.

    Returns the chapter marks, every subtitle cue shifted onto that timeline,
    and the total length. `overlap` is how much a crossfade eats at each join;
    at zero this is the plain-concat timeline, which is why both stitch paths
    can share one piece of arithmetic instead of drifting apart.
    """
    chapters: List[Tuple[float, float, str]] = []
    cues: List[Cue] = []
    timeline = 0.0
    for shot, duration, shot_cue in zip(shots, durations, shot_cues):
        start = timeline
        cues.extend(shift_cues(shot_cue, start))
        # A shot starts `overlap` seconds before its predecessor ends, and a
        # chapter ends where the next one begins — so the marks stay contiguous
        # rather than overlapping each other by the length of the transition.
        timeline += duration - overlap
        if shot.chapter:
            chapters.append((start, timeline, shot.chapter))
        elif chapters:
            chapters[-1] = (chapters[-1][0], timeline, chapters[-1][2])
    # Nothing overlaps the last shot, so it plays to its full length.
    timeline += overlap
    if chapters:
        chapters[-1] = (chapters[-1][0], timeline, chapters[-1][2])
    return chapters, cues, timeline


def _background_png(
    shot: Shot, work_dir: str, name: str, width: int, height: int,
    options: RenderOptions, user_id: str, media_dir: str,
    note_title: str, author: str,
) -> str:
    """Materialise the still a shot sits on, and return its filename.

    Cards are drawn here; so is the fallback used when a section has no media of
    its own, or its media turned out to be unusable.
    """
    fallback = options.fallback
    base = None
    if fallback.type == "image" and fallback.url:
        path = resolve_media_path(fallback.url, user_id, media_dir)
        if path:
            base = compose.cover_image(path, width, height)
    if base is None:
        if fallback.type == "solid":
            base = compose.solid_background(width, height, fallback.colors[0])
        else:
            base = compose.gradient_background(width, height, fallback.colors, fallback.angle)

    if shot.kind == "card":
        image = compose.card_image(
            width, height,
            title=shot.card_title or note_title or "Untitled",
            subtitle=shot.card_subtitle or "",
            background=base,
            sizes=(options.chapter_card_text if shot.card_kind == "chapter"
                   else options.title_card_text),
        )
    else:
        image = base

    out = os.path.join(work_dir, name)
    image.convert("RGB").save(out, "PNG")
    return name


def render(
    *,
    job_id: str,
    user_id: str,
    media_dir: str,
    note_content: str,
    note_title: str,
    author: str,
    options: RenderOptions,
    preview: bool,
    tts: Callable[[str], bytes],
    progress: Progress,
    max_shots: int,
    max_narration_chars: int,
) -> RenderResult:
    """Render a note to an MP4. Returns the filenames written into the user's media dir."""
    if not F.ffmpeg_available():
        raise RuntimeError("ffmpeg and ffprobe must be installed on the server")

    width, height = frame_size(options.aspect, options.resolution, preview)
    work_dir = os.path.join(media_dir, WORK_ROOT_NAME, job_id)
    os.makedirs(work_dir, exist_ok=True)

    try:
        progress("Preparing", 2, "Reading the article")
        plan: Segmentation = segment(
            note_content, user_id=user_id, media_dir=media_dir, options=options,
            note_title=note_title, author=author, has_audio=F.probe_has_audio,
        )
        shots = plan.shots
        if not shots:
            raise RuntimeError("This note has no text or media to turn into a video")
        if len(shots) > max_shots:
            raise RuntimeError(
                f"This note would need {len(shots)} segments, above the limit of {max_shots}"
            )
        if plan.narration_chars > max_narration_chars:
            raise RuntimeError(
                f"This note has {plan.narration_chars:,} characters of narration, "
                f"above the limit of {max_narration_chars:,}"
            )

        # One overlay layer for the whole video: the watermark and the fixed text
        # never change between shots, so they are composed once and reused.
        overlay_name: Optional[str] = None
        icon_path = (resolve_media_path(options.watermark.url, user_id, media_dir)
                     if options.watermark.url else None)
        watermark = options.watermark.model_copy()
        if watermark.enabled and not watermark.text.strip() and note_title:
            watermark.text = f"by {note_title}"
        layer = compose.overlay_layer(
            width, height, watermark=watermark, watermark_icon=icon_path,
            overlay_text=options.overlay_text,
        )
        if layer is not None:
            overlay_name = "overlay.png"
            layer.save(os.path.join(work_dir, overlay_name), "PNG")
        # The layer itself is kept in scope: a shot carrying a quote composites
        # the two into one PNG rather than adding a second overlay filter.

        # ── narration ─────────────────────────────────────────────────────────
        narrations: List[NarrationResult] = []
        speaking = [s for s in shots if s.kind != "video_sound"]
        done = 0
        for index, shot in enumerate(shots):
            if shot.kind == "video_sound":
                # The clip carries its own audio and the narration waits for it.
                narrations.append(NarrationResult(path=None, duration=0.0, cues=[], chars=0))
                continue
            done += 1
            progress("Narrating", 2 + int(NARRATION_SHARE * done / max(1, len(speaking))),
                     f"section {done} of {len(speaking)}")
            narrations.append(synthesize_shot(
                shot.narration, index=index, work_dir=work_dir, options=options, tts=tts,
            ))

        # ── per-shot render ───────────────────────────────────────────────────
        base = 2 + NARRATION_SHARE
        shot_files: List[str] = []
        # Collected as the shots are rendered and laid out on a timeline
        # afterwards, once the transition overlap is known.
        durations: List[float] = []
        shot_cues: List[List[Cue]] = []

        for index, (shot, narration) in enumerate(zip(shots, narrations)):
            progress("Rendering", base + int(RENDER_SHARE * index / len(shots)),
                     f"segment {index + 1} of {len(shots)}")

            if shot.kind == "video_sound":
                duration = F.probe_duration(shot.background or "") or options.min_shot_seconds
                has_audio = F.probe_has_audio(shot.background or "")
                background = shot.background
            else:
                duration = max(narration.duration, options.min_shot_seconds)
                if shot.kind == "card":
                    duration = max(options.card_seconds, narration.duration)
                has_audio = False
                # A card is always drawn, and a still with no usable media of its
                # own falls back to the chosen background; a video loops as-is.
                if shot.kind == "card" or shot.background is None:
                    # A drifting shot is fitted above the frame size, so draw its
                    # background there too: zooming into a frame-sized card would
                    # magnify the type instead of moving in on it.
                    scale = (kenburns_prescale(options.resolution, preview)
                             if F.kenburns_effect_for(shot.kind, index, options) else 1.0)
                    background = _background_png(
                        shot, work_dir, f"bg_{index:04d}.png",
                        int(width * scale), int(height * scale),
                        options, user_id, media_dir, note_title, author,
                    )
                else:
                    background = shot.background

            # Burned-in subtitles need shot-local timings, so each shot gets its
            # own SRT; the sidecar and soft track are built from the global list.
            shot_srt: Optional[str] = None
            if options.subtitles == "burn" and narration.cues:
                name = f"shot_{index:04d}.srt"
                if write_srt(os.path.join(work_dir, name), narration.cues):
                    shot_srt = name

            # A quote is drawn per shot with the global layer composited on top,
            # so the watermark still sits above the quotation and ffmpeg still
            # receives exactly one overlay input.
            shot_overlay = overlay_name
            if shot.quote_text:
                panel = compose.quote_panel(
                    width, height, text=shot.quote_text,
                    attribution=shot.quote_attribution or "", spec=options.quotes,
                )
                if panel is not None:
                    if layer is not None:
                        panel.alpha_composite(layer)
                    shot_overlay = f"overlay_{index:04d}.png"
                    panel.save(os.path.join(work_dir, shot_overlay), "PNG")

            output = f"shot_{index:04d}.mp4"
            argv = F.build_shot_command(
                kind=shot.kind, background=background, audio=narration.path,
                duration=duration, output=output, options=options, preview=preview,
                overlay_png=shot_overlay, subtitle_file=shot_srt,
                background_has_audio=has_audio, index=index,
            )
            # Run inside the work dir so every path in the command is a bare
            # filename — which is what keeps the `subtitles=` filter, whose
            # argument needs escaping, free of anything that needs escaping.
            F.run(argv, cwd=work_dir)
            shot_files.append(output)
            durations.append(duration)
            shot_cues.append(narration.cues)

        # ── timeline ──────────────────────────────────────────────────────────
        # A crossfade overlaps each pair of shots, so every shot after the first
        # starts before its predecessor ends. Laying the timeline out here, once
        # all the durations are known, means the chapter marks and the subtitle
        # cues fall out of the same arithmetic on both stitch paths — with an
        # overlap of zero this is exactly the plain-concat timeline.
        overlap = F.crossfade_overlap(
            options.transition.style, durations, options.transition.duration,
        ) or 0.0
        if is_crossfade(options.transition.style) and overlap <= 0:
            plan.warnings.append(
                "Crossfade transitions were skipped: this video has too many "
                "segments, or they are too short to overlap."
            )

        chapters, all_cues, timeline = build_timeline(shots, durations, shot_cues, overlap)

        # ── stitch ────────────────────────────────────────────────────────────
        progress("Stitching", base + RENDER_SHARE, f"joining {len(shot_files)} segments")
        if overlap > 0:
            # A blend needs adjacent shots on screen together, which no per-shot
            # filter can express, so this path re-encodes the joined stream once.
            # Every other transition still stitches as a remux below.
            F.run(
                F.build_xfade_command(
                    shot_files, durations, "stitched.mp4", options=options,
                    preview=preview, style=options.transition.style, overlap=overlap,
                ),
                cwd=work_dir, timeout=3600,
            )
        else:
            F.write_concat_list(os.path.join(work_dir, "shots.txt"), shot_files)
            F.run(F.build_concat_command("shots.txt", "stitched.mp4"), cwd=work_dir, timeout=1800)

        final = "stitched.mp4"

        # ── background music ──────────────────────────────────────────────────
        # A bed has to run continuously across shot boundaries, so it can only go
        # on once the shots are joined. Mixing here re-encodes the audio alone —
        # `-c:v copy` leaves the picture exactly as the stitch produced it.
        music_path = (resolve_media_path(options.music.url, user_id, media_dir)
                      if options.music.enabled and options.music.url else None)
        if options.music.enabled and music_path is None:
            plan.warnings.append("Background music was skipped: that track could not be read.")
        if music_path:
            progress("Stitching", base + RENDER_SHARE + 2, "mixing the background music")
            scored_length = F.probe_duration(os.path.join(work_dir, final)) or timeline
            duck = options.music.duck and "sidechaincompress" in F.available_filters()
            F.run(
                F.build_music_command(
                    final, music_path, "scored.mp4",
                    duration=scored_length, spec=options.music, duck=duck,
                ),
                cwd=work_dir, timeout=1800,
            )
            final = "scored.mp4"

        chapters_name = subtitle_name = None
        if options.embed_chapters and _chapters_file(os.path.join(work_dir, "chapters.ffmeta"), chapters):
            chapters_name = "chapters.ffmeta"
        srt_written = write_srt(os.path.join(work_dir, "subtitles.srt"), all_cues)
        if srt_written and options.subtitles == "soft":
            subtitle_name = "subtitles.srt"

        if chapters_name or subtitle_name:
            progress("Stitching", base + RENDER_SHARE + 3, "adding chapters and subtitles")
            F.run(
                F.build_mux_command(final, "final.mp4",
                                    chapters_file=chapters_name, subtitle_file=subtitle_name),
                cwd=work_dir, timeout=900,
            )
            final = "final.mp4"

        # ── publish ───────────────────────────────────────────────────────────
        progress("Finishing", 96, "saving")
        user_dir = os.path.join(media_dir, user_id)
        os.makedirs(user_dir, exist_ok=True)
        stem = uuid.uuid4().hex
        video_filename = f"{stem}.mp4"
        shutil.move(os.path.join(work_dir, final), os.path.join(user_dir, video_filename))

        subtitle_filename = None
        if srt_written and options.subtitles in ("sidecar", "soft", "burn"):
            subtitle_filename = f"{stem}.srt"
            shutil.move(os.path.join(work_dir, "subtitles.srt"),
                        os.path.join(user_dir, subtitle_filename))

        thumbnail_filename = None
        if options.thumbnail:
            thumbnail_filename = f"{stem}.poster.jpg"
            try:
                F.run(
                    F.build_poster_command(
                        os.path.join(user_dir, video_filename),
                        os.path.join(user_dir, thumbnail_filename),
                        at_seconds=min(1.0, max(0.0, timeline / 2)),
                    ),
                    timeout=120,
                )
            except (F.FFmpegError, OSError) as exc:
                logger.warning("Poster frame failed for job %s: %s", job_id, exc)
                thumbnail_filename = None

        video_path = os.path.join(user_dir, video_filename)
        return RenderResult(
            video_filename=video_filename,
            subtitle_filename=subtitle_filename,
            thumbnail_filename=thumbnail_filename,
            duration=F.probe_duration(video_path) or timeline,
            size_bytes=os.path.getsize(video_path) if os.path.isfile(video_path) else 0,
            warnings=plan.warnings,
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def estimate(
    *, user_id: str, media_dir: str, note_content: str, note_title: str,
    author: str, options: RenderOptions,
) -> Tuple[int, int, float, List[str]]:
    """Cheap dry run for the options dialog: shot count, characters, rough length.

    Uses a typical narration rate rather than synthesising anything, so it costs
    nothing and stays instant even for a long article.
    """
    plan = segment(
        note_content, user_id=user_id, media_dir=media_dir, options=options,
        note_title=note_title, author=author, has_audio=F.probe_has_audio,
    )
    durations = []
    for shot in plan.shots:
        if shot.kind == "video_sound":
            durations.append(F.probe_duration(shot.background or "") or options.min_shot_seconds)
        else:
            speed = max(0.25, options.speed)
            # ~15 characters per second is a normal TTS speaking rate.
            spoken = len(shot.narration) / 15.0 / speed
            # The pauses held at headings are real silence in the finished
            # video, so an estimate that ignored them would run short by a
            # second and a half for every heading in the article. They are
            # sped up with everything else, hence the same divisor.
            held = sum(c.pause_after_ms for c in chunk_narration(
                shot.narration,
                paragraph_pause_ms=options.paragraph_pause_ms,
                heading_pause_ms=options.heading_pause_ms,
            )) / 1000.0 / speed
            floor = options.card_seconds if shot.kind == "card" else options.min_shot_seconds
            durations.append(max(spoken + held, floor))

    # A crossfade shortens the video by one overlap per join, which is the number
    # the dialog is showing. The filter set is assumed rather than probed, so a
    # dry run stays instant and never shells out.
    overlap = F.crossfade_overlap(
        options.transition.style, durations, options.transition.duration,
        filters=frozenset({"xfade", "acrossfade"}),
    ) or 0.0
    return len(plan.shots), plan.narration_chars, F.crossfade_total(durations, overlap), plan.warnings
