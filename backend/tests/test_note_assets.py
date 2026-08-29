"""Tests for the note-asset registry behind the Assets tab.

Two halves. The pure functions (`extract_media_refs`, `parse_media_url`) are the ones
every other piece is built on — reconciliation, the backfill migration and the
unlinked-file sweep all read note content through them, and `parse_media_url` is the
guard standing between a URL in user-authored content and an `os.remove`.

The rest exercise the behaviour the feature exists for: an asset survives being deleted
out of the note body, and a file is only ever unlinked when nothing else points at it.
"""

import json
import os
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app import asset_utils
from app.asset_utils import (
    ORIGIN_EMBEDDED,
    ORIGIN_EXPORT,
    ORIGIN_REFERENCE,
    extract_media_refs,
    extract_media_urls,
    file_is_referenced,
    parse_media_url,
    purge_note_assets,
    register_asset,
    release_media_file,
    sync_note_assets,
)
from app.models import Note, NoteAsset, Theme, User
from app.routers.assets import _ai_eligible, _role_for

USER = "user-1"
OTHER_USER = "user-2"


# ─── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


@pytest.fixture
def media_dir(tmp_path, monkeypatch):
    """Point the media tree at a temp dir.

    asset_utils binds MEDIA_DIR at import time, so the patch has to land on its own
    namespace rather than on app.routers.media.
    """
    monkeypatch.setattr(asset_utils, "MEDIA_DIR", str(tmp_path))
    return tmp_path


def media_file(media_dir, owner: str, filename: str, content: bytes = b"x" * 32) -> str:
    """Create a file in the media tree and return its /media/ URL."""
    owner_dir = media_dir / owner
    owner_dir.mkdir(parents=True, exist_ok=True)
    (owner_dir / filename).write_bytes(content)
    return f"/media/{owner}/{filename}"


def make_note(session, *, note_id="note-1", user_id=USER, content="[]") -> Note:
    now = datetime.now(timezone.utc)
    note = Note(
        id=note_id,
        title="Test note",
        content=content,
        category_id="cat-1",
        created_at=now,
        modified_at=now,
        user_id=user_id,
    )
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


def blocks(*specs) -> str:
    """Serialise BlockNote-shaped blocks. Each spec is (type, props) or (type, props, children)."""
    def build(spec):
        block_type, props = spec[0], spec[1]
        children = spec[2] if len(spec) > 2 else []
        return {"id": f"b-{block_type}", "type": block_type, "props": props,
                "children": [build(c) for c in children]}
    return json.dumps([build(s) for s in specs])


# ─── extract_media_refs ───────────────────────────────────────────────────────


def test_extract_media_refs_finds_every_block_type():
    content = blocks(
        ("image", {"url": "/media/u/a.png"}),
        ("videoFile", {"url": "/media/u/b.mp4"}),
        ("audioFile", {"url": "/media/u/c.mp3"}),
        ("file", {"url": "/media/u/d.pdf"}),
    )
    assert extract_media_urls(content) == [
        "/media/u/a.png", "/media/u/b.mp4", "/media/u/c.mp3", "/media/u/d.pdf",
    ]


def test_extract_media_refs_descends_into_children():
    """Media nested under a list item or column is still the note's media."""
    content = blocks(
        ("paragraph", {}, [
            ("paragraph", {}, [("image", {"url": "/media/u/deep.png"})]),
        ]),
    )
    assert extract_media_urls(content) == ["/media/u/deep.png"]


def test_extract_media_refs_keeps_block_names():
    """The block's own name is the only readable label a reconciled file ever gets."""
    content = blocks(("videoFile", {"url": "/media/u/a.mp4", "name": "Recording — Tuesday"}))
    ref = extract_media_refs(content)[0]
    assert ref.name == "Recording — Tuesday"
    assert ref.block_type == "videoFile"


def test_extract_media_refs_falls_back_to_caption():
    content = blocks(("image", {"url": "/media/u/a.png", "caption": "The diagram"}))
    ref = extract_media_refs(content)[0]
    assert ref.name is None
    assert ref.caption == "The diagram"


def test_extract_media_refs_ignores_blank_names():
    content = blocks(("image", {"url": "/media/u/a.png", "name": "   ", "caption": ""}))
    ref = extract_media_refs(content)[0]
    assert ref.name is None and ref.caption is None


def test_extract_media_refs_dedupes_a_repeated_url():
    """The same file used twice in one note is one asset, not two."""
    content = blocks(
        ("image", {"url": "/media/u/a.png"}),
        ("image", {"url": "/media/u/a.png"}),
    )
    assert extract_media_urls(content) == ["/media/u/a.png"]


def test_extract_media_refs_ignores_remote_urls():
    content = blocks(
        ("image", {"url": "https://example.com/a.png"}),
        ("image", {"url": "/media/u/local.png"}),
    )
    assert extract_media_urls(content) == ["/media/u/local.png"]


