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
