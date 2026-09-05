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

from app.assistant.plan_prompt import action_needs_generation
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
        prompt_ctx={"protocol": "anthropic", "provider_id": "p1", "model": "m",
                    "base_body": {"messages": [{"role": "user", "content": "go"}]}},
        exec_ctx={"current_note_id": "note-1", "valid_note_ids": ["note-1"]},
        turn_ctx={"plan_mode": True},
        note_id="note-1",
        session_id=None,
    )
    body.update(overrides)
    return assistant.AssistantTurnRequest(**body)


def parked(session, monkeypatch, plan, **overrides):
    """A turn that has planned and is waiting for a decision."""
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    created = assistant.create_run(payload(**overrides), request_for(USER), session)
    row = session.get(AssistantRunJob, created.data.id)
    row.status = assistant.AWAITING
    row.phase = "awaiting_approval"
    row.plan = json.dumps(plan)
    session.add(row)
    session.commit()
    return row


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
    assert action_needs_generation({"type": "edit_note", "spec": "write it", "content": ""}) is True


def test_content_already_written_is_left_alone():
    assert action_needs_generation({"type": "edit_note", "spec": "write it", "content": "done"}) is False


def test_an_action_that_carries_no_body_never_generates():
    assert action_needs_generation({"type": "rename_note", "spec": "x", "content": ""}) is False


# ─── starting a turn ─────────────────────────────────────────────────────────


def test_creating_a_turn_queues_it_and_reports_it_as_activity(session, monkeypatch):
    queued = []
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: queued.append(job_id))

    result = assistant.create_run(payload(), request_for(USER), session)

    assert result.data.kind == "assistant"
    assert result.data.status == "queued"
    assert result.data.note_id == "note-1"
    assert result.data.meta["phase"] == "planning"
    assert queued == [result.data.id]


def test_a_turn_holds_nothing_while_it_is_still_planning(session, monkeypatch):
    # Nothing can be held before there is a plan to say what needs holding. The note
    # the turn was asked from is not a good enough guess: "write me a new note about
    # geckos" never touches it, and locking it would stop you working for no reason.
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    result = assistant.create_run(payload(), request_for(USER), session)

    assert result.data.locks_note is False
    assert result.data.meta["touched_note_ids"] == []
    assert result.data.meta["phase"] == "planning"


def test_a_turn_with_nothing_to_send_is_refused(session):
    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(prompt_ctx={}), request_for(USER), session)
    assert raised.value.status_code == 400
    assert raised.value.detail["code"] == "no_request"


def test_a_turn_without_a_note_is_allowed(session, monkeypatch):
    """The list view's global session has no note, and its turns still belong in the
    indicator."""
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    result = assistant.create_run(payload(note_id=None), request_for(USER), session)
    assert result.data.note_id is None
    assert result.data.meta["touched_note_ids"] == []


def test_a_turn_on_another_users_note_is_refused(session):
    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(), request_for(OTHER), session)
    assert raised.value.status_code == 404


def test_only_one_turn_at_a_time_per_note(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    assistant.create_run(payload(), request_for(USER), session)

    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(), request_for(USER), session)
    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "already_running"


def test_only_one_turn_at_a_time_per_conversation(session, monkeypatch):
    # A turn from the list view has no note, so the note check alone let a whole class
    # of second turns through.
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    assistant.create_run(payload(note_id=None, session_id="s1"), request_for(USER), session)

    with pytest.raises(HTTPException) as raised:
        assistant.create_run(payload(note_id=None, session_id="s1"), request_for(USER), session)
    assert raised.value.detail["code"] == "already_running"


def test_a_finished_turn_does_not_block_the_next_one(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    first = assistant.create_run(payload(), request_for(USER), session)
    row = session.get(AssistantRunJob, first.data.id)
    row.status = "done"
    session.add(row)
    session.commit()

    assert assistant.create_run(payload(), request_for(USER), session).data.status == "queued"


def test_a_parked_plan_does_not_block_a_new_turn(session, monkeypatch):
    # It is holding nothing while it waits, and the user may well ask for something
    # else rather than approve it.
    parked(session, monkeypatch, {"actions": [{"type": "respond", "text": "hi"}]})
    assert assistant.create_run(payload(), request_for(USER), session).data.status == "queued"


# ─── waiting for a decision ──────────────────────────────────────────────────


def test_a_parked_plan_holds_no_note(session, monkeypatch):
    # awaiting_approval sits outside ACTIVE_STATUSES precisely so that everything
    # derived from "active" lets go while a person is deciding.
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    ]})
    read = KINDS["assistant"].to_activity(row)

    assert read.locks_note is False
    assert read.meta["phase"] == "awaiting_approval"


