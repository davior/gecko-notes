"""The activity API — one view over every background job table.

Two things matter here and both are easy to get wrong silently. The union must
never hand one user another user's jobs, and cancelling must take effect from the
caller's point of view immediately rather than waiting on a worker thread that may
be stuck inside a slow upstream call — because what "active" means is what the
header shows, and (from the note-locking work) what holds a note read-only.

The restart-recovery tests cover the other half of durability: a job interrupted by
a process restart has to come back, and one somebody cancelled has to stay dead.
"""

import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlmodel import Session, SQLModel, create_engine, select

from app.jobs import registry
from app.jobs.runner import JobQueue
from app.models import VideoRenderJob
from app.routers import activity

USER = "user-1"
OTHER_USER = "user-2"


# ─── fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def engine():
    return create_engine("sqlite://", connect_args={"check_same_thread": False})


@pytest.fixture
def session(engine):
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def request_for(user_id):
    """The middleware puts the caller on request.state; that is all these read."""
    return SimpleNamespace(state=SimpleNamespace(user_id=user_id))


def make_render(session, *, user_id=USER, status="processing", minutes_ago=0, **fields):
    now = datetime.utcnow() - timedelta(minutes=minutes_ago)
    job = VideoRenderJob(
        id=fields.pop("id", f"job-{minutes_ago}-{user_id}-{status}"),
        user_id=user_id,
        note_id=fields.pop("note_id", "note-1"),
        note_title=fields.pop("note_title", "A note"),
        status=status,
        created_at=now,
        updated_at=now,
        **fields,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


# ─── the union ───────────────────────────────────────────────────────────────


def test_listing_returns_the_callers_jobs(session):
    make_render(session, id="mine")
    jobs = registry.list_jobs(session, USER)
    assert [j.id for j in jobs] == ["mine"]
    assert jobs[0].kind == "video"


def test_listing_never_leaks_another_users_jobs(session):
    make_render(session, id="mine", user_id=USER)
    make_render(session, id="theirs", user_id=OTHER_USER)
    assert [j.id for j in registry.list_jobs(session, USER)] == ["mine"]
    assert [j.id for j in registry.list_jobs(session, OTHER_USER)] == ["theirs"]


def test_listing_is_newest_first(session):
    make_render(session, id="old", minutes_ago=30)
    make_render(session, id="new", minutes_ago=1)
    assert [j.id for j in registry.list_jobs(session, USER)] == ["new", "old"]


def test_active_only_keeps_queued_and_processing(session):
    make_render(session, id="queued", status="queued")
    make_render(session, id="running", status="processing")
    make_render(session, id="finished", status="done")
    make_render(session, id="stopped", status="cancelled")
    make_render(session, id="broken", status="error")

    active = {j.id for j in registry.list_jobs(session, USER, active_only=True)}
    assert active == {"queued", "running"}


def test_the_unfiltered_listing_still_shows_finished_work(session):
    """The header polls unfiltered while something runs, so it can watch a job
    reach "done" rather than just disappear from the active list."""
    make_render(session, id="finished", status="done")
    assert [j.id for j in registry.list_jobs(session, USER)] == ["finished"]


def test_limit_is_applied_across_the_union_not_per_kind(session):
    for n in range(5):
        make_render(session, id=f"job-{n}", minutes_ago=n)
    assert len(registry.list_jobs(session, USER, limit=3)) == 3


# ─── serialisation ───────────────────────────────────────────────────────────


def test_a_render_serialises_with_its_note_and_result(session):
    job = make_render(
        session,
        id="done-1",
        status="done",
        progress=100,
        result_filename="out.mp4",
        subtitle_filename="out.srt",
        duration_seconds=12.5,
        size_bytes=2048,
    )
    read = registry.get_job(session, USER, "video", job.id)

    assert read.kind == "video"
    assert read.title == "A note"
    assert read.note_id == "note-1"
    assert read.result_url == f"/media/{USER}/out.mp4"
    assert read.meta["subtitle_url"] == f"/media/{USER}/out.srt"
    assert read.meta["duration_seconds"] == 12.5
    assert read.meta["size_bytes"] == 2048


def test_a_render_does_not_lock_its_note(session):
    # It appends on completion rather than holding the document, so the editor
    # stays editable while it runs.
    job = make_render(session)
    assert registry.get_job(session, USER, "video", job.id).locks_note is False


def test_auto_insert_is_read_out_of_the_stored_render_options(session):
    on = make_render(session, id="on", options=json.dumps({"insert_into_note": True}))
    off = make_render(session, id="off", options=json.dumps({"insert_into_note": False}))

    assert registry.get_job(session, USER, "video", on.id).meta["auto_insert"] is True
    assert registry.get_job(session, USER, "video", off.id).meta["auto_insert"] is False


def test_auto_insert_defaults_on_when_options_are_absent_or_unreadable(session):
    empty = make_render(session, id="empty", options="")
    junk = make_render(session, id="junk", options="{not json")

    assert registry.get_job(session, USER, "video", empty.id).meta["auto_insert"] is True
    assert registry.get_job(session, USER, "video", junk.id).meta["auto_insert"] is True


def test_a_job_with_no_result_yet_has_no_result_url(session):
    job = make_render(session)
    assert registry.get_job(session, USER, "video", job.id).result_url is None


def test_created_at_serialises_with_an_explicit_utc_offset(session):
    """The header shows each job's age, and that reading depends on this.

    Job rows stamp `created_at` with `datetime.utcnow()`, and SQLite hands it back
    without tzinfo. Serialised bare, `new Date(...)` in the browser reads it as *local*
    time, so a job started seconds ago renders as hours old — wrong by exactly the
    viewer's UTC offset, and invisible to anyone testing in UTC. `UTCDatetime` tags it.
    """
    job = make_render(session)
    read = registry.get_job(session, USER, "video", job.id)

    encoded = json.loads(read.model_dump_json())["created_at"]
    assert encoded.endswith("+00:00"), encoded
    assert datetime.fromisoformat(encoded).utcoffset() == timedelta(0)


# ─── reading one job ─────────────────────────────────────────────────────────


def test_another_users_job_is_not_readable(session):
    job = make_render(session, id="theirs", user_id=OTHER_USER)
    assert registry.get_job(session, USER, "video", job.id) is None


def test_an_unknown_kind_reads_as_nothing(session):
    make_render(session, id="mine")
    assert registry.get_job(session, USER, "podcast", "mine") is None


def test_the_endpoint_404s_on_an_unknown_kind(session):
    with pytest.raises(HTTPException) as raised:
        activity.get_activity("podcast", "x", request_for(USER), session)
    assert raised.value.status_code == 404
    assert raised.value.detail["code"] == "unknown_kind"


def test_the_endpoint_404s_on_another_users_job(session):
    job = make_render(session, id="theirs", user_id=OTHER_USER)
    with pytest.raises(HTTPException) as raised:
        activity.get_activity("video", job.id, request_for(USER), session)
    assert raised.value.status_code == 404


# ─── cancelling ──────────────────────────────────────────────────────────────


def test_cancelling_marks_the_row_immediately_and_tells_the_worker(session, monkeypatch):
    """The row is marked here rather than by the worker, so anything derived from
    "still active" is released even if the worker is wedged in a slow call."""
    asked = []
    monkeypatch.setattr(
        registry.KINDS["video"], "cancel", lambda job_id: asked.append(job_id)
    )

    job = make_render(session, id="running", status="processing", progress=40)
    result = activity.cancel_activity("video", job.id, request_for(USER), session)

    assert result.data.status == "cancelled"
    assert session.get(VideoRenderJob, job.id).status == "cancelled"
    assert asked == [job.id]


def test_cancelling_drops_the_job_out_of_the_active_set(session, monkeypatch):
    monkeypatch.setattr(registry.KINDS["video"], "cancel", lambda job_id: None)
    job = make_render(session, id="running", status="processing")

    activity.cancel_activity("video", job.id, request_for(USER), session)

    assert registry.list_jobs(session, USER, active_only=True) == []


def test_cancelling_a_finished_job_leaves_it_alone(session, monkeypatch):
    asked = []
    monkeypatch.setattr(
        registry.KINDS["video"], "cancel", lambda job_id: asked.append(job_id)
    )
    job = make_render(session, id="finished", status="done", progress=100)

    result = activity.cancel_activity("video", job.id, request_for(USER), session)

    assert result.data.status == "done"
    assert asked == []


def test_cancelling_another_users_job_404s(session, monkeypatch):
    monkeypatch.setattr(registry.KINDS["video"], "cancel", lambda job_id: None)
    job = make_render(session, id="theirs", user_id=OTHER_USER, status="processing")

    with pytest.raises(HTTPException) as raised:
        activity.cancel_activity("video", job.id, request_for(USER), session)
    assert raised.value.status_code == 404
    assert session.get(VideoRenderJob, job.id).status == "processing"


def test_a_kind_with_no_cancel_function_reports_that_rather_than_pretending(
    session, monkeypatch
):
    monkeypatch.setattr(registry.KINDS["video"], "cancel", None)
    job = make_render(session, id="running", status="processing")

    with pytest.raises(HTTPException) as raised:
        activity.cancel_activity("video", job.id, request_for(USER), session)
    assert raised.value.status_code == 409
    assert raised.value.detail["code"] == "not_cancellable"


# ─── restart recovery ────────────────────────────────────────────────────────


def test_unfinished_jobs_are_requeued_after_a_restart(session, engine, monkeypatch):
    import app.jobs.runner as runner

    monkeypatch.setattr(runner, "engine", engine)
    make_render(session, id="was-queued", status="queued")
    make_render(session, id="was-running", status="processing", progress=60)

    queue = JobQueue(VideoRenderJob, lambda job_id: None, name="test")
    queue.recover_pending()

    requeued = {queue._queue.get_nowait() for _ in range(2)}
    assert requeued == {"was-queued", "was-running"}

    for row in session.exec(select(VideoRenderJob)).all():
        session.refresh(row)
        assert row.status == "queued"
        assert row.progress == 0
        assert row.detail == "Requeued after a restart"


def test_a_restart_does_not_resurrect_finished_or_cancelled_jobs(
    session, engine, monkeypatch
):
    import app.jobs.runner as runner

    monkeypatch.setattr(runner, "engine", engine)
    make_render(session, id="done", status="done")
    make_render(session, id="cancelled", status="cancelled")
    make_render(session, id="error", status="error")

    queue = JobQueue(VideoRenderJob, lambda job_id: None, name="test")
    queue.recover_pending()

    assert queue._queue.empty()


def test_cancelling_is_remembered_until_the_job_leaves_the_queue(session):
    queue = JobQueue(VideoRenderJob, lambda job_id: None, name="test")
    assert queue.is_cancelled("x") is False
    queue.cancel("x")
    assert queue.is_cancelled("x") is True
