"""Notes reading the person's GAM library: the `/api/gam` routes, copying a GAM file
into a note, and the assistant's GAM tools.

GAM is a fake httpx transport (`gam_client.TRANSPORT`), so these pin what Notes asks it
for — as the caller, with the caller's own token — and what Notes makes of the answers:
absolute addresses for the browser, sentences for failures, and nothing that can reach
an asset GAM would not show the person.
"""

import json
from datetime import datetime, timezone

import httpx
import pytest
from jose import jwt
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select
from starlette.testclient import TestClient

from app import asset_utils, gam_client
from app.assistant.executor import ExecContext, PlanExecutor
from app.assistant.plan_parse import validate_action
from app.assistant.tools import Proposal, handlers, tool_specs
from app.auth import create_access_token
from app.blocks.block_markdown import blocks_to_markdown
from app.database import get_session
from app.main import app
from app.models import Category, Note, NoteAsset, User
from app.routers import media

GAM = "http://gam.internal:8001"
PUBLIC = "https://assets.example.com"
USER = "user-1"


def gam_asset(asset_id="a1", **fields):
    raw = {
        "id": asset_id, "name": "Harbour at dusk", "asset_type": "image", "source": "upload",
        "original_name": "harbour.png", "mime_type": "image/png", "file_format": "png",
        "size_bytes": 12, "width": 640, "height": 480,
        "file_url": f"/media/{asset_id}.png?exp=1&sig=abc", "thumb_url": f"/media/{asset_id}.thumb.jpg?exp=1&sig=abc",
        "missing": False, "credit": "Photo: me",
    }
    raw.update(fields)
    return raw


class FakeGam:
    """GAM's answers, keyed by path. Every request is recorded with its headers."""

    def __init__(self):
        self.calls = []
        self.assets = {"a1": gam_asset()}
        self.files = {"/media/a1.png": b"\x89PNG fakebytes"}
        self.down = False
        self.uploads = []        # (filename, content_type, bytes) of each POST /api/assets
        self.upload_reply = None  # (status, json) to answer an upload with instead

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.down:
            raise httpx.ConnectError("refused")
        path = request.url.path
        if request.method == "POST" and path == "/api/assets":
            return self._upload(request)
        if path in self.files:
            return httpx.Response(200, content=self.files[path])
        if path == "/api/search":
            hits = [{"asset": a, "score": 1.0, "snippet": "the «harbour» at dusk"}
                    for a in self.assets.values() if request.url.params["q"].lower() in a["name"].lower()]
            return httpx.Response(200, json={"data": hits, "total": len(hits), "query": request.url.params["q"],
                                             "semantic": True})
        if path == "/api/assets":
            items = list(self.assets.values())
            return httpx.Response(200, json={"data": items, "total": len(items), "limit": 30, "offset": 0})
        parts = path.split("/")
        if len(parts) >= 4 and parts[1:3] == ["api", "assets"]:
            asset = self.assets.get(parts[3])
            if asset is None:
                return httpx.Response(404, json={"detail": {"code": "not_found", "message": "No such asset"}})
            if len(parts) == 4:
                return httpx.Response(200, json={"data": asset})
            if parts[4] == "text":
                return httpx.Response(200, json={"data": [
                    {"id": "p1", "idx": 0, "page_number": 1, "label": "Page 1", "text": "First page."},
                    {"id": "p2", "idx": 1, "page_number": 2, "label": "Page 2", "text": "Second page."}]})
            if parts[4] == "transcript":
                return httpx.Response(200, json={"data": {"asset_id": asset["id"], "segments": [
                    {"id": "s1", "idx": 0, "text": "Hello there.", "start_time": 0.0, "end_time": 1.0}]}})
        return httpx.Response(404, json={"detail": {"code": "not_found", "message": "No route"}})


    def _upload(self, request: httpx.Request) -> httpx.Response:
        # A multipart body is enough to read the one file back out of: boundary, headers, bytes.
        body = request.read()
        head, _, rest = body.partition(b"\r\n\r\n")
        name = head.split(b'filename="')[1].split(b'"')[0].decode()
        ctype = head.split(b"Content-Type: ")[1].split(b"\r\n")[0].decode() if b"Content-Type: " in head else None
        data = rest.rsplit(b"\r\n--", 1)[0]
        self.uploads.append((name, ctype, data))
        if self.upload_reply:
            return httpx.Response(self.upload_reply[0], json=self.upload_reply[1])
        asset = gam_asset(f"new{len(self.uploads)}", name=name, original_name=name, asset_type="video")
        return httpx.Response(201, json={"created": [asset], "rejected": []})