def test_approving_re_locks_the_note_and_requeues_the_same_row(session, monkeypatch):
    queued = []
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    ]})
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: queued.append(job_id))

    result = assistant.approve_run(
        row.id, assistant.ApproveRequest(), request_for(USER), session
    )

    assert result.data.id == row.id, "one turn stays one row"
    assert result.data.status == "queued"
    assert result.data.locks_note is True
    assert result.data.meta["touched_note_ids"] == ["note-1"]
    assert queued == [row.id]


def test_approving_runs_only_the_ticked_steps(session, monkeypatch):
    row = parked(session, monkeypatch, {"actions": [
        {"type": "respond", "text": "Here you go."},
        {"type": "append_note", "noteId": "note-1", "content": "keep"},
        {"type": "rename_note", "noteId": "note-1", "title": "drop"},
    ]})
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    assistant.approve_run(
        row.id, assistant.ApproveRequest(action_indices=[1]), request_for(USER), session
    )

    kept = json.loads(session.get(AssistantRunJob, row.id).plan)["actions"]
    # The reply is not a step the user is choosing between, so it survives the filter.
    assert [a["type"] for a in kept] == ["respond", "append_note"]


def test_approving_nothing_but_the_reply_is_refused(session, monkeypatch):
    row = parked(session, monkeypatch, {"actions": [
        {"type": "respond", "text": "Here you go."},
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    ]})
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    with pytest.raises(HTTPException) as raised:
        assistant.approve_run(
            row.id, assistant.ApproveRequest(action_indices=[]), request_for(USER), session
        )
    assert raised.value.detail["code"] == "empty_plan"


def test_a_turn_that_is_not_waiting_cannot_be_approved(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)

    with pytest.raises(HTTPException) as raised:
        assistant.approve_run(
            created.data.id, assistant.ApproveRequest(), request_for(USER), session
        )
    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "not_awaiting"


def test_the_notes_an_approved_plan_may_write_are_derived_from_it(session, monkeypatch):
    now = datetime.utcnow()
    session.add(Note(id="note-2", title="Second", content="[]", category_id=CATEGORY,
                     tags="[]", created_at=now, modified_at=now, user_id=USER))
    session.commit()
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "note-1", "content": "x"},
        {"type": "append_note", "noteId": "note-2", "content": "y"},
    ]}, exec_ctx={"current_note_id": "note-1", "valid_note_ids": ["note-1", "note-2"]})
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    result = assistant.approve_run(
        row.id, assistant.ApproveRequest(), request_for(USER), session
    )
    assert set(result.data.meta["touched_note_ids"]) == {"note-1", "note-2"}


def test_the_note_a_turn_was_asked_from_is_not_locked_unless_the_plan_writes_it(
    session, monkeypatch
):
    # The other half of the fix. Deriving the set from the plan is not enough on its
    # own: the anchor note used to be added to it unconditionally, so "add a note about
    # geckos" still froze whatever you were reading at the time.
    now = datetime.utcnow()
    session.add(Note(id="note-2", title="Second", content="[]", category_id=CATEGORY,
                     tags="[]", created_at=now, modified_at=now, user_id=USER))
    session.commit()
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "note-2", "content": "y"},
    ]}, exec_ctx={"current_note_id": "note-1", "valid_note_ids": ["note-1", "note-2"]},
        note_id="note-1")
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    result = assistant.approve_run(
        row.id, assistant.ApproveRequest(), request_for(USER), session
    )
    assert result.data.meta["touched_note_ids"] == ["note-2"]


def test_a_plan_that_only_changes_metadata_locks_nothing(session, monkeypatch):
    # Read-only is about the body. Title, tags and category are edited elsewhere in the
    # UI and never race the document, and `PUT /notes/{id}` only refuses content — so
    # freezing the editor for these would make a note feel broken for no benefit.
    row = parked(session, monkeypatch, {"actions": [
        {"type": "rename_note", "noteId": "note-1", "title": "Renamed"},
        {"type": "set_tags", "noteId": "note-1", "tags": ["a"], "mode": "add"},
        {"type": "set_category", "noteId": "note-1", "categoryId": CATEGORY},
        {"type": "move_note", "noteId": "note-1", "folderId": None},
    ]})
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    result = assistant.approve_run(
        row.id, assistant.ApproveRequest(), request_for(USER), session
    )
    assert result.data.meta["touched_note_ids"] == []
    assert result.data.locks_note is False


def test_a_forward_ref_does_not_drag_in_the_note_that_happens_to_be_open(
    session, monkeypatch
):
    # `c1` is a note this plan is about to create, not a stale id — so it must not fall
    # through to the single-note fallback and hold the one note in context. The created
    # note cannot need holding either: nobody has it open yet.
    row = parked(session, monkeypatch, {"actions": [
        {"type": "create_note", "title": "New", "content": "x", "ref": "c1"},
        {"type": "add_reference", "noteId": "c1", "referenceNoteId": "note-1",
         "referenceTitle": "A note"},
    ]})
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    result = assistant.approve_run(
        row.id, assistant.ApproveRequest(), request_for(USER), session
    )
    assert result.data.meta["touched_note_ids"] == []


