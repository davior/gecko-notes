"""Notes written by another app: `POST /api/notes/from-markdown`.

GAM's and Video Creator's assistants propose a note; when the person applies it, that
app sends the Markdown here with the person's own token. These run the real app and its
real auth middleware, so "a token another app forwards is accepted" is tested as such.
"""

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select
from starlette.testclient import TestClient

from app.auth import create_access_token
from app.database import get_session
from app.main import app
from app.models import Category, Folder, NoteVersion, User

USER = "user-1"

REPORT = """# Dogs in the library

Three videos are about dogs.

## The videos

- [Puppy training](https://gam.test/a/v1): a trainer on recall.
- [Sheepdog trials](https://gam.test/a/v2)

| Video | Length |
| --- | --- |
| Puppy training | 12:00 |
"""


@pytest.fixture
def engine():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        s.add(Category(id="c-other", label="Other", emoji="x", color="#000", sort_order=0))
        s.add(Category(id="c-default", label="Notes", emoji="x", color="#000",
                       is_default=True, sort_order=5))
        s.add(User(id=USER, username="gecko", email="g@example.com", hashed_password="x",
                   email_verified=True, created_at=datetime.now(timezone.utc)))
        s.commit()
    return eng


@pytest.fixture
def client(engine):
    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # Not a context manager: that would run the real lifespan against the real database.
    yield TestClient(app, base_url="https://testserver")
    app.dependency_overrides.clear()


def headers(user_id=USER):
    # What GAM or Video Creator forwards: the person's own token, signed with the shared
    # secret, sent from another server with no Origin and no cookie.
    return {"Authorization": f"Bearer {create_access_token({'sub': user_id, 'username': 'gecko'})}"}


def post(client, **body):
    return client.post("/api/notes/from-markdown", json={"markdown": REPORT, **body},
                       headers=headers())


def test_markdown_becomes_blocks_in_the_apps_folder(client, engine):
    res = post(client, title="Dogs", source_app="gam")
    assert res.status_code == 201, res.text
    note = res.json()["data"]
    blocks = json.loads(note["content"])
    kinds = [b["type"] for b in blocks]
    assert kinds[0] == "heading" and "bulletListItem" in kinds and "table" in kinds
    link = next(c for b in blocks if b["type"] == "bulletListItem" for c in b["content"]
                if c["type"] == "link")
    assert link["href"] == "https://gam.test/a/v1"

    assert note["category_id"] == "c-default"
    assert "gam" in note["tags"]
    with Session(engine) as s:
        folder = s.get(Folder, note["folder_id"])
        assert folder.name == "From GAM" and folder.parent_folder_id is None
        assert folder.user_id == USER
        # A history from the start.
        assert len(s.exec(select(NoteVersion).where(NoteVersion.note_id == note["id"])).all()) == 1


def test_the_folder_is_made_once_and_reused_whatever_its_case(client, engine):
    first = post(client, source_app="gvc").json()["data"]
    second = post(client, folder_name="from video creator").json()["data"]
    assert first["folder_id"] == second["folder_id"]
    assert "video-creator" in first["tags"]
    with Session(engine) as s:
        assert len(s.exec(select(Folder)).all()) == 1


def test_the_archive_bin_and_a_saved_search_are_never_the_folder(client, engine):
    now = datetime.now(timezone.utc)
    with Session(engine) as s:
        s.add(Folder(id="bin", name="From GAM", user_id=USER, system_key="archive",
                     created_at=now, modified_at=now))
        s.add(Folder(id="search", name="from gam", user_id=USER, search_query="dogs",
                     created_at=now, modified_at=now))
        s.commit()
    note = post(client, source_app="gam").json()["data"]
    assert note["folder_id"] not in ("bin", "search")


def test_a_named_folder_and_no_app_and_the_title_from_the_first_heading(client):
    named = post(client, folder_name="Research").json()["data"]
    plain = client.post("/api/notes/from-markdown", json={"markdown": "Just a line."},
                        headers=headers()).json()["data"]
    assert named["title"] == "Dogs in the library"
    assert plain["folder_id"] is None and plain["title"] == "Untitled"
    assert named["folder_id"] is not None


def test_empty_text_is_refused_and_so_is_no_token(client):
    empty = client.post("/api/notes/from-markdown", json={"markdown": "  \n"}, headers=headers())
    assert empty.status_code == 400
    assert client.post("/api/notes/from-markdown", json={"markdown": "x"}).status_code == 401
    bad_app = client.post("/api/notes/from-markdown", json={"markdown": "x", "source_app": "evil"},
                          headers=headers())
    assert bad_app.status_code == 422


def test_it_is_the_callers_note(client):
    note = post(client).json()["data"]
    assert client.get(f"/api/notes/{note['id']}", headers=headers()).status_code == 200
    assert client.get(f"/api/notes/{note['id']}", headers=headers("someone-else")).status_code == 404