@pytest.fixture
def fake(monkeypatch):
    fake = FakeGam()
    monkeypatch.setenv("GAM_BASE_URL", GAM)
    monkeypatch.setenv("GAM_PUBLIC_URL", PUBLIC)
    monkeypatch.setattr(gam_client, "TRANSPORT", httpx.MockTransport(fake))
    return fake


@pytest.fixture
def engine():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        now = datetime.now(timezone.utc)
        s.add(User(id=USER, username="gecko", email="g@example.com", hashed_password="x",
                   email_verified=True, created_at=now))
        s.add(Category(id="cat-1", label="General", emoji="", color="#000000", is_default=True))
        s.add(Note(id="note-1", title="Trip", content=json.dumps([]), category_id="cat-1",
                   created_at=now, modified_at=now, user_id=USER))
        s.add(Note(id="theirs", title="Not yours", content="[]", category_id="cat-1",
                   created_at=now, modified_at=now, user_id="someone-else"))
        s.commit()
    return eng


@pytest.fixture
def media_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "MEDIA_DIR", str(tmp_path))
    monkeypatch.setattr(asset_utils, "MEDIA_DIR", str(tmp_path))
    from app.routers import assets
    monkeypatch.setattr(assets, "MEDIA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def token():
    return create_access_token({"sub": USER, "username": "gecko"})


@pytest.fixture
def client(engine, token):
    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app, headers={"Authorization": f"Bearer {token}"})
    app.dependency_overrides.clear()


# ─── routes ──────────────────────────────────────────────────────────────────


def test_status_is_off_without_a_base_url(client, monkeypatch):
    monkeypatch.delenv("GAM_BASE_URL", raising=False)
    response = client.get("/api/gam/status")
    assert response.json()["data"] == {"enabled": False, "public_url": None}


def test_status_names_the_public_address(client, fake):
    assert client.get("/api/gam/status").json()["data"] == {"enabled": True, "public_url": PUBLIC}


def test_a_route_without_gam_configured_says_so(client, monkeypatch):
    monkeypatch.delenv("GAM_BASE_URL", raising=False)
    response = client.get("/api/gam/assets/a1")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "gam_not_configured"


def test_an_asset_comes_back_with_absolute_addresses_and_no_internal_one(client, fake, token):
    response = client.get("/api/gam/assets/a1")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["file_url"] == f"{PUBLIC}/media/a1.png?exp=1&sig=abc"
    assert data["thumb_url"].startswith(PUBLIC + "/media/")
    assert data["page_url"] == f"{PUBLIC}/a/a1"
    assert "file_url_internal" not in data
    # As the caller, with the caller's own token, at the internal address.
    assert fake.calls[0].headers["Authorization"] == f"Bearer {token}"
    assert str(fake.calls[0].url).startswith(GAM)


def test_an_asset_gam_does_not_show_is_a_404(client, fake):
    response = client.get("/api/gam/assets/nope")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "gam_asset_not_found"


def test_gam_down_is_a_502_with_a_sentence(client, fake):
    fake.down = True
    response = client.get("/api/gam/search?q=harbour")
    assert response.status_code == 502
    assert response.json()["detail"] == {"code": "gam_unavailable",
                                         "message": "Could not reach the asset library"}


