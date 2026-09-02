"""Transcription as a real background job.

What this is fixing: transcribing a recording takes minutes, and the result used to
depend on the browser still being open. The poll lived inside EditorView, died with
the component, and its best case was a toast saying *"reopen that note to attach it"*
— which nothing ever did, because the client was the only thing that could.

So the tests that matter are about the transcript arriving without help: the worker
attaches it itself, in the right place, exactly once, and not at all if the job was
stopped.
"""

import json
from datetime import datetime

import pytest
from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine, select

from app.jobs import registry
from app.models import Category, Note, TranscriptionJob
from app.routers import transcription

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
        s.add(Category(id=CATEGORY, label="Notes", emoji="📝", color="#000"))
        s.commit()
        yield s


def block(block_id: str, text_value: str) -> dict:
    return {
        "id": block_id, "type": "paragraph", "props": {},
        "content": [{"type": "text", "text": text_value, "styles": {}}], "children": [],
    }


def make_note(session, blocks, note_id="note-1", user_id=USER):
    now = datetime.utcnow()
    note = Note(id=note_id, title="Recording notes", content=json.dumps(blocks),
                category_id=CATEGORY, tags="[]", created_at=now, modified_at=now,
                user_id=user_id)
    session.add(note)
    session.commit()
    return note


