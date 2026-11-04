"""AI chat through Gecko Suite (`AI_BACKEND=suite`) instead of straight to the vendor.

Runs Notes' real proxy routes with the real auth middleware. The suite is a fake
transport, so these pin what Notes sends it (the vendor and model in place of the local
provider id, as Notes, on the user's behalf) and that what comes back reaches the
caller in the shape the route has always returned.
"""

import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select
from starlette.testclient import TestClient

import app.suite as suite
from app.auth import create_access_token
from app.database import get_session
from app.main import app
from app.models import AIProvider, UsageEvent, User

BASE = "https://suite.test"
MESSAGES = [{"role": "user", "content": "Hi"}]


@pytest.fixture
def engine():
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        s.add(User(id="user-1", username="gecko", email="g@example.com", hashed_password="x",
                   email_verified=True, created_at=datetime.now(timezone.utc)))
        s.add(AIProvider(id="p-claude", name="Claude", provider_type="anthropic", api_key="not-used",
                         model="claude-opus-5-5", user_id="user-1"))
        s.add(AIProvider(id="p-gpt", name="GPT", provider_type="openai", api_key="not-used",
                         model="gpt-4.1-mini", user_id="user-1"))
        s.add(AIProvider(id="p-local", name="Local", provider_type="ollama", api_key="",
                         model="llama3", user_id="user-1"))
        s.add(AIProvider(id="p-other", name="Theirs", provider_type="anthropic", api_key="x",
                         model="claude-opus-5-5", user_id="someone-else"))
        s.commit()
    return eng


@pytest.fixture
def calls():
    return []


@pytest.fixture
def respond():
    """Set `respond.fn` to the fake suite's answer to a request."""
    class Box:
        fn = staticmethod(lambda request: httpx.Response(200, json={}))
    return Box


@pytest.fixture
def client(engine, calls, respond, monkeypatch):
    def override():
        with Session(engine) as session:
            yield session

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return respond.fn(request)

    app.dependency_overrides[get_session] = override
    monkeypatch.setenv("AI_BACKEND", "suite")
    monkeypatch.setenv("SUITE_BASE_URL", BASE)
    monkeypatch.setenv("SUITE_APP_SECRET", "app-secret")
    monkeypatch.setattr(suite, "TRANSPORT", httpx.MockTransport(handler))
    token = create_access_token({"sub": "user-1", "username": "gecko"})
    test_client = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    yield test_client
    app.dependency_overrides.clear()


def _frames(text):
    out = []
    for chunk in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in chunk.split("\n"))
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def _sse(*frames):
    body = "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in frames)
    return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})


MESSAGE = {"role": "assistant", "content": [{"type": "text", "text": "Hello"}], "stop_reason": "end_turn"}


def test_a_blocking_call_is_forwarded_as_notes_for_the_user(client, calls, respond, engine):
    respond.fn = lambda r: httpx.Response(200, json=MESSAGE)
    res = client.post("/api/settings/ai-providers/proxy/anthropic", json={
        "provider_id": "p-claude", "model": "claude-opus-5-5", "max_tokens": 300, "messages": MESSAGES,
        "system": [{"type": "text", "text": "Be brief", "cache_control": {"type": "ephemeral"}}],
        "prefill": "{"})
    assert res.status_code == 200 and res.json() == MESSAGE

    [request] = calls
    assert str(request.url) == f"{BASE}/api/v1/ai/proxy/anthropic"
    assert request.headers["x-gecko-app"] == "notes"
    assert request.headers["x-gecko-app-secret"] == "app-secret"
    assert request.headers["x-on-behalf-of"] == "user-1"
    sent = json.loads(request.content)
    # The vendor in place of the local id; the key never leaves Notes for the suite.
    assert sent["vendor"] == "anthropic" and "provider_id" not in sent and "tools" not in sent
    assert sent["system"][0]["cache_control"] == {"type": "ephemeral"} and sent["prefill"] == "{"
    assert "not-used" not in request.content.decode()
    # The suite counts the spend; Notes writes nothing.
    with Session(engine) as s:
        assert s.exec(select(UsageEvent)).all() == []


