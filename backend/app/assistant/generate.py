"""Phase two: writing the bodies the planner deferred.

The planner does not write long prose inline. For a content-bearing action it
describes what the body should contain in `spec` and leaves `content` empty; each one
is then written by its own model call. That is the slow part of a run — five minutes
of "write me an essay" is almost entirely this — and the reason it had to leave the
browser.

Steps are independent, so they go out several at a time, matching
`mapWithConcurrency` at GEN_CONCURRENCY in AIConversationPanel. They all read the same
cached prompt prefix, so parallelism costs nothing extra in tokens.

A step that fails does not fail the run: its action is dropped from what gets applied
and reported as its own row, exactly as `generatePlanContent` does today. Writing four
of five sections is worth more than discarding all five.
"""

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Tuple

from sqlmodel import Session

from app.assistant.executor import ActionResult, Cancelled
from app.assistant.provider import PromptContext, call_provider_text
from app.database import engine
from app.jobs.runner import readable_error

logger = logging.getLogger(__name__)

# Matches GEN_CONCURRENCY in AIConversationPanel.tsx.
GEN_CONCURRENCY = 5


def generate_bodies(
    user_id: str,
    plan: Dict[str, Any],
    ctx: PromptContext,
    *,
    check_cancelled: Callable[[], None] = lambda: None,
    on_progress: Callable[[int, int], None] = lambda done, total: None,
) -> Tuple[Dict[str, Any], List[ActionResult]]:
    """Fill in every deferred body.

    Returns the plan to run and a row per step that could not be written. Actions
    whose generation failed are removed, so the executor never writes an empty body
    over a real note.
    """
    actions = plan.get("actions") or []
    targets = [i for i, action in enumerate(actions) if _needs_generation(action)]
    if not targets:
        return plan, []

    check_cancelled()
    total = len(targets)
    steps = {int(step.get("index", -1)): step for step in ctx.steps}
    written: Dict[int, str] = {}
    failures: List[ActionResult] = []
    done = 0

    def write_one(index: int) -> Tuple[int, str, str]:
        """(index, body, error). Its own session — this runs off the request path."""
        step = steps.get(index)
        if step is None:
            return index, "", "no generation prompt was recorded for this step"
        try:
            with Session(engine) as session:
                body = call_provider_text(session, user_id, ctx, step)
            if not body.strip():
                return index, "", "the model returned an empty body"
            return index, body, ""
        except Exception as exc:
            logger.exception("Assistant body generation failed for step %d", index)
            return index, "", readable_error(exc)

    # Chunked fan-out rather than a full pool, mirroring mapWithConcurrency: it keeps
    # the cancellation check between batches, so a stopped run does not keep paying
    # for bodies nobody will read.
    for start in range(0, total, GEN_CONCURRENCY):
        check_cancelled()
        batch = targets[start:start + GEN_CONCURRENCY]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            for index, body, error in pool.map(write_one, batch):
                if error:
                    action = actions[index]
                    failures.append(ActionResult(
                        ok=False,
                        message=f'Could not write the body for "{action.get("type")}": {error}'[:500],
                    ))
                else:
                    written[index] = body
                done += 1
                # Per body rather than per batch: with several in flight the bar
                # should move as each one lands.
                on_progress(done, total)

    runnable = {
        **plan,
        "actions": [
            {**action, "content": written[i]} if i in written else action
            for i, action in enumerate(actions)
            if i not in targets or i in written
        ],
    }
    return runnable, failures


# Content-bearing action types, matching actionNeedsGeneration in aiPlan.ts.
_GENERATED_TYPES = frozenset({
    "create_note", "edit_note", "edit_section", "append_note", "create_child_note",
})


def _needs_generation(action: Dict[str, Any]) -> bool:
    """A step defers its body when it has a spec and no content."""
    if action.get("type") not in _GENERATED_TYPES:
        return False
    return bool((action.get("spec") or "").strip()) and not (action.get("content") or "").strip()


__all__ = ["generate_bodies", "GEN_CONCURRENCY", "Cancelled"]