def make_job(session, *, note_id="note-1", after="rec", status="processing", user_id=USER):
    now = datetime.utcnow()
    job = TranscriptionJob(
        id=f"job-{status}-{after}", user_id=user_id, source_filename="clip.webm",
        status=status, stage="Transcribing", progress=60,
        note_id=note_id, note_title="Recording notes", after_block_id=after,
        model="fal-ai/wizper", created_at=now, updated_at=now,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def blocks_of(session, note_id="note-1"):
    session.expire_all()
    return json.loads(session.get(Note, note_id).content)


# ─── attaching the transcript ────────────────────────────────────────────────


def test_the_transcript_lands_after_the_recording_it_came_from(session):
    make_note(session, [block("intro", "Before."), block("rec", "recording"), block("after", "After.")])
    job = make_job(session)

    assert transcription._attach_to_note(session, job, "/media/user-1/t.txt") is True

    kinds = [(b["id"], b["type"]) for b in blocks_of(session)]
    assert kinds[1][0] == "rec"
    assert kinds[2][1] == "file"      # directly after the recording
    assert kinds[3][0] == "after"


def test_it_appends_when_the_recording_block_has_since_been_deleted(session):
    # Placement is a nicety; losing the transcript is not acceptable.
    make_note(session, [block("intro", "Only this left.")])
    job = make_job(session, after="rec-that-is-gone")

    assert transcription._attach_to_note(session, job, "/media/user-1/t.txt") is True
    assert [b["type"] for b in blocks_of(session)] == ["paragraph", "file"]


def test_attaching_twice_is_a_no_op(session):
    """An open editor inserts it too, so both sides must be safe to run."""
    make_note(session, [block("rec", "recording")])
    job = make_job(session)

    transcription._attach_to_note(session, job, "/media/user-1/t.txt")
    transcription._attach_to_note(session, job, "/media/user-1/t.txt")

    assert sum(1 for b in blocks_of(session) if b["type"] == "file") == 1


def test_the_block_carries_the_transcript_url_and_a_name(session):
    make_note(session, [block("rec", "recording")])
    job = make_job(session)
    transcription._attach_to_note(session, job, "/media/user-1/t.txt")

    file_block = [b for b in blocks_of(session) if b["type"] == "file"][0]
    assert file_block["props"]["url"] == "/media/user-1/t.txt"
    assert "clip.webm" in file_block["props"]["name"]
    assert isinstance(file_block["id"], str) and file_block["id"]


def test_a_job_with_no_note_attaches_nowhere(session):
    job = make_job(session, note_id=None)
    assert transcription._attach_to_note(session, job, "/media/user-1/t.txt") is False


def test_it_never_writes_another_users_note(session):
    make_note(session, [block("rec", "recording")], user_id=OTHER)
    job = make_job(session)   # owned by USER, pointing at OTHER's note

    assert transcription._attach_to_note(session, job, "/media/user-1/t.txt") is False
    assert [b["type"] for b in blocks_of(session)] == ["paragraph"]


def test_unreadable_note_content_is_left_alone_rather_than_replaced(session):
    now = datetime.utcnow()
    session.add(Note(id="note-1", title="Broken", content="not json at all",
                     category_id=CATEGORY, tags="[]", created_at=now, modified_at=now,
                     user_id=USER))
    session.commit()
    job = make_job(session)

    assert transcription._attach_to_note(session, job, "/media/user-1/t.txt") is False
    assert session.get(Note, "note-1").content == "not json at all"


# ─── in the indicator ────────────────────────────────────────────────────────


def test_a_transcription_shows_up_as_activity_with_a_way_back_to_its_note(session):
    job = make_job(session)
    read = registry.get_job(session, USER, "transcription", job.id)

    assert read.kind == "transcription"
    assert read.note_id == "note-1"
    assert read.title == "Recording notes"
    assert read.stage == "Transcribing"
    assert read.progress == 60


def test_a_transcription_does_not_lock_its_note(session):
    # It appends a transcript; it does not rewrite the document.
    job = make_job(session)
    assert registry.get_job(session, USER, "transcription", job.id).locks_note is False
    assert registry.note_lock_holder(session, USER, "note-1") is None


def test_a_finished_transcription_offers_its_result(session):
    job = make_job(session, status="done")
    job.result_filename = "t.txt"
    session.add(job)
    session.commit()
    assert registry.get_job(session, USER, "transcription", job.id).result_url == "/media/user-1/t.txt"


def test_transcriptions_are_cancellable(session):
    assert registry.KINDS["transcription"].cancellable is True


# ─── the migration ───────────────────────────────────────────────────────────


def test_the_new_columns_are_added_to_an_existing_table(engine):
    """The table predates this change, so unlike every other job kind here it needs
    real migrations. A row written by the old schema has to survive them."""
    with engine.connect() as conn:
        conn.execute(text(
            "CREATE TABLE transcriptionjob ("
            " id VARCHAR PRIMARY KEY, user_id VARCHAR, source_filename VARCHAR,"
            " status VARCHAR, result_filename VARCHAR, error_message VARCHAR,"
            " created_at DATETIME, updated_at DATETIME)"
        ))
        conn.execute(text(
            "INSERT INTO transcriptionjob (id, user_id, source_filename, status,"
            " created_at, updated_at) VALUES ('old', 'user-1', 'clip.webm', 'done',"
            " '2020-01-01 00:00:00', '2020-01-01 00:00:00')"
        ))
        conn.commit()

    import app.database as database

    original = database.engine
    database.engine = engine
    try:
        database._run_migrations()
    finally:
        database.engine = original

    with Session(engine) as s:
        row = s.exec(select(TranscriptionJob)).one()
        assert row.id == "old"
        assert row.source_filename == "clip.webm"
        # New columns come back at their defaults rather than blowing up the read.
        assert row.note_id is None
        assert row.progress == 0
        assert row.stage == ""


# ─── cancelling ──────────────────────────────────────────────────────────────


def test_a_cancelled_job_never_starts_work(session, engine, monkeypatch):
    import app.database as database

    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(transcription, "engine", engine)
    monkeypatch.setattr(transcription._jobs, "is_cancelled", lambda job_id: True)
    make_note(session, [block("rec", "recording")])
    job = make_job(session, status="queued")

    transcription._run_job(job.id)

    session.expire_all()
    assert session.get(TranscriptionJob, job.id).status == "cancelled"
    # Nothing reached the note.
    assert [b["type"] for b in blocks_of(session)] == ["paragraph"]


def test_cancelling_asks_the_queue_to_stop(monkeypatch):
    """ffmpeg and the fal upload have no interruption points, so cancelling cannot
    stop the work — the guarantee is that the result is discarded, and the row leaves
    the indicator at once."""
    asked = []
    monkeypatch.setattr(transcription._jobs, "cancel", lambda job_id: asked.append(job_id))
    transcription.cancel("job-1")
    assert asked == ["job-1"]