def test_gam_refusing_the_session_names_the_likely_cause(client, fake, monkeypatch):
    monkeypatch.setattr(gam_client, "TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(401)))
    response = client.get("/api/gam/assets/a1")
    assert response.status_code == 502
    assert "JWT_SECRET_KEY" in response.json()["detail"]["message"]


def test_search_passes_the_query_and_type_through(client, fake):
    response = client.get("/api/gam/search?q=harbour&asset_type=image")
    body = response.json()
    assert [h["asset"]["id"] for h in body["data"]] == ["a1"]
    assert body["semantic"] is True
    assert fake.calls[0].url.path == "/api/search"
    assert fake.calls[0].url.params["asset_type"] == "image"


def test_search_with_no_query_lists_the_library(client, fake):
    body = client.get("/api/gam/search").json()
    assert [h["asset"]["id"] for h in body["data"]] == ["a1"]
    assert fake.calls[0].url.path == "/api/assets"


def test_search_refuses_an_unknown_type(client, fake):
    assert client.get("/api/gam/search?q=x&asset_type=spreadsheet").status_code == 400


def test_an_unauthenticated_request_never_reaches_gam(engine, fake):
    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        assert TestClient(app).get("/api/gam/assets/a1").status_code == 401
    finally:
        app.dependency_overrides.clear()
    assert fake.calls == []


# ─── copying into a note ─────────────────────────────────────────────────────


def test_copy_writes_the_file_and_registers_it(client, fake, media_dir, engine):
    response = client.post("/api/notes/note-1/assets/from-gam", json={"asset_id": "a1"})
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["url"].startswith(f"/media/{USER}/") and data["url"].endswith(".png")
    assert (media_dir / USER / data["filename"]).read_bytes() == b"\x89PNG fakebytes"
    assert data["origin"] == "embedded"
    assert data["original_name"] == "harbour.png"
    with Session(engine) as s:
        row = s.exec(select(NoteAsset)).one()
        assert row.description == f"Copied from GAM: {PUBLIC}/a/a1"


def test_copy_into_someone_elses_note_is_refused(client, fake, media_dir):
    response = client.post("/api/notes/theirs/assets/from-gam", json={"asset_id": "a1"})
    assert response.status_code == 404
    assert not any(c.url.path.startswith("/media") for c in fake.calls)


def test_copy_over_the_cap_leaves_nothing_behind(client, fake, media_dir, monkeypatch):
    monkeypatch.setenv("GAM_COPY_MAX_BYTES", "4")
    response = client.post("/api/notes/note-1/assets/from-gam", json={"asset_id": "a1"})
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "gam_media_too_large"
    assert list((media_dir / USER).iterdir()) == []


def test_copy_of_an_asset_whose_file_is_gone_says_so(client, fake, media_dir):
    fake.assets["a1"]["missing"] = True
    response = client.post("/api/notes/note-1/assets/from-gam", json={"asset_id": "a1"})
    assert response.status_code == 409


def test_copy_uses_the_format_when_the_name_has_no_extension(client, fake, media_dir):
    fake.assets["a1"].update(original_name=None, file_format="png")
    data = client.post("/api/notes/note-1/assets/from-gam", json={"asset_id": "a1"}).json()["data"]
    assert data["filename"].endswith(".png")


# ─── the assistant ───────────────────────────────────────────────────────────


def _names(specs):
    return [s["name"] for s in specs]


def test_gam_tools_are_offered_only_when_connected():
    assert {"search_gam", "read_gam_asset", "insert_gam_asset"} <= set(_names(tool_specs(web_search=False, gam=True)))
    assert not {"search_gam", "read_gam_asset", "insert_gam_asset"} & set(_names(tool_specs(web_search=False)))


def _tools(engine, proposal=None):
    proposal = proposal or Proposal({"valid_note_ids": ["note-1"]}, {})
    session = Session(engine)
    return proposal, handlers(session, USER, proposal, retrieval=None, web_search=False, gam=True)


def test_search_gam_lists_ids_the_model_can_use(engine, fake):
    proposal, table = _tools(engine)
    text = table["search_gam"]({"query": "harbour"})
    assert "Harbour at dusk — image" in text and "id a1" in text
    assert proposal.label_map["a1"] == "Harbour at dusk"
    # The worker's token: this user, short-lived, and nobody else's.
    sent = fake.calls[0].headers["Authorization"].removeprefix("Bearer ")
    claims = jwt.get_unverified_claims(sent)
    assert claims["sub"] == USER
    assert claims["exp"] - datetime.now(timezone.utc).timestamp() <= gam_client.WORKER_TOKEN_MINUTES * 60 + 5


def test_read_gam_asset_returns_a_documents_text(engine, fake):
    fake.assets["d1"] = gam_asset("d1", name="Report", asset_type="document")
    _, table = _tools(engine)
    text = table["read_gam_asset"]({"assetId": "d1"})
    assert "[Page 1]\nFirst page." in text and "Second page." in text


def test_read_gam_asset_returns_what_is_said_in_a_video(engine, fake):
    fake.assets["v1"] = gam_asset("v1", name="Interview", asset_type="video", duration_seconds=60)
    _, table = _tools(engine)
    assert "[0 s] Hello there." in table["read_gam_asset"]({"assetId": "v1"})


def test_gam_down_is_a_tool_result_not_a_failed_turn(engine, fake):
    fake.down = True
    _, table = _tools(engine)
    text, is_error = table["search_gam"]({"query": "harbour"})
    assert is_error and "could not be searched" in text


def test_insert_gam_asset_is_recorded_not_applied(engine, fake):
    proposal, table = _tools(engine)
    table["insert_gam_asset"]({"noteId": "note-1", "assetId": "a1", "position": "end"})
    assert proposal.actions == [{"type": "insert_gam_asset", "noteId": "note-1", "assetId": "a1", "position": "end"}]
    with Session(engine) as s:
        assert s.get(Note, "note-1").content == "[]"


def _executor(session):
    return PlanExecutor(session, ExecContext(user_id=USER, current_note_id="note-1",
                                             default_category_id="cat-1", valid_note_ids={"note-1"}))


def test_applying_insert_gam_asset_adds_a_live_block(engine, fake):
    with Session(engine) as s:
        action = validate_action({"type": "insert_gam_asset", "noteId": "note-1", "assetId": "a1"})
        [result] = _executor(s).run({"actions": [action]})
        assert result.ok, result.message
        s.expire_all()
        [block] = json.loads(s.get(Note, "note-1").content)
    assert block["type"] == "gamAsset"
    assert block["props"] == {"assetId": "a1", "name": "Harbour at dusk", "assetType": "image"}
    # A live block stores no address: GAM's expire.
    assert "url" not in json.dumps(block["props"])


def test_applying_insert_gam_asset_skips_an_asset_gam_does_not_show(engine, fake):
    with Session(engine) as s:
        [result] = _executor(s).run({"actions": [{"type": "insert_gam_asset", "noteId": "note-1", "assetId": "nope"}]})
        assert not result.ok and "not in your library" in result.message
        s.expire_all()
        assert s.get(Note, "note-1").content == "[]"


def test_a_gam_block_reads_as_a_labelled_line_for_the_model():
    markdown = blocks_to_markdown([{"id": "b", "type": "gamAsset",
                                    "props": {"assetId": "a1", "name": "Harbour", "assetType": "image"}}])
    assert markdown.strip() == "[GAM image “Harbour” — asset id a1]"


# ─── copying a note's files into GAM ─────────────────────────────────────────


def _note_with_files(engine, media_dir, *files):
    """Give note-1 a block per (block type, url, name) and put bytes on disk for each."""
    blocks = []
    for block_type, filename, name in files:
        (media_dir / USER).mkdir(exist_ok=True)
        (media_dir / USER / filename).write_bytes(b"bytes of " + filename.encode())
        blocks.append({"id": filename, "type": block_type, "props": {"url": f"/media/{USER}/{filename}", "name": name}, "children": []})
    blocks.append({"id": "g", "type": "gamAsset", "props": {"assetId": "a1", "name": "Harbour", "assetType": "image"}, "children": []})
    with Session(engine) as s:
        note = s.get(Note, "note-1")
        note.content = json.dumps(blocks)
        s.add(note)
        s.commit()


def test_add_to_gam_tools_are_offered_only_when_connected():
    assert {"list_note_media", "add_to_gam"} <= set(_names(tool_specs(web_search=False, gam=True)))
    assert not {"list_note_media", "add_to_gam"} & set(_names(tool_specs(web_search=False)))


def test_list_note_media_numbers_files_in_order_and_skips_gam_blocks(engine, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"), ("image", "i1.png", "Chart"),
                     ("videoFile", "v2.mp4", "Outtake"))
    _, table = _tools(engine)
    lines = table["list_note_media"]({"noteId": "note-1"}).splitlines()
    assert len(lines) == 3  # the gamAsset block is already in GAM
    assert lines[0].startswith("1. video “Interview”") and lines[0].endswith(f"/media/{USER}/v1.mp4")
    assert lines[1].startswith("2. images “Chart”") and lines[2].startswith("3. video “Outtake”")


def test_list_note_media_refuses_a_note_that_is_not_theirs(engine, media_dir):
    _, table = _tools(engine)
    text, is_error = table["list_note_media"]({"noteId": "theirs"})
    assert is_error and "no note" in text


def test_list_note_media_leaves_out_another_users_path(engine, media_dir):
    with Session(engine) as s:
        note = s.get(Note, "note-1")
        note.content = json.dumps([{"id": "x", "type": "videoFile", "props": {"url": "/media/someone-else/v.mp4", "name": "Theirs"}}])
        s.add(note)
        s.commit()
    _, table = _tools(engine)
    assert "no embedded files" in table["list_note_media"]({"noteId": "note-1"})


def test_add_to_gam_is_recorded_not_applied(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"))
    proposal, table = _tools(engine)
    table["add_to_gam"]({"noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4", f"/media/{USER}/v1.mp4"]})
    assert proposal.actions == [{"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4"]}]
    assert fake.uploads == []
    assert validate_action({"type": "add_to_gam", "noteId": "note-1", "urls": []}) is None


