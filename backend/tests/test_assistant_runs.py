"""Starting a run, and reading a provider's reply.

The body-assembly tests are the load-bearing ones. The browser builds the request —
including the cache breakpoints that decide whether the prompt cache hits — and the
worker is only allowed to append. If it ever rewrote the prefix, every step would
miss the cache and be re-billed in full, silently.
"""

import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine, select

from app.assistant.generate import _needs_generation
from app.assistant.provider import TRUNCATION_NOTICE, PromptContext, extract_text
from app.jobs.registry import KINDS
from app.models import AssistantRunJob, Category, Note
from app.routers import assistant

USER = "user-1"
OTHER = "user-2"
CATEGORY = "cat-1"


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Category(id=CATEGORY, label="Notes", emoji="📝", color="#000"))
        now = datetime.utcnow()
        s.add(Note(id="note-1", title="A note", content="[]", category_id=CATEGORY,
                   tags="[]", created_at=now, modified_at=now, user_id=USER))
        s.commit()
        yield s


def request_for(user_id):
    return SimpleNamespace(state=SimpleNamespace(user_id=user_id))


def payload(**overrides):
    body = dict(
        plan={"actions": [{"type": "rename_note", "noteId": "note-1", "title": "New"}]},
        prompt_ctx={},
        exec_ctx={"current_note_id": "note-1", "valid_note_ids": ["note-1"]},
        note_id="note-1",
        session_id=None,
    )
    body.update(overrides)
    return assistant.AssistantRunRequest(**body)


# ─── assembling a step's request ─────────────────────────────────────────────


BASE = {
    "system": [{"type": "text", "text": "instructions", "cache_control": {"type": "ephemeral"}}],
    "messages": [
        {"role": "user", "content": [{"type": "text", "text": "note body",
                                      "cache_control": {"type": "ephemeral"}}]},
    ],
}


def test_a_step_body_is_the_base_plus_exactly_its_follow_ups():
    ctx = PromptContext({"base_body": BASE, "steps": []})
    step = {"messages": [{"role": "assistant", "content": "plan"},
                         {"role": "user", "content": "write section 2"}]}

    body = ctx.body_for(step)

    assert len(body["messages"]) == 3
    assert body["messages"][0] == BASE["messages"][0]
    assert body["messages"][1]["content"] == "plan"
    assert body["messages"][2]["content"] == "write section 2"


def test_assembling_a_step_leaves_the_cached_prefix_untouched():
    """If the prefix moved, every parallel step would miss the cache and be re-billed."""
    ctx = PromptContext({"base_body": BASE, "steps": []})
    before = json.dumps(BASE, sort_keys=True)

    ctx.body_for({"messages": [{"role": "user", "content": "one"}]})
    ctx.body_for({"messages": [{"role": "user", "content": "two"}]})

    assert json.dumps(BASE, sort_keys=True) == before
    assert ctx.body_for({"messages": []})["system"] == BASE["system"]


def test_steps_do_not_leak_into_each_other():
    ctx = PromptContext({"base_body": BASE, "steps": []})
    first = ctx.body_for({"messages": [{"role": "user", "content": "one"}]})
    second = ctx.body_for({"messages": [{"role": "user", "content": "two"}]})
    assert len(first["messages"]) == len(second["messages"]) == 2
    assert first["messages"][-1]["content"] == "one"


# ─── reading a reply ─────────────────────────────────────────────────────────


def test_anthropic_text_blocks_are_joined():
    data = {"content": [{"type": "text", "text": "Hello "}, {"type": "text", "text": "world."}]}
    assert extract_text("anthropic", data) == "Hello world."


def test_a_gap_where_another_block_sat_becomes_a_paragraph_break():
    # Without this, prose from either side of an interruption runs together mid-word.
    data = {"content": [
        {"type": "text", "text": "Before."},
        {"type": "thinking", "thinking": "..."},
        {"type": "text", "text": "After."},
    ]}
    assert extract_text("anthropic", data) == "Before.\n\nAfter."


def test_a_leading_non_text_block_does_not_add_a_break():
    data = {"content": [{"type": "thinking"}, {"type": "text", "text": "Body."}]}
    assert extract_text("anthropic", data) == "Body."


def test_openai_and_ollama_shapes():
    assert extract_text("openai", {"choices": [{"message": {"content": "Hi"}}]}) == "Hi"
    assert extract_text("ollama", {"message": {"content": "Hi"}}) == "Hi"


@pytest.mark.parametrize("protocol,data", [
    ("anthropic", {"content": [{"type": "text", "text": "Cut"}], "stop_reason": "max_tokens"}),
    ("openai", {"choices": [{"message": {"content": "Cut"}, "finish_reason": "length"}]}),
])
def test_hitting_the_output_cap_is_marked_in_the_body(protocol, data):
    assert extract_text(protocol, data) == "Cut" + TRUNCATION_NOTICE