@pytest.mark.parametrize("content", ["", "not json", "{}", "null", '"a string"'])
def test_extract_media_refs_survives_bad_content(content):
    """Content is user data that has been through many app versions; never raise on it."""
    assert extract_media_refs(content) == []


# ─── parse_media_url ──────────────────────────────────────────────────────────


def test_parse_media_url_splits_owner_and_filename():
    assert parse_media_url("/media/user-1/abc.png") == ("user-1", "abc.png")


def test_parse_media_url_strips_query_and_fragment():
    assert parse_media_url("/media/user-1/abc.png?v=2#top") == ("user-1", "abc.png")


@pytest.mark.parametrize("url", [
    "/media/../../etc/passwd",          # traversal
    "/media/user-1/../../etc/passwd",   # traversal past the owner dir
    "/media/user-1/nested/abc.png",     # deeper than the layout allows
    "/media/abc.png",                   # no owner segment
    "/media/user-1/",                   # no filename
    "/media//abc.png",                  # empty owner
    "/media/user-1\\abc.png",           # backslash separator
    "/uploads/user-1/abc.png",          # not the media tree
    "https://evil.test/media/u/a.png",  # absolute URL
    "",
    None,
])
def test_parse_media_url_rejects_anything_off_shape(url):
    """This is the guard between a URL in note content and an os.remove."""
    assert parse_media_url(url) is None


# ─── reconciliation ───────────────────────────────────────────────────────────


def test_sync_registers_media_found_in_content(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session, content=blocks(("image", {"url": url, "name": "Chart.png"})))

    assert sync_note_assets(session, note) == 1

    asset = session.exec(select(NoteAsset)).one()
    assert asset.url == url
    assert asset.filename == "a.png"
    assert asset.original_name == "Chart.png"
    assert asset.kind == "images"
    assert asset.origin == ORIGIN_EMBEDDED
    assert asset.size_bytes == 32


def test_sync_is_idempotent(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session, content=blocks(("image", {"url": url})))

    assert sync_note_assets(session, note) == 1
    assert sync_note_assets(session, note) == 0
    assert len(session.exec(select(NoteAsset)).all()) == 1


def test_sync_never_removes_a_row_when_the_block_goes(session, media_dir):
    """The feature in one test: take the image out of the note, keep the asset.

    This is what lets a file be deleted from the body and still be there to curate
    afterwards, instead of vanishing from the app while staying on disk forever.
    """
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session, content=blocks(("image", {"url": url})))
    sync_note_assets(session, note)

    note.content = blocks(("paragraph", {}))
    session.add(note)
    session.commit()
    assert sync_note_assets(session, note) == 0

    asset = session.exec(select(NoteAsset)).one()
    assert asset.url == url
    # ...and it now reads as detached rather than as part of the note.
    assert _role_for(asset, in_note=False) == "detached"


def test_sync_skips_notes_with_no_media(session):
    note = make_note(session, content=blocks(("paragraph", {})))
    assert sync_note_assets(session, note) == 0


def test_sync_ignores_malformed_urls(session, media_dir):
    note = make_note(session, content=blocks(("image", {"url": "/media/../escape.png"})))
    assert sync_note_assets(session, note) == 0
    assert session.exec(select(NoteAsset)).all() == []


# ─── register_asset ───────────────────────────────────────────────────────────


def test_register_asset_stores_the_uploaded_name(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session)

    asset = register_asset(
        session, user_id=USER, note_id=note.id, url=url,
        original_name="holiday snap.png", mime_type="image/png", size_bytes=32,
    )
    assert asset is not None
    assert asset.original_name == "holiday snap.png"


def test_register_asset_backfills_a_name_onto_a_reconciled_row(session, media_dir):
    """A reconciled row shows a UUID; a later upload of the same file knows better."""
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session, content=blocks(("image", {"url": url})))
    sync_note_assets(session, note)
    assert session.exec(select(NoteAsset)).one().original_name is None

    asset = register_asset(session, user_id=USER, note_id=note.id, url=url,
                           original_name="real name.png")

    assert asset.original_name == "real name.png"
    assert len(session.exec(select(NoteAsset)).all()) == 1


def test_register_asset_refuses_someone_elses_note(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session, user_id=OTHER_USER)

    assert register_asset(session, user_id=USER, note_id=note.id, url=url) is None
    assert session.exec(select(NoteAsset)).all() == []


def test_register_asset_ignores_an_unknown_note(session, media_dir):
    """An upload into an unsaved note must not fail — reconciliation catches it later."""
    url = media_file(media_dir, USER, "a.png")
    assert register_asset(session, user_id=USER, note_id="no-such-note", url=url) is None


# ─── reference counting ───────────────────────────────────────────────────────


