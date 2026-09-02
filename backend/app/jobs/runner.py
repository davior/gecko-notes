"""The queue and worker threads a background job kind runs on.

Lifted from `video/worker.py`, whose docstring still holds and is worth repeating,
because it is the reason this is threads-and-a-queue rather than something simpler:

    Renders run on a dedicated worker thread rather than through FastAPI's
    BackgroundTasks, for three reasons: an x264 encode saturates the CPU and shares
    its container with the API, so unbounded parallel renders would starve request
    handling; a job needs to be cancellable mid-encode; and a render that was
    in flight when the process restarted needs to be picked up again rather than
    left stuck at "processing" forever.

A kind supplies its table and a `run(job_id)` function; everything else — the
queue, the worker threads, cooperative cancellation, and re-queueing work that
outlived the process doing it — is here.

Single process only, deliberately. `_queue` and `_cancelled` are per-process
state, so cancellation and the concurrency cap only hold within one interpreter.
That matches how this app is deployed (one uvicorn process over SQLite); running
several workers or replicas would need the queue to move into the database or a
broker, and this file is where that change would go.
"""

import logging
import os
import queue
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Optional, Set, Type

from sqlmodel import Session, select

from app.database import engine

logger = logging.getLogger(__name__)

# A job is "active" while it is waiting for, or sitting on, a worker thread. The
# activity API and the note lock both key off this.
ACTIVE_STATUSES = ("queued", "processing")

def int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


# How long a job may go without its heartbeat moving before it is treated as dead.
# `set_fields` touches `updated_at` on every progress tick, so this is free — but it
# has to be generous: one long generation call can legitimately run for minutes
# between ticks, and killing live work is far worse than a note staying locked a
# little longer.
STALE_AFTER_MINUTES = int_env("JOB_STALE_MINUTES", 15)

# How often the sweeper looks for them.
STALE_SWEEP_SECONDS = int_env("JOB_STALE_SWEEP_SECONDS", 60)


def is_stale(job: Any) -> bool:
    """True when an active job has stopped reporting progress.

    This is what stops a crashed or wedged worker from holding a note read-only
    forever: nothing derived from "still active" believes a job whose heartbeat
    stopped, so the lock releases on its own without anyone pressing anything.
    """
    if getattr(job, "status", None) not in ACTIVE_STATUSES:
        return False
    updated = getattr(job, "updated_at", None)
    if not updated:
        return False
    return datetime.utcnow() - updated > timedelta(minutes=STALE_AFTER_MINUTES)


def set_fields(session: Session, job: Any, **fields: Any) -> None:
    """Write fields to a job row and commit, touching `updated_at`.

    `updated_at` moving on every progress tick is what makes it a heartbeat: a row
    that stops advancing is a worker that stopped working.
    """
    for key, value in fields.items():
        setattr(job, key, value)
    job.updated_at = datetime.utcnow()
    session.add(job)
    session.commit()


def readable_error(exc: Exception) -> str:
    """Turn an exception into something worth showing in the UI.

    Callers raise FastAPI's HTTPException, whose str() is the raw
    `400: {'code': ..., 'message': ...}` repr; the message inside it is the part
    a user can act on ("fal.ai API key is not configured").
    """
    detail = getattr(exc, "detail", None)
    if isinstance(detail, dict) and detail.get("message"):
        return str(detail["message"])
    if isinstance(detail, str) and detail:
        return detail
    return str(exc)


