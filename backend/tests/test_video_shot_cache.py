"""The shot cache: what makes a retry reuse an encode, and what must not.

No ffmpeg here — the cache only ever sees file names and bytes.
"""

import os
import time

from app.video import shot_cache as C


def _work(tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    return str(work)


def _key(work, argv=("ffmpeg", "-i", "a.wav", "shot_0001.mp4"), inputs=("a.wav",)):
    return C.shot_key(list(argv), list(inputs), work)


def test_same_command_and_inputs_share_a_key(tmp_path):
    work = _work(tmp_path)
    (tmp_path / "work" / "a.wav").write_bytes(b"narration")
    assert _key(work) == _key(work)


def test_output_name_does_not_matter_but_everything_else_does(tmp_path):
    work = _work(tmp_path)
    (tmp_path / "work" / "a.wav").write_bytes(b"narration")
    base = _key(work)
    # A shot that merely moved position keeps its encode...
    assert _key(work, argv=("ffmpeg", "-i", "a.wav", "shot_0009.mp4")) == base
    # ...but a different filtergraph, duration or codec setting does not.
    assert _key(work, argv=("ffmpeg", "-t", "3", "-i", "a.wav", "shot_0001.mp4")) != base


def test_generated_inputs_are_keyed_on_content(tmp_path):
    work = _work(tmp_path)
    audio = tmp_path / "work" / "a.wav"
    audio.write_bytes(b"one")
    first = _key(work)
    audio.write_bytes(b"two")
    assert _key(work) != first


def test_user_media_is_keyed_on_size_and_mtime_not_content(tmp_path):
    work = _work(tmp_path)
    media = tmp_path / "photo.jpg"
    media.write_bytes(b"x" * 10)
    first = C.shot_key(["ffmpeg", "out.mp4"], [str(media)], work)
    assert C.shot_key(["ffmpeg", "out.mp4"], [str(media)], work) == first
    media.write_bytes(b"x" * 11)
    assert C.shot_key(["ffmpeg", "out.mp4"], [str(media)], work) != first


def test_missing_and_absent_inputs_are_tolerated(tmp_path):
    work = _work(tmp_path)
    assert _key(work, inputs=("nope.png", None, ""))


def test_a_miss_then_a_hit(tmp_path):
    cache = C.ShotCache(str(tmp_path), "u1")
    work = tmp_path / "work"
    work.mkdir()
    (work / "shot_0000.mp4").write_bytes(b"encoded")

    assert cache.restore("k", str(work / "again.mp4")) is None
    cache.store("k", str(work / "shot_0000.mp4"), plain=False)

    retry = C.ShotCache(str(tmp_path), "u1")
    assert retry.restore("k", str(work / "again.mp4")) is False
    assert (work / "again.mp4").read_bytes() == b"encoded"


def test_the_plain_fallback_is_remembered(tmp_path):
    cache = C.ShotCache(str(tmp_path), "u1")
    src = tmp_path / "shot.mp4"
    src.write_bytes(b"encoded")
    cache.store("k", str(src), plain=True)
    assert C.ShotCache(str(tmp_path), "u1").restore("k", str(tmp_path / "out.mp4")) is True


def test_a_cached_shot_survives_the_scratch_directory_being_removed(tmp_path):
    import shutil
    cache = C.ShotCache(str(tmp_path), "u1")
    work = tmp_path / "work"
    work.mkdir()
    (work / "shot.mp4").write_bytes(b"encoded")
    cache.store("k", str(work / "shot.mp4"), plain=False)
    shutil.rmtree(work)

    work.mkdir()
    assert C.ShotCache(str(tmp_path), "u1").restore("k", str(work / "shot.mp4")) is False
    assert (work / "shot.mp4").read_bytes() == b"encoded"


def test_users_do_not_share_entries(tmp_path):
    src = tmp_path / "shot.mp4"
    src.write_bytes(b"encoded")
    C.ShotCache(str(tmp_path), "u1").store("k", str(src), plain=False)
    assert C.ShotCache(str(tmp_path), "u2").restore("k", str(tmp_path / "out.mp4")) is None


def test_a_successful_render_discards_what_it_used(tmp_path):
    cache = C.ShotCache(str(tmp_path), "u1")
    src = tmp_path / "shot.mp4"
    src.write_bytes(b"encoded")
    cache.store("k", str(src), plain=True)
    cache.discard_used()
    assert C.ShotCache(str(tmp_path), "u1").restore("k", str(tmp_path / "out.mp4")) is None
    assert os.listdir(cache.dir) == []


def test_prune_removes_only_stale_entries(tmp_path):
    cache = C.ShotCache(str(tmp_path), "u1")
    # Separate sources: a cache entry is a hard link, so two entries filed from
    # one file would share an inode and therefore a modification time.
    for name in ("old", "new"):
        (tmp_path / f"{name}_src.mp4").write_bytes(b"encoded")
        cache.store(name, str(tmp_path / f"{name}_src.mp4"), plain=False)
    stale = time.time() - 10 * C.MAX_AGE_SECONDS
    os.utime(os.path.join(cache.dir, "old.mp4"), (stale, stale))

    C.prune(str(tmp_path))
    assert os.listdir(cache.dir) == ["new.mp4"]


def test_prune_with_no_cache_yet_is_a_no_op(tmp_path):
    C.prune(str(tmp_path))
