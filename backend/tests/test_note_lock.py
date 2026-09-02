"""Holding a note read-only while the assistant rewrites it — and letting go.

The lock is derived from job rows rather than stored on the note, and that is the
whole design: there is no lock state to strand. Cancelling a run releases the note
immediately, and a run whose heartbeat stops releases it without anyone doing
anything, because both are just "this job is no longer live".

A lock that cannot be cleared would be worse than no lock at all, so most of these
are about letting go rather than holding on.
"""

import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine, select

from app.jobs import registry
from app.jobs.runner import STALE_AFTER_MINUTES, JobQueue, is_stale
from app.models import AssistantRunJob, Category, Note
from app.routers import notes as notes_router
from app.schemas import NoteUpdate

USER = "user-1"
OTHER = "user-2"
CATEGORY = "cat-1"


@pytest.fixture
def engine():
    return create_engine("sqlite://", connect_args={"check_same_thread": False})


@pytest.fixture
def session(engine):
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        now = datetime.utcnow()
        s.add(Category(id=CATEGORY, label="Notes", emoji="📝", color="#000"))
        s.add(Note(id="note-1", title="A note", content="[]", category_id=CATEGORY,
                   tags="[]", created_at=now, modified_at=now, user_id=USER))
        s.commit()
        yield s


def request_for(user_id):
    return SimpleNamespace(state=SimpleNamespace(user_id=user_id))


