"""What a turn decides once it has a plan.

Planning is the phase that moved last and matters most: it is longer than the run it
produces, and it was the one stretch a user could not walk away from. So these are
about the shape of the turn rather than about parsing — which of the three things
happens next, and what the note is doing while it happens:

    a plain answer      → said in the chat, turn over, nothing was ever locked for long
    a plan, plan mode on → parked; the note UNLOCKS while a person decides
    a plan, plan mode off → straight on into the run, note never released

The provider is stubbed. What comes back from it is `plan_parse`'s problem and is
tested there; what the turn does with it is this file's.
"""

import json
from datetime import datetime

import pytest
from sqlmodel import Session, SQLModel, create_engine

import app.assistant.planner as planner
from app.assistant.planner import PLANNING_SHARE, run_planning
from app.jobs.registry import KINDS
from app.models import AISession, AssistantRunJob, Category, Note

USER = "user-1"
CATEGORY = "cat-1"
SESSION_ID = "sess-1"


@pytest.fixture
def engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return engine


@pytest.fixture
def session(engine, monkeypatch):
    # The preview writes through its own Session, as it does on a worker thread.
    monkeypatch.setattr(planner, "engine", engine)
    now = datetime.utcnow()
    with Session(engine) as s:
        s.add(Category(id=CATEGORY, label="Notes", emoji="📝", color="#000"))
        s.add(Note(id="note-1", title="A note", content="[]", category_id=CATEGORY,
                   tags="[]", created_at=now, modified_at=now, user_id=USER))
        s.add(AISession(id=SESSION_ID, note_id="note-1", user_id=USER, name="Chat",
                        messages="[]", created_at=now, updated_at=now))
        s.commit()
        yield s


def make_turn(session, *, plan_mode=True, voice=False, note_id="note-1", exec_ctx=None,
              web_search_mode="none", protocol="anthropic"):
    now = datetime.utcnow()
    job = AssistantRunJob(
        id="turn-1",
        user_id=USER,
        note_id=note_id,
        session_id=SESSION_ID,
        note_title="A note",
        status="processing",
        phase="planning",
        prompt_ctx=json.dumps({
            "protocol": protocol, "provider_id": "p1", "model": "m",
            "base_body": {"messages": [{"role": "user", "content": "go"}]},
        }),
        exec_ctx=json.dumps(exec_ctx or {"current_note_id": note_id,
                                         "valid_note_ids": [note_id] if note_id else []}),
        turn_ctx=json.dumps({"plan_mode": plan_mode, "voice": voice,
                             "web_search_mode": web_search_mode, "label_map": {}}),
        touched_note_ids=json.dumps([note_id] if note_id else []),
        created_at=now,
        updated_at=now,
    )
    session.add(job)
    session.commit()
    return job


