"""The theme a shared note is shown in (M7).

With Gecko Suite keeping the themes, the public page cannot ask the suite for the owner's
choice (nobody is signed in to ask as), so choosing the shared-note theme stores a copy of
its values in `shared_theme`. The older `shared_theme_id` still works.
"""

import json
from datetime import datetime

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine
from starlette.testclient import TestClient

from app.database import get_session
from app.main import app
from app.models import Category, Note, Theme, User, UserSetting

OCEAN = {"id": "suite-theme-1", "name": "Ocean", "mode": "dark", "bg_type": "gradient", "bg_color1": "#0a1f44",
         "bg_color2": "#112233", "bg_image_url": None, "bg_image_mode": "fill", "bg_blur": 0, "glass_opacity": 0.4,
         "glass_blur": 10, "shadow_size": 6, "shadow_blur": 14,
         # What the suite sends besides; the copy must not trust these.
         "scope": "user", "user_id": "someone-else", "editable": True}


@pytest.fixture
def client():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    now = datetime.utcnow()
    with Session(eng) as s:
        s.add(User(id="u1", username="gecko", email="g@example.test", hashed_password="", created_at=now))
        s.add(Category(id="c1", label="Notes", emoji="📝", color="#000"))
        s.add(Note(id="n1", title="Hello", content="[]", category_id="c1", tags="[]", created_at=now,
                   modified_at=now, user_id="u1", is_shared=True, share_token="tok"))
        s.add(Theme(id="notes-theme", name="Old", user_id="u1", mode="light"))
        s.commit()

    def override():
        with Session(eng) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app), eng
    app.dependency_overrides.clear()


def setting(eng, key, value):
    with Session(eng) as s:
        s.add(UserSetting(user_id="u1", key=key, value=json.dumps(value)))
        s.commit()


def test_a_snapshot_of_a_suite_theme_dresses_the_shared_note(client):
    http, eng = client
    setting(eng, "shared_theme_id", "notes-theme")  # the copy wins over the old way
    setting(eng, "shared_theme", OCEAN)
    theme = http.get("/api/shared/tok").json()["data"]["theme"]
    assert (theme["name"], theme["mode"], theme["glass_opacity"]) == ("Ocean", "dark", 0.4)
    assert (theme["user_id"], theme["is_global"]) == ("u1", False)


def test_the_older_theme_id_still_works(client):
    http, eng = client
    setting(eng, "shared_theme_id", "notes-theme")
    assert http.get("/api/shared/tok").json()["data"]["theme"]["name"] == "Old"


def test_a_broken_snapshot_shows_the_note_without_a_theme(client):
    http, eng = client
    setting(eng, "shared_theme", {"name": "Half"})
    res = http.get("/api/shared/tok")
    assert res.status_code == 200 and res.json()["data"]["theme"] is None
