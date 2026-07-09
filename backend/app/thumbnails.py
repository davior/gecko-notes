import logging
import os
from pathlib import Path
from typing import Optional

from PIL import Image, ImageOps, UnidentifiedImageError

from app.routers.media import MEDIA_DIR, IMAGE_EXTENSIONS

THUMBNAIL_MAX_DIMENSION = 480  # bounding box, aspect ratio preserved


def thumbnail_filename_for(filename: str) -> str:
    stem, ext = os.path.splitext(filename)
    return f"{stem}.thumb{ext}"


def is_thumbnail_filename(filename: str) -> bool:
    stem, _ext = os.path.splitext(filename)
    return stem.endswith(".thumb")


def original_filename_for_thumbnail(thumb_filename: str) -> str:
    stem, ext = os.path.splitext(thumb_filename)
    return f"{stem[:-len('.thumb')]}{ext}"


def generate_thumbnail(original_path: Path) -> Optional[Path]:
    """Resize + compress in place next to the original, keeping its extension.
    Returns the thumb path, or None if the format can't be decoded (HEIC/AVIF/
    corrupt) — callers treat that as a silent skip, never a hard failure."""
    thumb_path = original_path.with_name(thumbnail_filename_for(original_path.name))
    try:
        with Image.open(original_path) as img:
            img = ImageOps.exif_transpose(img)  # fix phone-photo rotation
            img.thumbnail((THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION), Image.LANCZOS)
            ext = original_path.suffix.lower()
            if ext in (".jpg", ".jpeg"):
                img = img.convert("RGB")
                img.save(thumb_path, quality=82, optimize=True)
            elif ext == ".png":
                img.save(thumb_path, optimize=True)
            elif ext == ".webp":
                img.save(thumb_path, quality=82, method=4)
            else:  # gif (first frame only), bmp, tiff, ico — let Pillow infer from extension
                img.save(thumb_path)
        return thumb_path
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logging.warning(f"Thumbnail generation skipped for {original_path}: {exc}")
        return None


def backfill_thumbnails() -> None:
    """Startup sweep: generate any missing thumbnail, delete any orphaned one
    (a thumb file whose original no longer exists). One pass per user directory.
    Runs on a background thread, so a single bad file must never abort it."""
    media_root = Path(MEDIA_DIR)
    if not media_root.exists():
        return
    try:
        for user_dir in media_root.iterdir():
            if not user_dir.is_dir():
                continue
            for path in user_dir.iterdir():
                try:
                    if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
                        continue
                    if is_thumbnail_filename(path.name):
                        original = user_dir / original_filename_for_thumbnail(path.name)
                        if not original.exists():
                            path.unlink(missing_ok=True)
                        continue
                    thumb = user_dir / thumbnail_filename_for(path.name)
                    if not thumb.exists():
                        generate_thumbnail(path)
                except OSError as exc:
                    logging.warning(f"Thumbnail backfill skipped {path}: {exc}")
    except Exception:
        logging.exception("Thumbnail backfill sweep failed")