class JobQueue:
    """One queue, its worker threads, and the cancellation set for a job table."""

    def __init__(
        self,
        model: Type[Any],
        run: Callable[[str], None],
        *,
        name: str,
        concurrency: int = 1,
    ) -> None:
        self.model = model
        self.run = run
        self.name = name
        self.concurrency = max(1, concurrency)
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._cancelled: Set[str] = set()
        self._lock = threading.Lock()
        self._started = False

    # ─── control ─────────────────────────────────────────────────────────────

    def enqueue(self, job_id: str) -> None:
        self._queue.put(job_id)

    def cancel(self, job_id: str) -> None:
        """Ask a job to stop. A queued job never starts; a running one unwinds at
        its next checkpoint, wherever the kind chose to put those."""
        with self._lock:
            self._cancelled.add(job_id)

    def is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._cancelled

    # ─── lifecycle ───────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the worker threads and requeue anything a restart interrupted.
        Idempotent, because the app lifespan is not the only thing that may call it
        (tests start queues directly)."""
        if self._started:
            return
        self._started = True

        for index in range(self.concurrency):
            threading.Thread(
                target=self._loop, daemon=True, name=f"{self.name}-{index}"
            ).start()
        threading.Thread(
            target=self._sweeper, daemon=True, name=f"{self.name}-sweep"
        ).start()
        self.recover_pending()

    def sweep_stale(self) -> int:
        """Fail jobs whose heartbeat stopped, and tell their worker to unwind.

        Cancelling as well as marking matters: a thread that later comes back from a
        wedged call must not write to a note the lock has already released, and the
        cancelled set is what its next checkpoint reads.
        """
        swept = 0
        try:
            with Session(engine) as session:
                rows = session.exec(
                    select(self.model).where(self.model.status.in_(ACTIVE_STATUSES))
                ).all()
                for row in rows:
                    if not is_stale(row):
                        continue
                    self.cancel(row.id)
                    fields: dict = {
                        "status": "error",
                        "error_message": "Stopped responding and was ended automatically",
                    }
                    if hasattr(row, "stage"):
                        fields["stage"] = ""
                    set_fields(session, row, **fields)
                    swept += 1
                if swept:
                    logger.warning("Ended %d stalled %s job(s)", swept, self.name)
        except Exception:
            logger.exception("Could not sweep stalled %s jobs", self.name)
        return swept

    def _sweeper(self) -> None:
        while True:
            time.sleep(STALE_SWEEP_SECONDS)
            self.sweep_stale()

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                self.run(job_id)
            except Exception:
                logger.exception("Unhandled error in the %s worker", self.name)
            finally:
                with self._lock:
                    self._cancelled.discard(job_id)
                self._queue.task_done()

    def recover_pending(self) -> None:
        """Re-enqueue work that outlived the process that was doing it.

        A job left at "processing" by a restart has no worker any more, so it goes
        back on the queue and starts over. Cancelled and finished rows are not
        touched, so a restart never resurrects a run somebody stopped.
        """
        try:
            with Session(engine) as session:
                rows = session.exec(
                    select(self.model).where(self.model.status.in_(ACTIVE_STATUSES))
                ).all()
                for row in rows:
                    fields: dict = {"status": "queued"}
                    # Not every job table carries progress columns.
                    if hasattr(row, "stage"):
                        fields["stage"] = ""
                    if hasattr(row, "progress"):
                        fields["progress"] = 0
                    if hasattr(row, "detail"):
                        fields["detail"] = "Requeued after a restart"
                    set_fields(session, row, **fields)
                    self._queue.put(row.id)
                if rows:
                    logger.info(
                        "Requeued %d unfinished %s job(s)", len(rows), self.name
                    )
        except Exception:
            logger.exception("Could not recover pending %s jobs", self.name)


def progress_reporter(
    queue_: JobQueue,
    job_id: str,
    on_cancel: Callable[[], None],
) -> Callable[[str, int, str], None]:
    """Build the `(stage, percent, detail)` callback a long job reports through.

    It doubles as the cancellation checkpoint — `on_cancel` is expected to raise, so
    a job unwinds wherever it happens to be reporting progress rather than needing
    its own polling. Percent clamps to 99 so only completion writes 100, and each
    tick opens its own session because this runs on a worker thread, not a request.
    """

    def report(stage: str, percent: int, detail: str) -> None:
        if queue_.is_cancelled(job_id):
            on_cancel()
        with Session(engine) as session:
            row = session.get(queue_.model, job_id)
            if row:
                set_fields(
                    session,
                    row,
                    stage=stage,
                    progress=max(0, min(99, percent)),
                    detail=detail,
                )

    return report