def test_applying_add_to_gam_uploads_as_the_owner_and_swaps_the_block(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"))
    with Session(engine) as s:
        action = validate_action({"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4"]})
        [result] = _executor(s).run({"actions": [action]})
        assert result.ok, result.message
        assert "Interview.mp4" in result.message and f"{PUBLIC}/a/new1" in result.message
        assert result.notes_changed and result.touched_current_note
        s.expire_all()
        video, existing = json.loads(s.get(Note, "note-1").content)
    # Same block (id, place), now live; the one already from GAM is untouched.
    assert video["id"] == "v1.mp4" and video["type"] == "gamAsset"
    assert video["props"] == {"assetId": "new1", "name": "Interview.mp4", "assetType": "video"}
    assert existing["props"]["assetId"] == "a1"
    [(name, ctype, data)] = fake.uploads
    assert name == "Interview.mp4" and ctype == "video/mp4" and data == b"bytes of v1.mp4"
    post = [c for c in fake.calls if c.method == "POST"][0]
    assert jwt.get_unverified_claims(post.headers["Authorization"].removeprefix("Bearer "))["sub"] == USER


def test_applying_add_to_gam_refuses_a_path_that_is_not_in_the_note(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"))
    (media_dir / USER / "secret.mp4").write_bytes(b"not in the note")
    with Session(engine) as s:
        [result] = _executor(s).run({"actions": [
            {"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/secret.mp4", "/media/someone-else/v.mp4"]}]})
    assert not result.ok and "not a file in this note" in result.message
    assert fake.uploads == []