def reply(text, protocol="anthropic"):
    """One provider reply carrying `text`, in that protocol's own shape.

    The three are genuinely different objects, not stylistic variants — which is the
    whole point of parametrising over them.
    """
    if protocol == "anthropic":
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": text}]}
    if protocol == "ollama":
        return {"message": {"role": "assistant", "content": text}, "done_reason": "stop"}
    return {"choices": [{"message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}]}


def envelope(*actions):
    return json.dumps({"actions": list(actions)})


def stub_provider(monkeypatch, *replies):
    """Answer each successive call with the next reply, recording the bodies sent."""
    sent = []
    queue = list(replies)

    def fake(session, user_id, ctx, body, on_delta=None):
        sent.append(body)
        data = queue.pop(0) if queue else reply("{}")
        if on_delta:
            for block in data.get("content") or []:
                if block.get("type") == "text":
                    on_delta(block.get("text") or "")
        return data

    monkeypatch.setattr(planner, "call_provider", fake)
    return sent


PROTOCOLS = ["anthropic", "openai", "ollama"]


def plan_turn(session, **kwargs):
    return run_planning(session, "turn-1", check_cancelled=lambda: None,
                        report=lambda *a: None, **kwargs)


def messages_of(session):
    return json.loads(session.get(AISession, SESSION_ID).messages)


def turn(session):
    """The row as a fresh request would read it.

    The preview writes through its own session, exactly as it does on a worker thread,
    so anything holding a cached copy is looking at the past.
    """
    session.expire_all()
    return session.get(AssistantRunJob, "turn-1")


# ─── a plain answer ──────────────────────────────────────────────────────────


def test_a_respond_only_turn_answers_and_finishes(session, monkeypatch):
    # An ordinary question should behave like an ordinary question: no review modal,
    # no execution, and the answer in the chat whether or not anyone is looking.
    make_turn(session)
    stub_provider(monkeypatch, reply(envelope({"type": "respond", "text": "Geckos climb."})))

    result = plan_turn(session)

    row = turn(session)
    assert result.run_now is False
    assert row.status == "done"
    assert row.progress == 100
    assert [m["content"] for m in messages_of(session)] == ["Geckos climb."]


def test_a_finished_answer_holds_no_note(session, monkeypatch):
    make_turn(session)
    stub_provider(monkeypatch, reply(envelope({"type": "respond", "text": "Yes."})))

    plan_turn(session)

    assert KINDS["assistant"].to_activity(turn(session)).locks_note is False


# ─── a plan, waiting for a decision ──────────────────────────────────────────


def test_plan_mode_parks_the_turn_and_unlocks_the_note(session, monkeypatch):
    # The lock/unlock/re-lock the whole change is shaped around: nothing is being
    # written while a person decides, so nothing should be held.
    make_turn(session, plan_mode=True)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "respond", "text": "Here's what I'd do."},
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))

    result = plan_turn(session)

    row = turn(session)
    assert result.run_now is False
    assert row.status == "awaiting_approval"
    assert row.phase == "awaiting_approval"
    assert row.progress == PLANNING_SHARE
    assert KINDS["assistant"].to_activity(row).locks_note is False
    assert json.loads(row.plan)["actions"][1]["type"] == "append_note"


def test_a_parked_plan_still_delivers_the_answer_it_carried(session, monkeypatch):
    # The model answered the question; that should not be held hostage to the edits it
    # also proposed, which the user has not agreed to yet.
    make_turn(session, plan_mode=True)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "respond", "text": "Short answer: yes."},
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))

    plan_turn(session)

    posted = messages_of(session)[0]["content"]
    assert "Short answer: yes." in posted
    assert planner.AWAITING_NOTICE in posted


def test_voice_mode_asks_even_when_plan_mode_is_off(session, monkeypatch):
    # Spoken confirmation replaces the modal; it does not remove the confirmation.
    make_turn(session, plan_mode=False, voice=True)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))

    result = plan_turn(session)

    assert result.run_now is False
    assert turn(session).status == "awaiting_approval"


# ─── a plan, running straight on ─────────────────────────────────────────────


def test_plan_mode_off_runs_on_without_releasing_the_note(session, monkeypatch):
    make_turn(session, plan_mode=False)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))

    result = plan_turn(session)

    row = turn(session)
    assert result.run_now is True
    assert row.phase == "running"
    assert row.status == "processing"
    assert KINDS["assistant"].to_activity(row).locks_note is True


def test_the_lock_widens_to_everything_the_plan_will_write(session, monkeypatch):
    # Until the plan existed the turn could only hold the open note.
    now = datetime.utcnow()
    session.add(Note(id="note-2", title="Second", content="[]", category_id=CATEGORY,
                     tags="[]", created_at=now, modified_at=now, user_id=USER))
    session.commit()
    make_turn(session, plan_mode=False,
              exec_ctx={"current_note_id": "note-1", "valid_note_ids": ["note-1", "note-2"]})
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
        {"type": "append_note", "noteId": "note-2", "content": "y"},
    )))

    plan_turn(session)

    row = turn(session)
    assert set(json.loads(row.touched_note_ids)) == {"note-1", "note-2"}


def test_the_reply_is_posted_as_the_run_starts_not_when_it_ends(session, monkeypatch):
    # A run can take minutes. The answer is already written, sitting in the plan's
    # respond actions, so making the user wait for it would be a regression.
    make_turn(session, plan_mode=False)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "respond", "text": "Adding that now."},
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))

    plan_turn(session)

    assert [m["content"] for m in messages_of(session)] == ["Adding that now."]


# ─── searching, then planning again ──────────────────────────────────────────


