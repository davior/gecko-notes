"""Startup migrations against a database that already exists.

A fresh database never exercises these — `create_all` builds every table with every
column, so a migration that does nothing goes unnoticed. And each one swallows its own
error (that is how "column already exists" is made idempotent), so a migration naming
a table that does not exist fails silently too. The model then declares a column the
table lacks, and every read of that table raises.

That happened: `selected_content` was added against `video_render_job` rather than
`videorenderjob`. The activity API reads every job table in one union, so one missing
column took down the whole background-task indicator — assistant turns stuck at
"Queued 0%" while their replies had in fact arrived.
"""

import re
from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

import app.models  # noqa: F401  (registers every table on SQLModel.metadata)
from app.jobs import registry

DATABASE_PY = Path(__file__).resolve().parents[1] / "app" / "database.py"


@pytest.fixture
def engine():
    return create_engine("sqlite://", connect_args={"check_same_thread": False})


def run_migrations(engine, monkeypatch):
    import app.database as database

    monkeypatch.setattr(database, "engine", engine)
    database._run_migrations()


def columns_of(engine, table):
    return {c["name"] for c in inspect(engine).get_columns(table)}


def test_every_added_column_targets_a_table_that_exists():
    """The silent failure this file exists for, caught before it ships: a misspelt
    table name in a migration otherwise only shows up on somebody's real database."""
    source = DATABASE_PY.read_text()
    targets = set(re.findall(r"ALTER TABLE (\w+) ADD COLUMN", source))
    assert targets, "found no migrations to check — has the pattern changed?"

    unknown = targets - set(SQLModel.metadata.tables)
    assert not unknown, f"migrations add columns to tables that do not exist: {unknown}"


def test_an_existing_video_table_gains_selected_content(engine, monkeypatch):
    SQLModel.metadata.create_all(engine)
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE videorenderjob DROP COLUMN selected_content"))
        conn.commit()
    assert "selected_content" not in columns_of(engine, "videorenderjob")

    run_migrations(engine, monkeypatch)

    assert "selected_content" in columns_of(engine, "videorenderjob")


def test_the_activity_listing_reads_after_migrating_an_old_database(engine, monkeypatch):
    """What the header polls every two seconds. Before the fix this raised
    `no such column: videorenderjob.selected_content`."""
    SQLModel.metadata.create_all(engine)
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE videorenderjob DROP COLUMN selected_content"))
        conn.commit()

    run_migrations(engine, monkeypatch)

    with Session(engine) as session:
        assert registry.list_jobs(session, "user-1") == []