def test_applying_add_to_gam_reports_one_failure_and_sends_the_rest(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"), ("videoFile", "v2.mp4", "Gone"))
    (media_dir / USER / "v2.mp4").unlink()
    with Session(engine) as s:
        [result] = _executor(s).run({"actions": [
            {"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v2.mp4", f"/media/{USER}/v1.mp4"]}]})
    assert result.ok and "Interview.mp4" in result.message and "“Gone” is missing from disk" in result.message
    assert len(fake.uploads) == 1


def test_applying_add_to_gam_says_why_gam_refused(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"))
    fake.upload_reply = (400, {"detail": {"code": "unsupported_type", "message": "That file type is not supported"}})
    with Session(engine) as s:
        [result] = _executor(s).run({"actions": [{"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4"]}]})
    assert not result.ok and "not supported" in result.message


def test_applying_add_to_gam_with_gam_down_is_a_skipped_step(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"))
    fake.down = True
    with Session(engine) as s:
        [result] = _executor(s).run({"actions": [{"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4"]}]})
    assert not result.ok and "Could not reach" in result.message


def test_a_file_over_the_cap_is_not_sent(engine, fake, media_dir, monkeypatch):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"))
    monkeypatch.setenv("GAM_UPLOAD_MAX_BYTES", "4")
    with Session(engine) as s:
        [result] = _executor(s).run({"actions": [{"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4"]}]})
    assert not result.ok and "too large" in result.message
    assert fake.uploads == []


