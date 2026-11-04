"""A turn planned by tool calls through Gecko Suite (M5), against a fake suite.

What these pin is the contract with everything after planning: the tool path must hand
`_decide` the same plan the text path did, so approval and the executor are untouched.
So the assertions are about the plan on the row, the ids the executor will accept, and
that nothing was applied, more than about the wire.
"""

import json
from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.suite as suite
from app.assistant import planner, tool_planner
from app.assistant.tools import TOOL_INSTRUCTIONS, tool_specs
from app.models import AIProvider, AssistantRunJob, Category, Note
from app.routers import assistant

USER = "user-1"
CATEGORY = "cat-1"
BASE = "https://suite.test"


@pytest.fixture
def engine(monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    now = datetime.utcnow()
    with Session(eng) as s:
        s.add(Category(id=CATEGORY, label="Notes", emoji="📝", color="#000"))
        s.add(Note(id="note-1", title="Trip plan", content="[]", category_id=CATEGORY, tags="[]",
                   created_at=now, modified_at=now, user_id=USER))
        s.add(Note(id="note-2", title="Owl facts", content="[]", category_id=CATEGORY, tags="[]",
                   created_at=now, modified_at=now, user_id=USER))
        s.add(AIProvider(id="p1", name="Claude", provider_type="anthropic", api_key="x",
                         model="claude-opus-5-5", user_id=USER))
        s.commit()
    # The live preview writes through its own session, as the worker's does.
    monkeypatch.setattr(planner, "engine", eng)
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    monkeypatch.setenv("AI_BACKEND", "suite")
    monkeypatch.setenv("SUITE_BASE_URL", BASE)
    monkeypatch.setenv("SUITE_APP_SECRET", "app-secret")
    return eng


class FakeSuite:
    """/ai/chat, streamed, answering from a script. Each answer is (text, tool_calls)."""

    def __init__(self):
        self.script = []
        self.requests = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        text, calls = self.script.pop(0)
        if isinstance(text, Exception):
            return httpx.Response(409, json={"detail": {"code": "ai_not_configured", "message": str(text)}})
        final = {
            "text": text, "tool_calls": [{"id": f"c{i}", "name": n, "arguments": a} for i, (n, a) in enumerate(calls)],
            "stop": "tool_use" if calls else "end", "model": "claude-opus-5-5", "vendor": "anthropic",
            "usage": {"input_tokens": 10, "output_tokens": 5}, "cost": 0.001,
            "message": {"role": "assistant", "content": text or "(tools)"},
        }
        body = (f"event: delta\ndata: {json.dumps({'text': text})}\n\n" if text else "") + \
               f"event: final\ndata: {json.dumps(final)}\n\n"
        return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})

    def sent(self, i=-1):
        return json.loads(self.requests[i].content)


@pytest.fixture
def fake(engine, monkeypatch):
    f = FakeSuite()
    monkeypatch.setattr(suite, "SYNC_TRANSPORT", httpx.MockTransport(f.handler))
    return f


TOOL_CTX = {
    "reference_block": "Notes in context:\n- note-1 — Trip plan",
    "current_note_text": "# Trip plan\nDay one: Lisbon.",
    "history": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello!"}],
    "user_request": "What should I add?",
}


def start(engine, **turn_overrides):
    turn_ctx = {"plan_mode": True, "tool_mode": True, "tool_ctx": TOOL_CTX, "web_search_mode": "action",
                "label_map": {"note-1": "Trip plan"}, **turn_overrides}
    with Session(engine) as s:
        job = assistant.create_run(assistant.AssistantTurnRequest(
            prompt_ctx={"protocol": "anthropic", "provider_id": "p1", "model": "claude-opus-5-5",
                        "base_body": {"messages": [{"role": "user", "content": "go"}]}},
            exec_ctx={"current_note_id": "note-1", "valid_note_ids": ["note-1"]},
            turn_ctx=turn_ctx, note_id="note-1", session_id=None,
        ), SimpleNamespace(state=SimpleNamespace(user_id=USER)), s).data
        planner.run_planning(s, job.id, check_cancelled=lambda: None, report=lambda *a: None)
    with Session(engine) as s:
        return s.get(AssistantRunJob, job.id)