def test_a_parked_plan_says_which_notes_approving_would_rewrite(session, monkeypatch):
    # It holds nothing while it waits, so the review modal has no lock to read. This is
    # what lets it warn about edits made since the plan was asked for.
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "note-1", "content": "x"},
        {"type": "rename_note", "noteId": "note-1", "title": "Renamed"},
    ]})

    result = assistant.get_plan(row.id, request_for(USER), session)

    assert result.data["would_touch_note_ids"] == ["note-1"]
    assert KINDS["assistant"].to_activity(row).locks_note is False


def test_a_note_the_plan_names_but_context_does_not_allow_is_not_locked(session, monkeypatch):
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "not-allowed", "content": "x"},
    ]}, exec_ctx={"current_note_id": None, "valid_note_ids": ["note-1", "note-2"]}, note_id=None)
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    result = assistant.approve_run(
        row.id, assistant.ApproveRequest(), request_for(USER), session
    )
    assert result.data.meta["touched_note_ids"] == []


def test_an_oversized_plan_is_refused_at_approval(session, monkeypatch):
    row = parked(session, monkeypatch, {
        "actions": [{"type": "rename_note", "noteId": "note-1", "title": "x"}] * 51
    })
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)

    with pytest.raises(HTTPException) as raised:
        assistant.approve_run(row.id, assistant.ApproveRequest(), request_for(USER), session)
    assert raised.value.detail["code"] == "plan_too_large"


def test_declining_a_parked_plan_drops_it(session, monkeypatch):
    # cancel_activity only knows how to stop something that is running, and a parked
    # plan is not.
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    ]})

    result = assistant.cancel_run(row.id, request_for(USER), session)
    assert result.data.status == "cancelled"


# ─── reading turns back ──────────────────────────────────────────────────────


def test_listing_active_turns(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)

    listed = assistant.list_runs(request_for(USER), active=1, session=session)
    assert [j.id for j in listed.data] == [created.data.id]
    assert assistant.list_runs(request_for(OTHER), active=1, session=session).data == []


def test_a_parked_plan_is_found_by_its_own_listing_not_the_active_one(session, monkeypatch):
    # A reload loses the store, and /api/activity?active=1 deliberately does not list
    # something that is holding nothing — so the panel asks for these separately.
    row = parked(session, monkeypatch, {"actions": [{"type": "respond", "text": "hi"}]})

    assert assistant.list_runs(request_for(USER), active=1, session=session).data == []
    awaiting = assistant.list_runs(request_for(USER), awaiting=1, session=session)
    assert [j.id for j in awaiting.data] == [row.id]


def test_the_plan_comes_back_with_what_the_review_modal_needs(session, monkeypatch):
    row = parked(session, monkeypatch, {"actions": [
        {"type": "append_note", "noteId": "note-1", "content": "x"},
    ]})
    row.turn_ctx = json.dumps({"label_map": {"note-1": "A note"}, "found_note_ids": ["note-9"]})
    session.add(row)
    session.commit()

    data = assistant.get_plan(row.id, request_for(USER), session).data
    assert data["plan"]["actions"][0]["noteId"] == "note-1"
    assert data["label_map"] == {"note-1": "A note"}
    assert data["found_note_ids"] == ["note-9"]


def test_the_preview_reports_the_reply_so_far(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)
    row = session.get(AssistantRunJob, created.data.id)
    row.preview = "I'll start by..."
    row.stage = "Planning"
    session.add(row)
    session.commit()

    data = assistant.get_preview(created.data.id, request_for(USER), session).data
    assert data.text == "I'll start by..."
    assert data.phase == "planning"
    assert data.stage == "Planning"


def test_another_users_turn_is_not_readable(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)

    for call in (assistant.get_run, assistant.get_preview, assistant.get_plan):
        with pytest.raises(HTTPException) as raised:
            call(created.data.id, request_for(OTHER), session)
        assert raised.value.status_code == 404


def test_cancelling_a_turn_releases_its_note_immediately(session, monkeypatch):
    monkeypatch.setattr(assistant.worker, "enqueue", lambda job_id: None)
    monkeypatch.setattr(KINDS["assistant"], "cancel", lambda job_id: None)
    created = assistant.create_run(payload(), request_for(USER), session)

    result = assistant.cancel_run(created.data.id, request_for(USER), session)

    assert result.data.status == "cancelled"
    # Nothing derived from "still active" holds the note any more, whatever the
    # worker thread happens to be doing.
    assert assistant.list_runs(request_for(USER), active=1, session=session).data == []