def test_only_the_files_gam_accepted_are_swapped(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"), ("videoFile", "v2.mp4", "Outtake"))
    (media_dir / USER / "v2.mp4").unlink()
    with Session(engine) as s:
        [result] = _executor(s).run({"actions": [
            {"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4", f"/media/{USER}/v2.mp4"]}]})
        assert result.ok
        s.expire_all()
        types = [b["type"] for b in json.loads(s.get(Note, "note-1").content)]
    assert types == ["gamAsset", "videoFile", "gamAsset"]  # the missing file keeps its block


def test_a_rejected_upload_leaves_the_note_untouched(engine, fake, media_dir):
    _note_with_files(engine, media_dir, ("videoFile", "v1.mp4", "Interview"))
    fake.upload_reply = (400, {"detail": {"code": "unsupported_type", "message": "That file type is not supported"}})
    with Session(engine) as s:
        before = s.get(Note, "note-1").content
        [result] = _executor(s).run({"actions": [{"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4"]}]})
        assert not result.ok and not result.notes_changed
        s.expire_all()
        assert s.get(Note, "note-1").content == before


def test_a_nested_block_is_swapped_and_keeps_its_children(engine, fake, media_dir):
    (media_dir / USER).mkdir(exist_ok=True)
    (media_dir / USER / "v1.mp4").write_bytes(b"x")
    inner = {"id": "inner", "type": "videoFile", "props": {"url": f"/media/{USER}/v1.mp4", "name": "Clip"}, "children": []}
    with Session(engine) as s:
        note = s.get(Note, "note-1")
        note.content = json.dumps([{"id": "outer", "type": "paragraph", "props": {}, "children": [inner]}])
        s.add(note)
        s.commit()
        [result] = _executor(s).run({"actions": [{"type": "add_to_gam", "noteId": "note-1", "urls": [f"/media/{USER}/v1.mp4"]}]})
        assert result.ok, result.message
        s.expire_all()
        [outer] = json.loads(s.get(Note, "note-1").content)
    assert outer["children"][0]["type"] == "gamAsset" and outer["children"][0]["id"] == "inner"