def test_a_search_round_replans_with_what_it_found(session, monkeypatch):
    now = datetime.utcnow()
    session.add(Note(id="found-1", title="Gecko habits", content="[]", category_id=CATEGORY,
                     tags="[]", created_at=now, modified_at=now, user_id=USER))
    session.commit()
    make_turn(session, plan_mode=False)
    sent = stub_provider(
        monkeypatch,
        reply(envelope({"type": "find_notes", "query": "Gecko"})),
        reply(envelope({"type": "append_note", "noteId": "found-1", "content": "x"})),
    )

    result = plan_turn(session)

    assert len(sent) == 2, "it plans again once the search has come back"
    assert result.run_now is True
    # The executor refuses ids that were not in context, so a note the search found has
    # to be added or the very action it enabled would be skipped.
    exec_ctx = json.loads(turn(session).exec_ctx)
    assert "found-1" in exec_ctx["valid_note_ids"]


def test_a_search_round_only_appends_so_the_cached_prefix_survives(session, monkeypatch):
    make_turn(session, plan_mode=False)
    sent = stub_provider(
        monkeypatch,
        reply(envelope({"type": "find_notes", "query": "nothing"})),
        reply(envelope({"type": "append_note", "noteId": "note-1", "content": "x"})),
    )

    plan_turn(session)

    first, second = sent
    assert second["messages"][: len(first["messages"])] == first["messages"]
    assert len(second["messages"]) == len(first["messages"]) + 2


def test_the_search_budget_is_bounded(session, monkeypatch):
    # A model that keeps asking must not be able to search forever.
    make_turn(session, plan_mode=False)
    sent = stub_provider(
        monkeypatch,
        *[reply(envelope({"type": "find_notes", "query": "again"})) for _ in range(10)],
    )

    plan_turn(session)

    assert len(sent) == planner.MAX_RETRIEVAL_ROUNDS + 1


def test_a_search_that_was_never_offered_is_answered_not_executed(session, monkeypatch):
    # Retrieval actions are resolved before the plan runs, never handed to the
    # executor — so one left over at the end has to become something sayable.
    make_turn(session, plan_mode=False)
    stub_provider(
        monkeypatch,
        *[reply(envelope({"type": "find_notes", "query": "nothing"})) for _ in range(6)],
    )

    result = plan_turn(session)

    row = turn(session)
    assert result.run_now is False
    assert row.status == "done"
    assert "No matching notes" in messages_of(session)[0]["content"]


# ─── finishing a turn the provider left open ─────────────────────────────────


def test_a_stalled_turn_is_finished_rather_than_lost(session, monkeypatch):
    # DeepSeek's compatible endpoint stops on tool_use with nothing left to run and no
    # plan written. Without the continuation the user sees commentary and no plan.
    make_turn(session, plan_mode=False)
    stalled = {
        "stop_reason": "tool_use",
        "content": [
            {"type": "text", "text": "I'll create the note now…"},
            {"type": "server_tool_use", "input": {"query": "geckos"}},
            {"type": "web_search_tool_result", "content": [{"title": "T", "url": "https://a.dev"}]},
        ],
    }
    sent = stub_provider(
        monkeypatch, stalled,
        reply(envelope({"type": "append_note", "noteId": "note-1", "content": "x"})),
    )

    result = plan_turn(session)

    assert len(sent) == 2
    assert "tools" not in sent[1], "the search that stalled must not restart"
    assert result.run_now is True


# ─── watching it work ────────────────────────────────────────────────────────


def test_the_reply_is_written_to_the_row_as_it_arrives(session, monkeypatch):
    # Four minutes of silence is the complaint this change exists to answer.
    make_turn(session)
    seen = []

    def fake(session_, user_id, ctx, body, on_delta=None):
        on_delta("I'll start ")
        on_delta("by reading the note.")
        seen.append(turn(session).preview)
        return reply(envelope({"type": "respond", "text": "Done."}))

    monkeypatch.setattr(planner, "call_provider", fake)
    plan_turn(session)

    assert seen and seen[-1].startswith("I'll start")


def test_the_preview_is_cleared_once_the_turn_is_decided(session, monkeypatch):
    make_turn(session, plan_mode=True)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))

    plan_turn(session)

    assert turn(session).preview == ""


def test_what_the_model_actually_said_is_kept_for_diagnosis(session, monkeypatch):
    make_turn(session, plan_mode=True)
    raw = envelope({"type": "append_note", "noteId": "note-1", "content": "x"})
    stub_provider(monkeypatch, reply(raw))

    plan_turn(session)

    assert turn(session).plan_raw == raw


