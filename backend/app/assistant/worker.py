"""The assistant run queue.

A run is: write the bodies the planner deferred, apply the plan's actions, then say
what happened in the conversation it came from. All three used to happen in the
browser, which is why walking away from a note lost the work — and why a run that
stopped half-way left no record of where it stopped.

Progress is split so the bar means something: writing bodies is the long part and
owns 0-70, applying the actions is quick and owns 70-99, and only completion writes
100. Cancellation is cooperative and checked at both, plus immediately before each
note write inside the executor.
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlmodel import Session

from app.assistant.executor import (
    ActionResult, Cancelled, ExecContext, PlanExecutor, build_result_summary,
)
from app.assistant.generate import generate_bodies
from app.assistant.provider import PromptContext
from app.database import engine
from app.jobs.runner import JobQueue, int_env, readable_error, set_fields as _set
from app.models import AISession, AssistantRunJob

logger = logging.getLogger(__name__)

MAX_CONCURRENCY = int_env("ASSISTANT_MAX_CONCURRENCY", 2)

# Where writing ends and applying begins, as a share of the progress bar.
WRITING_SHARE = 70


def cancel(job_id: str) -> None:
    """Ask a run to stop. It unwinds at its next checkpoint: between generation
    batches, between actions, or immediately before a note write."""
    _runs.cancel(job_id)


def is_cancelled(job_id: str) -> bool:
    return _runs.is_cancelled(job_id)


def enqueue(job_id: str) -> None:
    _runs.enqueue(job_id)


def _load(raw: str, fallback: Any) -> Any:
    try:
        value = json.loads(raw or "")
    except (ValueError, TypeError):
        return fallback
    return value if value is not None else fallback


def _append_to_session(session: Session, job: AssistantRunJob, text: str) -> None:
    """Write the run's summary into the conversation it came from.

    Done here rather than in the browser for the same reason the video worker attaches
    its result server-side: the tab that started this may be long gone, and the record
    of what happened belongs in the chat regardless of who is watching.
    """
    if not job.session_id or not text.strip():
        return
    row = session.get(AISession, job.session_id)
    if not row or row.user_id != job.user_id:
        return
    messages = _load(row.messages, [])
    if not isinstance(messages, list):
        messages = []
    messages.append({
        "id": str(uuid.uuid4()),
        "role": "assistant",
        "content": text,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    row.messages = json.dumps(messages)
    row.updated_at = datetime.utcnow()
    session.add(row)
    session.commit()


def _finish(
    session: Session,
    job_id: str,
    status: str,
    results: List[ActionResult],
    *,
    detail: str = "",
    error: Optional[str] = None,
) -> None:
    """Record the outcome and report it into the chat.

    A cancelled run still writes its rows: steps that ran are already applied, and a
    summary that omitted them would misrepresent the note.
    """
    row = session.get(AssistantRunJob, job_id)
    if not row:
        return
    _set(
        session, row,
        status=status,
        stage="",
        progress=100 if status == "done" else row.progress,
        detail=detail,
        results=json.dumps([r.to_dict() for r in results]),
        error_message=error,
    )

    summary = build_result_summary(results)
    if status == "cancelled":
        summary = (summary + "\n\n_Run cancelled._").strip()
    elif error:
        summary = (summary + f"\n\n_Run failed: {error}_").strip()
    try:
        _append_to_session(session, row, summary)
    except Exception:
        # A finished run must not be turned into a failure by bookkeeping.
        logger.exception("Could not write the summary for run %s into its session", job_id)


def _run_job(job_id: str) -> None:
    with Session(engine) as session:
        job = session.get(AssistantRunJob, job_id)
        if not job:
            return
        if is_cancelled(job_id):
            _set(session, job, status="cancelled", stage="", detail="Cancelled")
            return

        _set(session, job, status="processing", stage="Writing", progress=1, detail="")

        plan = _load(job.plan, {"actions": []})
        ctx = PromptContext(_load(job.prompt_ctx, {}))
        exec_ctx = ExecContext.from_json(job.exec_ctx, job.user_id)
        user_id = job.user_id

        def check_cancelled() -> None:
            if is_cancelled(job_id):
                raise Cancelled()

        def report(stage: str, progress: int, detail: str) -> None:
            with Session(engine) as inner:
                row = inner.get(AssistantRunJob, job_id)
                if row:
                    _set(inner, row, stage=stage, progress=max(0, min(99, progress)), detail=detail)

        results: List[ActionResult] = []
        try:
            # ── phase two: write the deferred bodies (0-70) ──────────────────
            def writing_progress(done: int, total: int) -> None:
                report("Writing", int(done / max(1, total) * WRITING_SHARE), f"{done} of {total} written")

            runnable, failures = generate_bodies(
                user_id, plan, ctx,
                check_cancelled=check_cancelled,
                on_progress=writing_progress,
            )
            results.extend(failures)

            # ── apply the plan (70-99) ───────────────────────────────────────
            actions = runnable.get("actions") or []
            report("Applying", WRITING_SHARE, f"0 of {len(actions)} steps")

            def applying_progress(index: int, total: int) -> None:
                share = int(index / max(1, total) * (99 - WRITING_SHARE))
                report("Applying", WRITING_SHARE + share, f"step {index + 1} of {total}")

            executor = PlanExecutor(
                session, exec_ctx,
                check_cancelled=check_cancelled,
                on_progress=applying_progress,
            )
            results.extend(executor.run(runnable))

        except Cancelled:
            session.rollback()
            _finish(session, job_id, "cancelled", results, detail="Cancelled")
            return
        except Exception as exc:
            logger.exception("Assistant run %s failed", job_id)
            session.rollback()
            _finish(session, job_id, "error", results, error=readable_error(exc)[:500])
            return

        failed = sum(1 for r in results if r.kind != "respond" and not r.ok)
        detail = f'{failed} step{"" if failed == 1 else "s"} could not be completed' if failed else ""
        _finish(session, job_id, "done", results, detail=detail)


# Defined after _run_job so the queue can be handed the real callable.
_runs = JobQueue(AssistantRunJob, _run_job, name="assistant-run", concurrency=MAX_CONCURRENCY)


def start() -> None:
    """Start the run worker(s). Called once from the app lifespan."""
    _runs.start()