def test_openai_and_ollama_blocking_calls(client, calls, respond):
    reply = {"choices": [{"message": {"role": "assistant", "content": "hi"}}], "usage": {"prompt_tokens": 3}}
    respond.fn = lambda r: httpx.Response(200, json=reply)
    res = client.post("/api/settings/ai-providers/proxy/openai", json={
        "provider_id": "p-gpt", "model": "gpt-4.1-mini", "max_tokens": 50, "messages": MESSAGES})
    assert res.json() == reply
    assert json.loads(calls[-1].content)["vendor"] == "openai"

    respond.fn = lambda r: httpx.Response(200, json={"message": {"content": "yo"}, "done": True})
    res = client.post("/api/settings/ai-providers/proxy/ollama", json={
        "provider_id": "p-local", "model": "llama3", "messages": MESSAGES})
    assert res.json()["message"]["content"] == "yo"
    sent = json.loads(calls[-1].content)
    assert str(calls[-1].url).endswith("/proxy/ollama") and sent["vendor"] == "ollama"
    assert "max_tokens" not in sent  # unset stays unset


def test_a_stream_is_passed_through_frame_for_frame(client, calls, respond):
    respond.fn = lambda r: _sse(("delta", {"text": "He"}), ("delta", {"text": "llo"}), ("final", MESSAGE))
    res = client.post("/api/settings/ai-providers/proxy/anthropic/stream", json={
        "provider_id": "p-claude", "model": "claude-opus-5-5", "max_tokens": 300, "messages": MESSAGES})
    assert res.headers["content-type"].startswith("text/event-stream")
    assert _frames(res.text) == [("delta", {"text": "He"}), ("delta", {"text": "llo"}), ("final", MESSAGE)]
    assert str(calls[-1].url) == f"{BASE}/api/v1/ai/proxy/anthropic/stream"


def test_the_suite_refusing_before_streaming_is_an_error_frame(client, respond):
    respond.fn = lambda r: httpx.Response(409, json={"detail": {
        "code": "ai_not_configured", "message": "No anthropic provider with a key is set up in Gecko Suite."}})
    res = client.post("/api/settings/ai-providers/proxy/anthropic/stream", json={
        "provider_id": "p-claude", "model": "claude-opus-5-5", "max_tokens": 300, "messages": MESSAGES})
    assert res.status_code == 200
    [(kind, data)] = _frames(res.text)
    assert kind == "error" and data["code"] == "ai_not_configured"


def test_a_blocking_refusal_keeps_the_suites_status_and_detail(client, respond):
    respond.fn = lambda r: httpx.Response(409, json={"detail": {"code": "ai_not_configured", "message": "Set one up."}})
    res = client.post("/api/settings/ai-providers/proxy/openai", json={
        "provider_id": "p-gpt", "model": "gpt-4.1-mini", "max_tokens": 50, "messages": MESSAGES})
    assert res.status_code == 409 and res.json()["detail"] == {"code": "ai_not_configured", "message": "Set one up."}


def test_a_suite_that_is_down_says_so_and_nothing_else_breaks(client, respond):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)
    respond.fn = refuse
    res = client.post("/api/settings/ai-providers/proxy/anthropic", json={
        "provider_id": "p-claude", "model": "claude-opus-5-5", "max_tokens": 300, "messages": MESSAGES})
    assert res.status_code == 503 and res.json()["detail"]["code"] == "suite_unavailable"

    res = client.post("/api/settings/ai-providers/proxy/anthropic/stream", json={
        "provider_id": "p-claude", "model": "claude-opus-5-5", "max_tokens": 300, "messages": MESSAGES})
    [(kind, data)] = _frames(res.text)
    assert kind == "error" and data["code"] == "suite_unavailable"


def test_the_local_ownership_and_protocol_checks_still_apply(client, calls):
    base = {"model": "m", "max_tokens": 10, "messages": MESSAGES}
    # Someone else's provider row is a 404, not a spend on their vendor.
    assert client.post("/api/settings/ai-providers/proxy/anthropic",
                       json={"provider_id": "p-other", **base}).status_code == 404
    # An OpenAI provider on the Anthropic route is refused before the suite is asked.
    assert client.post("/api/settings/ai-providers/proxy/anthropic",
                       json={"provider_id": "p-gpt", **base}).status_code == 400
    assert calls == []


