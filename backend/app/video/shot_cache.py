"""Finished shot encodes, kept across a failed render so a retry doesn't redo them.

A render works in a scratch directory that is removed on every exit path, and a
retry is a brand-new job with a brand-new directory — so a render that died at
the stitch, after every segment had been encoded, used to throw all of that
work away and start over.

Each shot is filed here under a fingerprint of everything that decides its
pixels and samples: the exact ffmpeg command (which carries the filtergraph, the
duration and the codec settings) and the content of every file it reads. It is
deliberately *not* keyed on the job id or on the options as a whole. Retrying
with a different transition, music bed or subtitle setting leaves most shots
byte-for-byte identical, and those are exactly the retries that matter — the
usual reason to retry is to change something that isn't in the shots at all.

Entries are hard links to the scratch file, so keeping one costs no extra disk
while the render runs. A successful render discards the entries it used, since
they are inside the finished video now; whatever a failed or cancelled one left
behind is pruned by age.
"""

import hashlib
import logging
import os
import shutil
import time
from typing import List, Optional, Sequence

logger = logging.getLogger(__name__)

CACHE_ROOT_NAME = "_video_cache"

# Long enough to notice a failure, change a setting and try again; short enough
# that abandoned encodes don't sit on the disk.
MAX_AGE_SECONDS = 48 * 60 * 60

# Bump when a change to the pipeline means an old encode is no longer valid even
# though the command and inputs look the same.
CACHE_VERSION = "1"

_PLAIN_SUFFIX = ".plain"


def shot_key(argv: Sequence[str], inputs: Sequence[Optional[str]], work_dir: str) -> str:
    """Fingerprint of one shot's encode.

    `argv` is the command that would produce it, minus its trailing output name
    (which only carries the shot's position, so a shot that merely moved would
    otherwise miss). `inputs` are the files it reads: generated ones inside
    `work_dir` are hashed by content, since they are rebuilt every run; the
    user's own media, which can be hundreds of megabytes, by size and mtime.
    """
    digest = hashlib.sha256(CACHE_VERSION.encode())
    for arg in argv[:-1]:
        digest.update(arg.encode("utf-8", "replace"))
        digest.update(b"\0")
    for name in inputs:
        if not name:
            continue
        digest.update(_signature(name, work_dir).encode())
        digest.update(b"\0")
    return digest.hexdigest()


def _signature(name: str, work_dir: str) -> str:
    full = name if os.path.isabs(name) else os.path.join(work_dir, name)
    try:
        stat = os.stat(full)
    except OSError:
        return "missing"
    root = os.path.abspath(work_dir) + os.sep
    if not os.path.abspath(full).startswith(root):
        return f"{stat.st_size}:{stat.st_mtime_ns}"
    digest = hashlib.sha256()
    with open(full, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _link_or_copy(src: str, dest: str) -> None:
    """Hard link where the filesystem allows it, else copy. Lands atomically."""
    tmp = f"{dest}.{os.getpid()}.tmp"
    try:
        try:
            os.link(src, tmp)
        except OSError:
            shutil.copy2(src, tmp)
        os.replace(tmp, dest)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


class ShotCache:
    """One user's cache directory, plus a note of which entries this render touched."""

    def __init__(self, media_dir: str, user_id: str) -> None:
        self.dir = os.path.join(media_dir, CACHE_ROOT_NAME, user_id)
        self._used: List[str] = []

    def _path(self, key: str) -> str:
        return os.path.join(self.dir, f"{key}.mp4")

    def restore(self, key: str, dest: str) -> Optional[bool]:
        """Put a cached encode at `dest`.

        None on a miss. On a hit, whether that encode had to fall back to the
        plainer settings, so the render can repeat the warning it earned then.
        """
        path = self._path(key)
        if not os.path.isfile(path):
            return None
        try:
            _link_or_copy(path, dest)
            os.utime(path)  # a retry in progress keeps its entries alive
        except OSError as exc:
            logger.warning("Could not reuse cached shot %s: %s", key[:12], exc)
            return None
        self._used.append(key)
        return os.path.isfile(path + _PLAIN_SUFFIX)

    def store(self, key: str, src: str, *, plain: bool) -> None:
        """File a finished encode. Best effort: a full disk must not fail a render."""
        try:
            os.makedirs(self.dir, exist_ok=True)
            path = self._path(key)
            _link_or_copy(src, path)
            if plain:
                open(path + _PLAIN_SUFFIX, "wb").close()
            self._used.append(key)
        except OSError as exc:
            logger.warning("Could not cache shot %s: %s", key[:12], exc)

    def discard_used(self) -> None:
        """The render succeeded, so what it used is inside the finished video."""
        for key in self._used:
            for path in (self._path(key), self._path(key) + _PLAIN_SUFFIX):
                try:
                    os.remove(path)
                except OSError:
                    pass
        self._used = []


def prune(media_dir: str, max_age_seconds: int = MAX_AGE_SECONDS) -> None:
    """Delete cache entries nobody has touched for `max_age_seconds`."""
    root = os.path.join(media_dir, CACHE_ROOT_NAME)
    cutoff = time.time() - max_age_seconds
    for folder, _dirs, files in os.walk(root, topdown=False):
        for name in files:
            path = os.path.join(folder, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass
        if folder != root:
            try:
                os.rmdir(folder)  # only succeeds once empty
            except OSError:
                pass