def test_a_question_is_answered_with_no_tools_and_ends_the_turn(engine, fake):
    fake.script = [("Pack light.", [])]
    row = start(engine)
    assert row.status == "done"
    assert json.loads(row.plan) == {"actions": [{"type": "respond", "text": "Pack light."}]}

    sent = fake.sent()
    assert str(fake.requests[0].url) == f"{BASE}/api/v1/ai/chat"
    assert fake.requests[0].headers["x-gecko-app"] == "notes" and fake.requests[0].headers["x-on-behalf-of"] == USER
    # The model picked in Notes' panel, by vendor and name; never a suite task.
    assert (sent["vendor"], sent["model"], sent.get("task")) == ("anthropic", "claude-opus-5-5", None)
    assert sent["system"][0].startswith(TOOL_INSTRUCTIONS[:60]) and sent["system"][1] == TOOL_CTX["reference_block"]
    assert sent["messages"][-1]["content"].startswith("Current note — live:")
    assert sent["messages"][0] == {"role": "user", "content": "Hi"}  # history kept, in order
    assert "web_search" in [t["name"] for t in sent["tools"]] and "respond" not in [t["name"] for t in sent["tools"]]


def test_a_change_is_proposed_and_parked_never_applied(engine, fake):
    fake.script = [
        ("", [("create_note", {"title": "Packing list", "content": "- socks", "description": "A packing list"})]),
        ("I propose a packing list.", []),
    ]
    row = start(engine)
    assert row.status == "awaiting_approval"
    assert json.loads(row.plan)["actions"] == [
        {"type": "respond", "text": "I propose a packing list."},
        {"type": "create_note", "title": "Packing list", "content": "- socks", "description": "A packing list"},
    ]
    with Session(engine) as s:
        assert {n.title for n in s.exec(select(Note)).all()} == {"Trip plan", "Owl facts"}  # nothing created
    # The model was told its change is a proposal.
    result = fake.sent(1)["messages"][-1]
    assert result["role"] == "tool" and "Nothing is applied until the person approves" in result["results"][0]["content"]


def test_a_note_found_by_search_can_be_changed(engine, fake):
    fake.script = [
        ("", [("find_notes", {"query": "Owl"})]),
        ("", [("rename_note", {"noteId": "note-2", "title": "Owls"})]),
        ("Renamed.", []),
    ]
    row = start(engine)
    found = fake.sent(1)["messages"][-1]["results"][0]["content"]
    assert "note-2" in found and "Owl facts" in found
    # Without this the executor would refuse the very note the model just looked up.
    assert "note-2" in json.loads(row.exec_ctx)["valid_note_ids"]
    assert {"type": "rename_note", "noteId": "note-2", "title": "Owls"} in json.loads(row.plan)["actions"]


def test_unusable_arguments_go_back_to_the_model_and_record_nothing(engine, fake):
    fake.script = [("", [("rename_note", {"noteId": "note-1"})]), ("Sorry, which title?", [])]
    row = start(engine)
    result = fake.sent(1)["messages"][-1]["results"][0]
    assert result["is_error"] is True and "noteId, title" in result["content"]
    assert json.loads(row.plan)["actions"] == [{"type": "respond", "text": "Sorry, which title?"}]


def test_reading_a_note_that_is_not_the_persons_is_refused(engine, fake):
    fake.script = [("", [("read_note", {"noteId": "someone-elses"})]), ("Cannot.", [])]
    start(engine)
    assert fake.sent(1)["messages"][-1]["results"][0]["is_error"] is True


def test_the_suites_sentence_fails_the_turn_in_words(engine, fake):
    fake.script = [(RuntimeError("No anthropic provider with a key is set up in Gecko Suite."), [])]
    with pytest.raises(RuntimeError, match="No anthropic provider"):
        start(engine)


def test_web_search_is_offered_only_when_search_would_have_been():
    assert "web_search" in [t["name"] for t in tool_specs(web_search=True)]
    assert "web_search" not in [t["name"] for t in tool_specs(web_search=False)]


def test_every_write_tool_is_an_action_the_executor_knows():
    from app.assistant.executor import PlanExecutor

    for spec in tool_specs(web_search=False):
        if spec["name"] not in ("find_notes", "read_note"):
            assert hasattr(PlanExecutor, f"_do_{spec['name']}"), spec["name"]


@pytest.mark.parametrize("env, turn_ctx, expected", [
    ("suite", {"tool_mode": True, "tool_ctx": {}}, True),
    ("local", {"tool_mode": True, "tool_ctx": {}}, False),           # the text plan is the only local planner
    ("suite", {"tool_ctx": {}}, False),                               # switched off for this person
    ("suite", {"tool_mode": True}, False),                            # an older browser sent no neutral context
    ("suite", {"tool_mode": True, "tool_ctx": {"attachments": [{"media_type": "application/pdf"}]}}, False),
    ("suite", {"tool_mode": True, "tool_ctx": {"attachments": [{"media_type": "image/png"}]}}, True),
])
def test_when_the_tool_planner_is_used(monkeypatch, env, turn_ctx, expected):
    monkeypatch.setenv("AI_BACKEND", env)
    monkeypatch.setenv("SUITE_APP_SECRET", "s")
    assert tool_planner.wanted(turn_ctx) is expected