def test_a_worker_watching_a_call_gets_deltas_and_the_same_dict(engine, calls, respond, monkeypatch):
    from app.routers.settings import AnthropicProxyRequest, anthropic_completion

    monkeypatch.setenv("AI_BACKEND", "suite")
    monkeypatch.setenv("SUITE_BASE_URL", BASE)
    monkeypatch.setenv("SUITE_APP_SECRET", "app-secret")
    monkeypatch.setattr(suite, "TRANSPORT", httpx.MockTransport(lambda r: (calls.append(r), respond.fn(r))[1]))
    respond.fn = lambda r: _sse(("delta", {"text": "He"}), ("delta", {"text": "llo"}), ("final", MESSAGE))
    seen = []
    with Session(engine) as session:
        data = asyncio.run(anthropic_completion(
            AnthropicProxyRequest(provider_id="p-claude", model="claude-opus-5-5", max_tokens=100, messages=MESSAGES),
            "user-1", session, on_delta=seen.append))
    assert data == MESSAGE and seen == ["He", "llo"]
    assert str(calls[-1].url).endswith("/proxy/anthropic/stream")
    assert calls[-1].headers["x-on-behalf-of"] == "user-1"


def test_local_mode_never_calls_the_suite(client, calls, monkeypatch):
    monkeypatch.setenv("AI_BACKEND", "local")
    # No vendor is reachable in a test; what matters is the suite was not asked.
    client.post("/api/settings/ai-providers/proxy/openai", json={
        "provider_id": "p-gpt", "model": "gpt-4.1-mini", "max_tokens": 5, "messages": MESSAGES})
    assert calls == []


