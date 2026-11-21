"""What a turn did and what it has cost so far, written onto its job row as it happens.

GVC's assistant shows each step of a turn as it is taken ("Searching the web: …",
"Reading …", "Proposed: …") and what the turn has cost so far; this is the same for
Notes. The panel reads both through the preview endpoint while the turn runs, and the
steps are kept on the reply in the chat afterwards.

Several threads write here at once (the deferred bodies are written in parallel), so
every write is under one lock and the cost is added in SQL rather than read, summed and
written back.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlmodel import Session

from app.database import engine
from app.jobs.runner import set_fields
from app.models import AssistantRunJob

logger = logging.getLogger(__name__)

# Enough for any turn worth reading back; a runaway one keeps its latest steps.
MAX_STEPS_KEPT = 60
MAX_STEP_CHARS = 600

_lock = threading.Lock()


def load_steps(raw: Optional[str]) -> List[Dict[str, str]]:
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [s for s in value if isinstance(s, dict)] if isinstance(value, list) else []


class TurnLog:
    """One turn's steps and running cost. Best-effort: a failed write is logged, never
    raised, because bookkeeping must not fail the turn it describes."""

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id

    def step(self, kind: str, text_: str) -> None:
        text_ = " ".join((text_ or "").split())[:MAX_STEP_CHARS]
        if not text_:
            return
        try:
            with _lock, Session(engine) as session:
                row = session.get(AssistantRunJob, self.job_id)
                if row is None:
                    return
                steps = load_steps(row.steps)
                steps.append({"kind": kind, "text": text_})
                set_fields(session, row, steps=json.dumps(steps[-MAX_STEPS_KEPT:], ensure_ascii=False))
        except Exception:
            logger.exception("Could not record a step for turn %s", self.job_id)

    def cost(self, amount: Optional[float]) -> None:
        """Add one call's cost. None is an unknown cost (an unpriced model) and adds
        nothing, so the total shown is what is known, never a guess of zero."""
        if amount is None:
            return
        try:
            with _lock, Session(engine) as session:
                session.execute(
                    text("UPDATE assistantrunjob SET cost = ROUND(COALESCE(cost, 0) + :amount, 6) WHERE id = :id"),
                    {"amount": float(amount), "id": self.job_id},
                )
                session.commit()
        except Exception:
            logger.exception("Could not record the cost of turn %s", self.job_id)


def steps_of(job: Any) -> List[Dict[str, str]]:
    return load_steps(getattr(job, "steps", None))


__all__ = ["TurnLog", "load_steps", "steps_of", "MAX_STEPS_KEPT"]
