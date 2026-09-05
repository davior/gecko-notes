"""Retrieval rounds: the searches a plan asks for before it can be written.

A plan can come back asking to look something up rather than to do something —
`find_notes` against the user's own library, `web_search` against the web. Those are
never executed by `PlanExecutor` (its handlers for them are stubs); they are resolved
first, folded back into the conversation, and the model is asked to plan again with
what came back.

That loop used to run in the browser. It moved here with the rest of planning, because
a turn that pauses for a search is exactly the turn a user walks away from — and
because `valid_note_ids` has to grow to include whatever the search found, or the
executor refuses to touch the very notes the model just asked for.

One deliberate difference from the browser's version. There, a `find_notes` round
rebuilt `ctx.referenceBlock` — a *system* block — which invalidates the prompt cache
from the second breakpoint onward. Here the found bodies are appended to the follow-up
user turn instead, after the last breakpoint, so the whole cached prefix survives the
round and `base_body` never changes within a turn. The model sees the same text; the
round is simply cheaper, and `PromptContext.body_for` stays the only thing that has to
know how a request is assembled.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Mapping, Optional, Sequence

from sqlmodel import Session

from app.assistant.provider import WorkerRequest
from app.blocks import note_to_markdown
from app.models import Note

logger = logging.getLogger(__name__)

# One bounded budget shared by both kinds of search, so a model that keeps asking
# cannot search forever. Matches MAX_RETRIEVAL_ROUNDS in AIConversationPanel.
MAX_RETRIEVAL_ROUNDS = 4

# Matches MAX_WEB_SEARCHES_PER_ROUND.
MAX_WEB_SEARCHES_PER_ROUND = 3

# How many notes one round may fold in. Matches the browser's slice.
MAX_FOUND_NOTES = 50


class RetrievalContext:
    """What resolving a search needs to know about where the user is standing."""

    def __init__(
        self,
        *,
        current_folder_id: Optional[str] = None,
        folder_names: Optional[Mapping[str, str]] = None,
        use_summaries: bool = False,
    ) -> None:
        self.current_folder_id = current_folder_id
        self.folder_names = dict(folder_names or {})
        self.use_summaries = use_summaries


class RoundResult:
    """What one retrieval round produced.

    `turns` go on the end of the conversation — the searches the model asked for, then
    what they returned — and are all the next planning call needs. `found_note_ids` and
    `found_labels` are for the caller: the ids widen `valid_note_ids` so the executor
    will accept them, and the labels widen the map that names them in step prompts.
    """

    __slots__ = ("turns", "found_note_ids", "found_labels", "search_label")

    def __init__(
        self,
        turns: List[Dict[str, str]],
        found_note_ids: List[str],
        found_labels: Dict[str, str],
        search_label: str,
    ) -> None:
        self.turns = turns
        self.found_note_ids = found_note_ids
        self.found_labels = found_labels
        self.search_label = search_label


# ─── rendering what came back ────────────────────────────────────────────────


def format_note_meta(created_at: Any, modified_at: Any) -> str:
    """Compact timestamps for the context lists, or '' when there are none.

    Ported from `formatNoteMeta`; the browser passes the ISO strings the API returns,
    so datetimes are rendered the same way here.
    """
    parts = []
    if created_at:
        parts.append(f"created {_iso(created_at)}")
    if modified_at:
        parts.append(f"modified {_iso(modified_at)}")
    return f" ({', '.join(parts)})" if parts else ""


def _iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def format_web_search_results(response: Mapping[str, Any]) -> str:
    """One search's hits as the conversation text the model reads next.

    Numbered so it can refer to a specific hit, with each URL written out in full: the
    model is told to cite only links that appeared in the results, so those links have
    to be in front of it verbatim rather than paraphrased.
    """
    query = response.get("query") or ""
    results = response.get("results") or []
    if not results:
        return f"Web search for “{query}” returned no results."

    hits = []
    for i, hit in enumerate(results):
        published = f" (published {hit['published']})" if hit.get("published") else ""
        snippet = f"\n   {hit['snippet']}" if hit.get("snippet") else ""
        hits.append(f"{i + 1}. {hit.get('title') or ''}{published}\n   {hit.get('url') or ''}{snippet}")
    label = response.get("provider_label") or response.get("provider") or "web search"
    return f"Web search results for “{query}” (via {label}):\n" + "\n".join(hits)


def web_search_continuation(any_succeeded: bool) -> str:
    """What the model should do with the results it was just handed.

    `any_succeeded` is false when every search in the round errored — no key, a
    throttled backend, a dead SearXNG instance. Then it is told to say so, because the
    alternative is a confident answer invented to fill the gap.
    """
    if any_succeeded:
        return (
            'Continue with the original request using these results: reply with a "respond" '
            "action (citing the sources you used as Markdown links), or emit note actions "
            "that use what you found. Only search again if these results genuinely do not "
            "answer the question."
        )
    return (
        "The search did not run, so you have no results to work from. Tell the user plainly "
        "that the web search failed and repeat the reason above — do not answer from memory "
        "as though you had searched, and do not retry the same search."
    )


def describe_find_notes(action: Mapping[str, Any], ctx: RetrievalContext) -> str:
    """A find_notes action's scope in words.

    Never empty: it labels the round summary the model reads, and the list view uses
    it as its "Search Results" header, where an empty string trips a search reset.
    """
    parts: List[str] = []
    query = action.get("query")
    if query:
        parts.append(f'"{query}"')
    if "folderId" in action:
        resolved = ctx.current_folder_id if action["folderId"] == "current" else action["folderId"]
        folder_name = "the root" if resolved is None else ctx.folder_names.get(resolved, resolved)
        recursive = " (recursive)" if action.get("recursive") else ""
        parts.append(f'folder "{folder_name}"{recursive}')
    return " in ".join(parts) or "notes"


# ─── running the searches ────────────────────────────────────────────────────


def _find_notes_params(action: Mapping[str, Any], ctx: RetrievalContext) -> Dict[str, Any]:
    """The `list_notes` query for one action. Mirrors `findNotesParams`.

    Every argument is spelled out, including the ones the browser leaves to the URL.
    Called as a plain function, `list_notes` never goes through FastAPI's dependency
    resolution, so an omitted argument arrives as the `Query(...)` object itself
    rather than its default — which fails deep inside SQLAlchemy with an error that
    says nothing about the cause.
    """
    params: Dict[str, Any] = {
        "sort": "modified_at",
        "order": "desc",
        "limit": MAX_FOUND_NOTES,
        "offset": 0,
        "category_id": None,
        "folder_id": None,
        "in_folder": False,
        "search": None,
        "recursive": False,
        "include_children": False,
    }
    if action.get("query"):
        params["search"] = action["query"]
    if "folderId" in action:
        resolved = ctx.current_folder_id if action["folderId"] == "current" else action["folderId"]
        params["in_folder"] = True
        if resolved is not None:
            params["folder_id"] = resolved
        if action.get("recursive"):
            params["recursive"] = True
    return params


def _run_find_notes(
    session: Session,
    user_id: str,
    actions: Sequence[Mapping[str, Any]],
    ctx: RetrievalContext,
) -> tuple:
    """(summary text, found note ids, id→title). Hits are deduped across the round.

    Goes through the list endpoint's own function rather than rebuilding its query:
    which notes are visible is a surprisingly opinionated question here — archived
    notes are hidden, pinned notes surface at the root, child notes are folded into
    their parents — and a second copy of those rules would drift from the one the user
    sees in the list view.
    """
    from app.routers.notes import list_notes

    request = WorkerRequest(user_id)
    seen: List[str] = []
    for action in actions:
        try:
            found = list_notes(request=request, session=session, **_find_notes_params(action, ctx))
        except Exception:
            logger.exception("find_notes search failed")
            continue  # one failed search must not abandon the round
        for item in found.data:
            if item.id not in seen:
                seen.append(item.id)

    ids = seen[:MAX_FOUND_NOTES]
    notes = _load_notes(session, user_id, ids)
    labels = {note.id: note.title or "Untitled" for note in notes}
    scopes = ", ".join(describe_find_notes(a, ctx) for a in actions)

    if not notes:
        return (
            f"Search for {scopes} returned no notes. Continue with the original request "
            "(e.g. tell the user nothing matched).",
            [],
            {},
        )

    listing = "\n".join(
        f"- {n.id} — {n.title or 'Untitled'}{format_note_meta(n.created_at, n.modified_at)}"
        for n in notes
    )
    bodies = "\n\n---\n\n".join(_render_note(note, ctx) for note in notes)
    summary = (
        f"Search results for {scopes} — {len(notes)} note(s). Their full text follows; "
        f"target them by id.\n{listing}\n\n{bodies}\n\nContinue with the original request: "
        "reply, or emit actions targeting these note ids."
    )
    return summary, [n.id for n in notes], labels


def _load_notes(session: Session, user_id: str, ids: Sequence[str]) -> List[Note]:
    """Full rows for the ids found, in the order they were found, owner-checked."""
    notes = []
    for note_id in ids:
        note = session.get(Note, note_id)
        if note and note.user_id == user_id:
            notes.append(note)
    return notes


def _render_note(note: Note, ctx: RetrievalContext) -> str:
    """One found note as the model reads it: a heading carrying the id, then the body."""
    body = note.summary if (ctx.use_summaries and note.summary) else note_to_markdown(note.content)
    meta = format_note_meta(note.created_at, note.modified_at)
    return f"## {note.title or 'Untitled'} [id: {note.id}]{meta}\n\n{body}"


def _run_web_search(
    session: Session,
    user_id: str,
    actions: Sequence[Mapping[str, Any]],
) -> str:
    """The hits, verbatim, for every web_search in this round.

    A search that fails is reported as a failed search rather than dropped: told
    nothing, the model answers from memory as though it had searched.
    """
    import asyncio

    from app.routers.search import search_web_for_user

    blocks: List[str] = []
    any_succeeded = False
    for action in actions:
        query = action.get("query") or ""
        try:
            response = asyncio.run(
                search_web_for_user(session, user_id, query, action.get("maxResults"))
            )
            blocks.append(format_web_search_results(response))
            any_succeeded = True
        except Exception as exc:
            from app.jobs.runner import readable_error

            logger.warning("web search failed for %r: %s", query, exc)
            blocks.append(f"Web search for “{query}” failed: {readable_error(exc)}")
    return "\n\n".join([*blocks, web_search_continuation(any_succeeded)])


def run_retrieval_round(
    session: Session,
    user_id: str,
    retrieval_actions: Sequence[Mapping[str, Any]],
    ctx: RetrievalContext,
    *,
    web_search_enabled: bool = True,
) -> RoundResult:
    """Resolve one round's searches and produce the turns that continue the conversation.

    `web_search_enabled` is false for a provider that searches inside its own model
    call (Anthropic): there the action was never offered, and running it here would
    duplicate a search the model already did.
    """
    find_actions = [a for a in retrieval_actions if a.get("type") == "find_notes"]
    web_actions = (
        [a for a in retrieval_actions if a.get("type") == "web_search"][:MAX_WEB_SEARCHES_PER_ROUND]
        if web_search_enabled else []
    )

    summaries: List[str] = []
    found_ids: List[str] = []
    labels: Dict[str, str] = {}
    search_label = ""

    if find_actions:
        summary, found_ids, labels = _run_find_notes(session, user_id, find_actions, ctx)
        summaries.append(summary)
        search_label = ", ".join(
            a.get("description") or describe_find_notes(a, ctx) for a in find_actions
        ) or "Search results"

    if web_actions:
        summaries.append(_run_web_search(session, user_id, web_actions))

    turns = [
        {
            "role": "assistant",
            "content": json.dumps(
                {"actions": [*find_actions, *web_actions]},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        },
        {"role": "user", "content": "\n\n---\n\n".join(summaries)},
    ]
    return RoundResult(turns, found_ids, labels, search_label)


__all__ = [
    "MAX_RETRIEVAL_ROUNDS",
    "MAX_WEB_SEARCHES_PER_ROUND",
    "RetrievalContext",
    "RoundResult",
    "run_retrieval_round",
    "describe_find_notes",
    "format_note_meta",
    "format_web_search_results",
    "web_search_continuation",
]