def test_release_deletes_an_unreferenced_file(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    path = media_dir / USER / "a.png"
    assert path.exists()

    assert release_media_file(session, USER, url) is True
    assert not path.exists()


def test_release_removes_the_thumbnail_sidecar(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    thumb = media_dir / USER / "a.thumb.png"
    thumb.write_bytes(b"thumb")

    release_media_file(session, USER, url)
    assert not thumb.exists()


def test_release_keeps_a_file_another_note_still_uses(session, media_dir):
    """Copy-paste between notes produces two rows over one file on disk."""
    url = media_file(media_dir, USER, "a.png")
    note_a = make_note(session, note_id="note-a", content=blocks(("image", {"url": url})))
    note_b = make_note(session, note_id="note-b", content=blocks(("image", {"url": url})))
    sync_note_assets(session, note_a)
    sync_note_assets(session, note_b)

    row_a = session.exec(select(NoteAsset).where(NoteAsset.note_id == "note-a")).one()
    session.delete(row_a)
    session.commit()

    assert release_media_file(session, USER, url) is False
    assert (media_dir / USER / "a.png").exists()


def test_release_keeps_a_file_used_as_an_avatar(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    session.add(User(
        id=USER, username="u", email="u@example.test", hashed_password="x",
        avatar_url=url, created_at=datetime.now(timezone.utc),
    ))
    session.commit()

    assert release_media_file(session, USER, url) is False
    assert (media_dir / USER / "a.png").exists()


def test_release_keeps_a_file_used_as_a_theme_background(session, media_dir):
    url = media_file(media_dir, USER, "bg.png")
    session.add(Theme(id="t-1", name="Mine", user_id=USER, bg_image_url=url))
    session.commit()

    assert release_media_file(session, USER, url) is False


def test_release_never_touches_another_users_file(session, media_dir):
    """Content pasted from a shared note points into the author's media dir, not ours."""
    url = media_file(media_dir, OTHER_USER, "theirs.png")
    note = make_note(session, content=blocks(("image", {"url": url})))
    sync_note_assets(session, note)
    row = session.exec(select(NoteAsset)).one()
    session.delete(row)
    session.commit()

    assert release_media_file(session, USER, url) is False
    assert (media_dir / OTHER_USER / "theirs.png").exists()


def test_file_is_referenced_can_exclude_the_row_being_deleted(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session, content=blocks(("image", {"url": url})))
    sync_note_assets(session, note)
    row = session.exec(select(NoteAsset)).one()

    assert file_is_referenced(session, USER, "a.png") is True
    assert file_is_referenced(session, USER, "a.png", exclude_asset_id=row.id) is False


# ─── cascade ──────────────────────────────────────────────────────────────────


def test_purge_removes_rows_and_reclaims_files(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    note = make_note(session, content=blocks(("image", {"url": url})))
    sync_note_assets(session, note)

    assert purge_note_assets(session, note.id) == 1
    assert session.exec(select(NoteAsset)).all() == []
    assert not (media_dir / USER / "a.png").exists()


def test_purge_keeps_a_file_another_note_shares(session, media_dir):
    url = media_file(media_dir, USER, "a.png")
    note_a = make_note(session, note_id="note-a", content=blocks(("image", {"url": url})))
    note_b = make_note(session, note_id="note-b", content=blocks(("image", {"url": url})))
    sync_note_assets(session, note_a)
    sync_note_assets(session, note_b)

    purge_note_assets(session, "note-a")

    assert (media_dir / USER / "a.png").exists()
    assert len(session.exec(select(NoteAsset)).all()) == 1


# ─── presentation helpers ─────────────────────────────────────────────────────


@pytest.mark.parametrize("origin,in_note,expected", [
    (ORIGIN_EMBEDDED, True, "in_note"),
    (ORIGIN_REFERENCE, True, "in_note"),   # inserted after the fact — it's in the note now
    (ORIGIN_REFERENCE, False, "reference"),
    (ORIGIN_EXPORT, False, "export"),
    (ORIGIN_EMBEDDED, False, "detached"),
])
def test_role_reflects_origin_and_placement(origin, in_note, expected):
    asset = NoteAsset(id="a", user_id=USER, note_id="n", url="/media/u/a.png",
                      filename="a.png", origin=origin)
    assert _role_for(asset, in_note) == expected


@pytest.mark.parametrize("filename,kind,expected", [
    ("a.png", "images", True),
    ("a.pdf", "documents", True),
    ("a.md", "documents", True),
    ("a.csv", "documents", True),
    ("a.json", "data", True),
    ("a.mp4", "video", False),     # no provider takes video
    ("a.mp3", "audio", False),
    ("a.zip", "archives", False),
    ("a.docx", "documents", False),  # a document, but not one we can read as text
])
def test_ai_eligibility_matches_what_a_model_can_read(filename, kind, expected):
    assert _ai_eligible(filename, kind) is expected