def make_run(session, *, status="processing", touches=("note-1",), minutes_idle=0, user_id=USER):
    seen = datetime.utcnow() - timedelta(minutes=minutes_idle)
    job = AssistantRunJob(
        id=f"run-{status}-{minutes_idle}-{user_id}",
        user_id=user_id, note_id=touches[0] if touches else None,
        note_title="A note", status=status, stage="Writing", progress=40,
        touched_note_ids=json.dumps(list(touches)),
        created_at=seen, updated_at=seen,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


# ─── holding ─────────────────────────────────────────────────────────────────


def test_a_running_plan_holds_every_note_it_may_write(session):
    make_run(session, touches=("note-1", "note-2"))
    assert registry.note_lock_holder(session, USER, "note-1") is not None
    assert registry.note_lock_holder(session, USER, "note-2") is not None


def test_a_note_the_run_does_not_touch_is_free(session):
    make_run(session, touches=("note-1",))
    assert registry.note_lock_holder(session, USER, "note-9") is None


def test_a_run_serialises_as_locking_its_note(session):
    job = make_run(session)
    read = registry.get_job(session, USER, "assistant", job.id)
    assert read.locks_note is True
    assert read.meta["touched_note_ids"] == ["note-1"]


def test_a_render_does_not_lock_anything(session):
    # It appends on completion rather than holding the document open.
    from app.models import VideoRenderJob

    now = datetime.utcnow()
    session.add(VideoRenderJob(id="vid", user_id=USER, note_id="note-1", status="processing",
                               created_at=now, updated_at=now))
    session.commit()
    assert registry.note_lock_holder(session, USER, "note-1") is None


def test_another_users_run_never_locks_your_note(session):
    make_run(session, user_id=OTHER)
    assert registry.note_lock_holder(session, USER, "note-1") is None


# ─── the server-side guard ───────────────────────────────────────────────────


def test_saving_a_locked_note_is_refused(session):
    make_run(session)
    with pytest.raises(HTTPException) as raised:
        notes_router.update_note("note-1", NoteUpdate(content="[]"), request_for(USER), session)
    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "note_locked"


def test_the_guard_names_the_run_so_the_ui_can_point_at_it(session):
    job = make_run(session)
    with pytest.raises(HTTPException) as raised:
        notes_router.update_note("note-1", NoteUpdate(content="[]"), request_for(USER), session)
    assert raised.value.detail["job_id"] == job.id


def test_a_lock_only_refuses_content_writes(session):
    """Renaming or retagging never races the body, and blocking them would make a
    locked note feel broken rather than busy."""
    make_run(session)
    result = notes_router.update_note("note-1", NoteUpdate(title="Renamed"), request_for(USER), session)
    assert result.data.title == "Renamed"


def test_an_unlocked_note_saves_normally(session):
    result = notes_router.update_note("note-1", NoteUpdate(content="[]"), request_for(USER), session)
    assert result.data.id == "note-1"


# ─── letting go ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("status", ["done", "error", "cancelled"])
def test_a_finished_run_holds_nothing(session, status):
    make_run(session, status=status)
    assert registry.note_lock_holder(session, USER, "note-1") is None


def test_cancelling_releases_the_note_at_once(session, monkeypatch):
    from app.routers import activity

    monkeypatch.setattr(registry.KINDS["assistant"], "cancel", lambda job_id: None)
    job = make_run(session)
    assert registry.note_lock_holder(session, USER, "note-1") is not None

    activity.cancel_activity("assistant", job.id, request_for(USER), session)

    # Released without waiting for the worker to notice — which is the point, since
    # the worker may be wedged inside a slow upstream call.
    assert registry.note_lock_holder(session, USER, "note-1") is None
    notes_router.update_note("note-1", NoteUpdate(content="[]"), request_for(USER), session)


def test_a_run_whose_heartbeat_stopped_releases_the_note_on_its_own(session):
    make_run(session, minutes_idle=STALE_AFTER_MINUTES + 1)
    assert registry.note_lock_holder(session, USER, "note-1") is None
    # And saving works again, with nobody having pressed anything.
    notes_router.update_note("note-1", NoteUpdate(content="[]"), request_for(USER), session)


def test_a_stalled_run_reports_itself_as_no_longer_locking(session):
    job = make_run(session, minutes_idle=STALE_AFTER_MINUTES + 1)
    assert registry.get_job(session, USER, "assistant", job.id).locks_note is False


def test_a_run_that_is_merely_slow_still_holds_its_note(session):
    """The window has to tolerate a long generation call between progress ticks —
    killing live work is far worse than a note staying locked a little longer."""
    make_run(session, minutes_idle=STALE_AFTER_MINUTES - 1)
    assert registry.note_lock_holder(session, USER, "note-1") is not None


# ─── the sweeper ─────────────────────────────────────────────────────────────


def test_is_stale_only_applies_to_live_jobs(session):
    old_and_done = make_run(session, status="done", minutes_idle=STALE_AFTER_MINUTES + 10)
    assert is_stale(old_and_done) is False


def test_the_sweeper_ends_a_stalled_run_and_tells_its_worker_to_unwind(session, engine, monkeypatch):
    import app.jobs.runner as runner

    monkeypatch.setattr(runner, "engine", engine)
    job = make_run(session, minutes_idle=STALE_AFTER_MINUTES + 1)
    queue = JobQueue(AssistantRunJob, lambda job_id: None, name="test")

    assert queue.sweep_stale() == 1

    session.expire_all()
    row = session.get(AssistantRunJob, job.id)
    assert row.status == "error"
    assert "Stopped responding" in row.error_message
    # Cancelling as well as marking is what stops a thread that later returns from a
    # wedged call from writing to a note the lock has already released.
    assert queue.is_cancelled(job.id) is True


def test_the_sweeper_leaves_healthy_runs_alone(session, engine, monkeypatch):
    import app.jobs.runner as runner

    monkeypatch.setattr(runner, "engine", engine)
    job = make_run(session, minutes_idle=0)
    queue = JobQueue(AssistantRunJob, lambda job_id: None, name="test")

    assert queue.sweep_stale() == 0
    assert session.get(AssistantRunJob, job.id).status == "processing"
    assert queue.is_cancelled(job.id) is False


@pytest.mark.parametrize("status", ["done", "error", "cancelled"])
def test_a_finished_run_reports_that_it_locks_nothing(session, status):
    """`is_stale` only speaks about live jobs, so locking has to check the status too
    — otherwise a finished run advertises a lock it is not holding."""
    job = make_run(session, status=status)
    assert registry.get_job(session, USER, "assistant", job.id).locks_note is False