# ─── stopping ────────────────────────────────────────────────────────────────


def test_a_cancelled_turn_unwinds_at_its_next_checkpoint(session, monkeypatch):
    make_turn(session, plan_mode=False)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))

    def stop():
        raise planner.Cancelled()

    with pytest.raises(planner.Cancelled):
        run_planning(session, "turn-1", check_cancelled=stop, report=lambda *a: None)

    # Nothing was decided, so nothing was written to the row.
    assert turn(session).plan == '{"actions":[]}'


# ─── the whole turn ──────────────────────────────────────────────────────────


def run_the_job(session, engine, monkeypatch, *, applied):
    """Drive _run_job with the two later phases stubbed, to exercise the wiring."""
    import app.assistant.worker as worker

    monkeypatch.setattr(worker, "engine", engine)
    monkeypatch.setattr(worker, "is_cancelled", lambda job_id: False)
    monkeypatch.setattr(
        worker, "generate_bodies",
        lambda user_id, plan, ctx, **kw: (plan, []),
    )

    class FakeExecutor:
        def __init__(self, *args, **kwargs):
            pass

        def run(self, plan):
            applied.append(plan)
            return []

    monkeypatch.setattr(worker, "PlanExecutor", FakeExecutor)
    worker._run_job("turn-1")


def test_plan_mode_off_carries_one_row_through_to_the_edits(session, engine, monkeypatch):
    # The single unbroken stretch: ask, plan, write, apply, with the note held
    # throughout and one row for the lot.
    make_turn(session, plan_mode=False)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))
    applied = []

    run_the_job(session, engine, monkeypatch, applied=applied)

    row = turn(session)
    assert [a["type"] for a in applied[0]["actions"]] == ["append_note"]
    assert row.status == "done"
    assert row.progress == 100


def test_a_parked_turn_stops_before_applying_anything(session, engine, monkeypatch):
    make_turn(session, plan_mode=True)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    )))
    applied = []

    run_the_job(session, engine, monkeypatch, applied=applied)

    assert applied == [], "nothing runs until a person says so"
    assert turn(session).status == "awaiting_approval"


def test_an_approved_turn_skips_planning_and_goes_straight_to_work(session, engine, monkeypatch):
    # Approval re-queues the same row in its running phase; planning must not run a
    # second time and bill a second call.
    job = make_turn(session, plan_mode=True)
    job.phase = "running"
    job.plan = envelope({"type": "append_note", "noteId": "note-1", "content": "x"})
    session.add(job)
    session.commit()
    calls = stub_provider(monkeypatch)
    applied = []

    run_the_job(session, engine, monkeypatch, applied=applied)

    assert calls == [], "the plan was already made"
    assert [a["type"] for a in applied[0]["actions"]] == ["append_note"]


# ─── every protocol ──────────────────────────────────────────────────────────
#
# The turn was only ever exercised over the Anthropic shape, and reading the reply is
# the one part of planning that differs per protocol. It shipped reading `data["content"]`
# unconditionally, so on an OpenAI-compatible or Ollama provider every planning call came
# back empty: "(no response)" in the chat, turn finished, nothing created, no error.


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_a_plan_is_read_out_of_every_protocol(session, monkeypatch, protocol):
    make_turn(session, plan_mode=True, protocol=protocol)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "create_note", "title": "Analysis", "content": "Body."},
    ), protocol))

    result = plan_turn(session)

    row = turn(session)
    assert result.run_now is False
    assert row.status == "awaiting_approval", f"{protocol} planning produced no plan"
    assert [a["type"] for a in json.loads(row.plan)["actions"]] == ["create_note"]


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_a_plain_answer_survives_every_protocol(session, monkeypatch, protocol):
    make_turn(session, plan_mode=True, protocol=protocol)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "respond", "text": "Geckos climb."},
    ), protocol))

    plan_turn(session)

    assert [m["content"] for m in messages_of(session)] == ["Geckos climb."]


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_plan_mode_off_runs_on_from_every_protocol(session, monkeypatch, protocol):
    make_turn(session, plan_mode=False, protocol=protocol)
    stub_provider(monkeypatch, reply(envelope(
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    ), protocol))

    assert plan_turn(session).run_now is True