def test_suite_mode_without_its_secret_refuses_to_start(monkeypatch):
    monkeypatch.setenv("AI_BACKEND", "suite")
    monkeypatch.delenv("SUITE_APP_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="SUITE_APP_SECRET"):
        suite.validate()
    monkeypatch.setenv("AI_BACKEND", "nonsense")
    with pytest.raises(RuntimeError, match="local"):
        suite.validate()
    monkeypatch.setenv("AI_BACKEND", "local")
    suite.validate()


# ─── web search (SN-2a) ──────────────────────────────────────────────────────

SEARCH_DATA = {"data": {"provider": "My Brave", "kind": "brave", "results": [
    {"title": "Gecko", "url": "https://example.com/g", "snippet": "A lizard", "published": None}]}}


def test_a_search_goes_to_the_suite_and_keeps_notes_response_shape(client, calls, respond, engine):
    respond.fn = lambda r: httpx.Response(200, json=SEARCH_DATA)
    res = client.post("/api/search/web", json={"query": " geckos ", "count": 50})
    assert res.status_code == 200, res.text
    assert res.json() == {"provider": "brave", "provider_label": "My Brave", "query": "geckos",
                          "results": SEARCH_DATA["data"]["results"]}
    [request] = calls
    assert str(request.url) == f"{BASE}/api/v1/search/web"
    assert request.headers["x-gecko-app"] == "notes" and request.headers["x-on-behalf-of"] == "user-1"
    assert json.loads(request.content) == {"query": "geckos", "count": 10}  # clamped to the suite's cap
    with Session(engine) as s:
        assert s.exec(select(UsageEvent)).all() == []  # the suite counts it


def test_a_failed_search_keeps_the_suites_reason(client, respond):
    respond.fn = lambda r: httpx.Response(502, json={"detail": {"code": "search_timeout", "message": "Brave did not respond."}})
    res = client.post("/api/search/web", json={"query": "geckos"})
    assert res.status_code == 502 and res.json()["detail"] == {"code": "search_timeout", "message": "Brave did not respond."}


def test_an_empty_query_is_refused_without_asking_the_suite(client, calls):
    assert client.post("/api/search/web", json={"query": "  "}).status_code == 400
    assert calls == []


def test_the_search_test_button_tests_the_suite_path(client, calls, respond):
    respond.fn = lambda r: httpx.Response(200, json=SEARCH_DATA)
    res = client.post("/api/settings/web-search/test", json={})
    assert res.json()["success"] is True and "Gecko Suite" in res.json()["message"]
    assert str(calls[-1].url).endswith("/search/web")
    respond.fn = lambda r: httpx.Response(200, json={"data": {"provider": "DuckDuckGo", "kind": "duckduckgo", "results": []}})
    assert client.post("/api/settings/web-search/test", json={}).json()["success"] is False


# ─── speech (SN-2b) ──────────────────────────────────────────────────────────

AUDIO = b"ID3" + b"x" * 400


def _speech(model="model-1", voice="Rex"):
    return httpx.Response(200, content=AUDIO, headers={
        "content-type": "audio/mpeg", "X-Speech-Model": model, "X-Speech-Voice": voice,
        "X-Speech-Provider": "fal", "X-Speech-Cached": "false"})


def test_read_aloud_goes_to_the_suite_and_writes_nothing_locally(client, calls, respond, engine):
    respond.fn = lambda r: _speech()
    res = client.post("/api/settings/speech/tts", json={"text": " Hello there ", "model": "Rex"})
    assert res.status_code == 200 and res.content == AUDIO and res.headers["content-type"] == "audio/mpeg"
    [request] = calls
    assert str(request.url) == f"{BASE}/api/v1/ai/speech/tts"
    assert request.headers["x-on-behalf-of"] == "user-1"
    assert json.loads(request.content) == {"text": "Hello there", "voice": "Rex"}
    with Session(engine) as s:
        assert s.exec(select(UsageEvent)).all() == []


def test_a_render_pin_is_the_suites_model_and_comes_back_each_time(client, calls, respond):
    respond.fn = lambda r: _speech(model="model-7", voice="Rex")
    first = client.post("/api/settings/speech/tts", json={"text": "One.", "provider": "auto", "voice": None})
    assert first.headers["x-speech-provider"] == "model-7" and first.headers["x-speech-voice"] == "Rex"
    assert "model_ref" not in json.loads(calls[-1].content)  # "auto" pins nothing

    client.post("/api/settings/speech/tts", json={
        "text": "Two.", "provider": first.headers["x-speech-provider"], "voice": first.headers["x-speech-voice"]})
    assert json.loads(calls[-1].content) == {"text": "Two.", "voice": "Rex", "model_ref": "model-7"}


def test_a_pinned_model_failing_fails_the_call_and_never_switches_engine(client, calls, respond):
    respond.fn = lambda r: httpx.Response(502, json={"detail": {"code": "upstream_error", "message": "fal is down"}})
    res = client.post("/api/settings/speech/tts", json={"text": "Two.", "provider": "model-7", "voice": "Rex"})
    assert res.status_code == 502 and res.json()["detail"]["code"] == "upstream_error"
    assert len(calls) == 1


def test_narrating_a_long_text_reads_every_chunk_through_the_suite(client, calls, respond):
    respond.fn = lambda r: _speech()
    text = ("Sentence number one is here. " * 80).strip()  # over one 1500-character chunk
    res = client.post("/api/settings/speech/narrate", json={"text": text, "model": "Rex"})
    assert res.status_code == 200 and res.headers["content-type"] == "audio/mpeg"
    assert len(calls) >= 2 and all(str(c.url).endswith("/ai/speech/tts") for c in calls)


def test_the_local_path_still_checks_the_provider_name(client, monkeypatch):
    monkeypatch.setenv("AI_BACKEND", "local")
    res = client.post("/api/settings/speech/tts", json={"text": "Hi", "provider": "model-7"})
    assert res.status_code == 422


def test_a_dictation_upload_is_transcribed_by_the_suite(client, calls, respond):
    segments = [{"text": "hello", "start": 0, "end": 1, "words": []}, {"text": "world", "start": 1, "end": 2, "words": []}]
    respond.fn = lambda r: httpx.Response(200, json={"data": {"segments": segments, "language": "en", "model": "nova-3",
                                                              "duration_seconds": 2, "usage_event_id": "u1"}})
    res = client.post("/api/settings/speech/transcribe", files={"file": ("rec.webm", b"audio-bytes", "audio/webm")})
    assert res.status_code == 200 and res.json() == {"text": "hello world"}
    [request] = calls
    assert str(request.url) == f"{BASE}/api/v1/ai/speech/stt"
    assert request.headers["content-type"] == "audio/webm" and request.content == b"audio-bytes"


def test_a_missing_deepgram_provider_is_the_suites_sentence(client, respond):
    respond.fn = lambda r: httpx.Response(409, json={"detail": {"code": "ai_not_configured", "message": "No Deepgram key is set up."}})
    res = client.post("/api/settings/speech/transcribe", files={"file": ("rec.webm", b"a", "audio/webm")})
    assert res.status_code == 409 and res.json()["detail"]["message"] == "No Deepgram key is set up."


def test_the_renderers_narrator_is_pinned_after_the_first_chunk(monkeypatch, calls, respond):
    from app.video.worker import _tts_caller

    monkeypatch.setenv("AI_BACKEND", "suite")
    monkeypatch.setenv("SUITE_BASE_URL", BASE)
    monkeypatch.setenv("SUITE_APP_SECRET", "app-secret")
    monkeypatch.setattr(suite, "TRANSPORT", httpx.MockTransport(lambda r: (calls.append(r), respond.fn(r))[1]))
    respond.fn = lambda r: _speech(model="model-9", voice="Aria")

    call = _tts_caller("user-1", None)  # no database: nothing is resolved up front
    assert call("First chunk.") == AUDIO and call("Second chunk.") == AUDIO
    assert json.loads(calls[0].content) == {"text": "First chunk."}
    assert json.loads(calls[1].content) == {"text": "Second chunk.", "voice": "Aria", "model_ref": "model-9"}


def test_a_recording_is_transcribed_by_the_suite_and_its_text_saved(tmp_path, monkeypatch, calls, respond):
    import subprocess

    from sqlalchemy.pool import StaticPool

    from app.models import Category, Note, TranscriptionJob
    from app.routers import transcription

    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    now = datetime.now(timezone.utc)
    with Session(eng) as s:
        s.add(Category(id="c", label="Notes", emoji="📝", color="#000"))
        s.add(Note(id="n", title="T", content="[]", category_id="c", tags="[]", created_at=now,
                   modified_at=now, user_id="user-1"))
        s.add(TranscriptionJob(id="j", user_id="user-1", source_filename="clip.webm", status="queued",
                               stage="", progress=0, note_id="n", note_title="T", after_block_id=None,
                               model="fal-ai/wizper", created_at=now, updated_at=now))
        s.commit()
    (tmp_path / "user-1").mkdir()
    (tmp_path / "user-1" / "clip.webm").write_bytes(b"video")

    def fake_ffmpeg(cmd, **kwargs):
        open(cmd[-1], "wb").write(b"RIFFwav")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(transcription, "engine", eng)
    monkeypatch.setattr(transcription, "MEDIA_DIR", str(tmp_path))
    monkeypatch.setattr(transcription.shutil, "which", lambda name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(transcription.subprocess, "run", fake_ffmpeg)
    monkeypatch.setenv("AI_BACKEND", "suite")
    monkeypatch.setenv("SUITE_BASE_URL", BASE)
    monkeypatch.setenv("SUITE_APP_SECRET", "app-secret")
    monkeypatch.setattr(suite, "TRANSPORT", httpx.MockTransport(lambda r: (calls.append(r), respond.fn(r))[1]))
    respond.fn = lambda r: httpx.Response(200, json={"data": {"segments": [{"text": "spoken words", "start": 0, "end": 1, "words": []}],
                                                              "language": "en", "model": "nova-3", "duration_seconds": 1,
                                                              "usage_event_id": "u"}})

    transcription._run_job("j")  # no fal key exists anywhere: the suite is the only engine

    with Session(eng) as s:
        job = s.get(TranscriptionJob, "j")
        assert job.status == "done", job.error_message
        assert (tmp_path / "user-1" / job.result_filename).read_text() == "spoken words"
        assert s.exec(select(UsageEvent)).all() == []
    assert calls[0].content == b"RIFFwav" and calls[0].headers["content-type"] == "audio/wav"