def test_an_empty_or_malformed_reply_reads_as_empty_rather_than_raising():
    assert extract_text("anthropic", {}) == ""
    assert extract_text("openai", {"choices": []}) == ""
    assert extract_text("ollama", {}) == ""


# ─── which steps defer their body ────────────────────────────────────────────


def test_a_content_action_with_a_spec_and_no_content_needs_generating():
    assert _needs_generation({"type": "edit_note", "spec": "write it", "content": ""}) is True


def test_content_already_written_is_left_alone():
    assert _needs_generation({"type": "edit_note", "spec": "write it", "content": "done"}) is False


def test_an_action_that_carries_no_body_never_generates():
    assert _needs_generation({"type": "rename_note", "spec": "x", "content": ""}) is False


# ─── starting a run ──────────────────────────────────────────────────────────


def test_creating_a_run_queues_it_and_reports_it_as_activity(session, monkeypatch):
    queued = []
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: queued.append(job_id))

    result = assistant.create_run(payload(), request_for(USER), session)

    assert result.data.kind == "assistant"
    assert result.data.status == "queued"
    assert result.data.note_id == "note-1"
    assert queued == [result.data.id]


def test_a_run_locks_its_note(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    result = assistant.create_run(payload(), request_for(USER), session)
    # Unlike a render, a run rewrites the document, so the editor holds it read-only.
    assert result.data.locks_note is True


def test_the_notes_a_run_may_write_are_derived_from_the_plan(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    now = datetime.utcnow()
    session.add(Note(id="note-2", title="Second", content="[]", category_id=CATEGORY,
                     tags="[]", created_at=now, modified_at=now, user_id=USER))
    session.commit()

    result = assistant.create_run(payload(
        plan={"actions": [
            {"type": "append_note", "noteId": "note-1", "content": "x"},
            {"type": "append_note", "noteId": "note-2", "content": "y"},
        ]},
        exec_ctx={"current_note_id": "note-1", "valid_note_ids": ["note-1", "note-2"]},
    ), request_for(USER), session)

    assert set(result.data.meta["touched_note_ids"]) == {"note-1", "note-2"}


def test_a_note_the_plan_names_but_context_does_not_allow_is_not_locked(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    result = assistant.create_run(payload(
        plan={"actions": [{"type": "append_note", "noteId": "not-allowed", "content": "x"}]},
        exec_ctx={"current_note_id": None, "valid_note_ids": ["note-1", "note-2"]},
        note_id=None,
    ), request_for(USER), session)
    assert result.data.meta["touched_note_ids"] == []


def test_a_run_without_a_note_is_allowed(session, monkeypatch):
    """The list view's global session has no note, and its runs still belong in the
    indicator."""
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    result = assistant.create_run(
        payload(note_id=None, plan={"actions": [{"type": "create_note", "title": "T", "content": "B"}]}),
        request_for(USER), session,
    )
    assert result.data.note_id is None


def test_an_empty_plan_is_refused(session):
    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(plan={"actions": []}), request_for(USER), session)
    assert raised.value.status_code == 400
    assert raised.value.detail["code"] == "empty_plan"


def test_an_oversized_plan_is_refused(session):
    big = {"actions": [{"type": "rename_note", "noteId": "note-1", "title": "x"}] * 51}
    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(plan=big), request_for(USER), session)
    assert raised.value.detail["code"] == "plan_too_large"


def test_a_run_on_another_users_note_is_refused(session):
    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(), request_for(OTHER), session)
    assert raised.value.status_code == 404


def test_only_one_run_at_a_time_per_note(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    assistant.create_run(payload(), request_for(USER), session)

    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(), request_for(USER), session)
    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "already_running"


def test_a_finished_run_does_not_block_the_next_one(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    first = assistant.create_run(payload(), request_for(USER), session)
    row = session.get(AssistantRunJob, first.data.id)
    row.status = "done"
    session.add(row)
    session.commit()

    assert assistant.create_run(payload(), request_for(USER), session).data.status == "queued"


# ─── reading runs back ───────────────────────────────────────────────────────


def test_listing_active_runs(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)

    listed = assistant.list_runs(request_for(USER), active=1, session=session)
    assert [j.id for j in listed.data] == [created.data.id]
    assert assistant.list_runs(request_for(OTHER), active=1, session=session).data == []


def test_another_users_run_is_not_readable(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)

    with pytest.raises(HTTPException) as raised:
        assistant.get_run(created.data.id, request_for(OTHER), session)
    assert raised.value.status_code == 404


def test_cancelling_a_run_releases_its_note_immediately(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    monkeypatch.setattr(KINDS["assistant"], "cancel", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)

    result = assistant.cancel_run(created.data.id, request_for(USER), session)

    assert result.data.status == "cancelled"
    # Nothing derived from "still active" holds the note any more, whatever the
    # worker thread happens to be doing.
    assert assistant.list_runs(request_for(USER), active=1, session=session).data == []
