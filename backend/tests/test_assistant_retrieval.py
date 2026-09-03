"""Retrieval rounds, and finishing a turn the provider left open.

Both exist because planning moved to the server. A plan that asks to search is the
plan a user walks away from, so the search has to resolve without a browser — and the
one provider quirk `ai.ts` grew for the searching turn had to come with it.

`tools/plan_parse_diff/` covers the pure ports. These are the parts it cannot reach:
the round talks to the database, and the stall recovery is shaped by reply payloads
rather than by text in and text out.
"""

import json
from datetime import datetime

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.assistant.continuation import (
    FINISH_TURN_REQUEST,
    TRUNCATION_NOTICE,
    continuation_body,
    extract_plan_text,
    finalize_plan_text,
    is_stalled_turn,
    stalled_turn_as_text,
)
from app.assistant.retrieve import (
    MAX_WEB_SEARCHES_PER_ROUND,
    RetrievalContext,
    describe_find_notes,
    format_note_meta,
    format_web_search_results,
    run_retrieval_round,
    web_search_continuation,
)
from app.blocks import markdown_to_blocks
from app.models import Category, Note

USER = "user-1"
OTHER = "user-2"
CATEGORY = "cat-1"


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Category(id=CATEGORY, label="Notes", emoji="📝", color="#000"))
        s.commit()
        yield s


def make_note(session, note_id, title, markdown="", *, user_id=USER, folder_id=None, summary=None):
    now = datetime.utcnow()
    note = Note(
        id=note_id,
        title=title,
        content=json.dumps(markdown_to_blocks(markdown)),
        category_id=CATEGORY,
        folder_id=folder_id,
        tags="[]",
        summary=summary,
        created_at=now,
        modified_at=now,
        user_id=user_id,
    )
    session.add(note)
    session.commit()
    return note


# ─── finding notes ───────────────────────────────────────────────────────────


def test_a_find_notes_round_returns_the_ids_the_executor_will_need(session):
    # This is the point of resolving retrieval server-side: valid_note_ids has to grow
    # to include what the search turned up, or the executor refuses the very notes the
    # model just asked for.
    make_note(session, "n1", "Gecko habits", "# Gecko habits\n\nThey climb.")
    make_note(session, "n2", "Unrelated", "Nothing here.")

    result = run_retrieval_round(
        session, USER, [{"type": "find_notes", "query": "Gecko"}], RetrievalContext()
    )

    assert "n1" in result.found_note_ids
    assert result.found_labels["n1"] == "Gecko habits"


def test_the_found_bodies_keep_their_headings(session):
    # edit_section targets a heading by name, so a body flattened to prose is a body
    # the model can no longer edit precisely.
    make_note(session, "n1", "Doc", "# Doc\n\n## Intro\n\nText here.\n\n## Outro\n\nMore.")

    result = run_retrieval_round(
        session, USER, [{"type": "find_notes", "query": "Doc"}], RetrievalContext()
    )

    body = result.turns[1]["content"]
    assert "## Intro" in body
    assert "## Outro" in body


def test_a_summary_is_used_instead_of_the_body_when_asked_for(session):
    make_note(session, "n1", "Doc", "# Doc\n\nThe full body.", summary="A short summary.")

    with_summaries = run_retrieval_round(
        session, USER, [{"type": "find_notes", "query": "Doc"}],
        RetrievalContext(use_summaries=True),
    )
    without = run_retrieval_round(
        session, USER, [{"type": "find_notes", "query": "Doc"}], RetrievalContext()
    )

    assert "A short summary." in with_summaries.turns[1]["content"]
    assert "The full body." not in with_summaries.turns[1]["content"]
    assert "The full body." in without.turns[1]["content"]


def test_hits_are_deduped_across_the_actions_in_one_round(session):
    make_note(session, "n1", "Gecko", "Gecko notes")

    result = run_retrieval_round(
        session,
        USER,
        [{"type": "find_notes", "query": "Gecko"}, {"type": "find_notes", "query": "Gecko"}],
        RetrievalContext(),
    )

    assert result.found_note_ids == ["n1"]


def test_another_users_notes_are_never_folded_in(session):
    make_note(session, "mine", "Shared word", "x")
    make_note(session, "theirs", "Shared word", "x", user_id=OTHER)

    result = run_retrieval_round(
        session, USER, [{"type": "find_notes", "query": "Shared"}], RetrievalContext()
    )

    assert result.found_note_ids == ["mine"]


def test_a_search_that_matches_nothing_says_so_rather_than_going_quiet(session):
    # Told nothing, the model answers from memory as though it had searched.
    result = run_retrieval_round(
        session, USER, [{"type": "find_notes", "query": "nothing here"}], RetrievalContext()
    )

    assert result.found_note_ids == []
    assert "returned no notes" in result.turns[1]["content"]


def test_the_round_records_what_the_model_asked_for(session):
    # The assistant turn replays the search actions so the next round sees its own
    # query alongside the answer.
    make_note(session, "n1", "Gecko", "x")
    result = run_retrieval_round(
        session, USER, [{"type": "find_notes", "query": "Gecko"}], RetrievalContext()
    )

    assert result.turns[0]["role"] == "assistant"
    replayed = json.loads(result.turns[0]["content"])
    assert replayed["actions"][0]["query"] == "Gecko"
    assert result.turns[1]["role"] == "user"


# ─── describing a search ─────────────────────────────────────────────────────


def test_describe_find_notes_is_never_empty():
    # The list view uses this as its "Search Results" header, where an empty string
    # trips a search reset.
    assert describe_find_notes({"type": "find_notes"}, RetrievalContext()) == "notes"


def test_describe_find_notes_resolves_the_current_folder_and_the_root():
    ctx = RetrievalContext(current_folder_id="f1", folder_names={"f1": "Research"})
    assert 'folder "Research"' in describe_find_notes({"folderId": "current"}, ctx)
    assert "the root" in describe_find_notes({"folderId": None}, ctx)
    assert "(recursive)" in describe_find_notes({"folderId": "f1", "recursive": True}, ctx)


def test_format_note_meta_is_empty_when_there_are_no_dates():
    assert format_note_meta(None, None) == ""
    assert "created" in format_note_meta(datetime(2026, 9, 3), None)


# ─── searching the web ───────────────────────────────────────────────────────


def test_web_search_hits_are_numbered_with_full_urls():
    # The model is told to cite only links that appeared in the results, so the links
    # have to be in front of it verbatim.
    rendered = format_web_search_results({
        "query": "geckos",
        "provider_label": "Brave",
        "results": [
            {"title": "Toe pads", "url": "https://a.dev/1", "snippet": "sticky", "published": "2026"},
            {"title": "Tails", "url": "https://a.dev/2"},
        ],
    })
    assert "1. Toe pads (published 2026)" in rendered
    assert "https://a.dev/1" in rendered
    assert "2. Tails" in rendered
    assert "via Brave" in rendered


def test_an_empty_web_search_is_reported_as_empty():
    assert "returned no results" in format_web_search_results({"query": "x", "results": []})


def test_a_round_where_every_search_failed_tells_the_model_not_to_invent(session, monkeypatch):
    import app.routers.search as search_router

    async def boom(*args, **kwargs):
        raise RuntimeError("no API key configured")

    monkeypatch.setattr(search_router, "search_web_for_user", boom)

    result = run_retrieval_round(
        session, USER, [{"type": "web_search", "query": "geckos"}], RetrievalContext()
    )

    body = result.turns[1]["content"]
    assert "failed" in body
    assert "no API key configured" in body
    assert "do not answer from memory" in body


def test_web_searches_are_capped_per_round(session, monkeypatch):
    import app.routers.search as search_router

    seen = []

    async def fake(session_, user_id, query, count=None):
        seen.append(query)
        return {"query": query, "provider_label": "Test", "results": []}

    monkeypatch.setattr(search_router, "search_web_for_user", fake)

    run_retrieval_round(
        session,
        USER,
        [{"type": "web_search", "query": f"q{i}"} for i in range(6)],
        RetrievalContext(),
    )

    assert len(seen) == MAX_WEB_SEARCHES_PER_ROUND


def test_web_search_is_skipped_for_a_provider_that_searches_itself(session, monkeypatch):
    # Anthropic searches inside its own model call, so the action was never offered;
    # running it here would duplicate a search the model already did.
    import app.routers.search as search_router

    called = []
    monkeypatch.setattr(search_router, "search_web_for_user", lambda *a, **k: called.append(1))

    run_retrieval_round(
        session, USER, [{"type": "web_search", "query": "q"}],
        RetrievalContext(), web_search_enabled=False,
    )

    assert called == []


def test_the_continuation_changes_when_nothing_succeeded():
    assert "Continue with the original request" in web_search_continuation(True)
    assert "do not retry the same search" in web_search_continuation(False)


# ─── finishing a stalled turn ────────────────────────────────────────────────


def stalled_reply():
    """What DeepSeek returns once the search budget is spent: commentary, searches the
    provider already ran, and no plan."""
    return {
        "stop_reason": "tool_use",
        "content": [
            {"type": "text", "text": "I'll create the note now…"},
            {"type": "server_tool_use", "input": {"query": "geckos"}},
            {"type": "web_search_tool_result", "content": [
                {"title": "Toe pads", "url": "https://a.dev/1"},
                {"title": "Tails", "url": "https://a.dev/2"},
            ]},
        ],
    }


def test_a_provider_run_search_with_nothing_left_to_do_is_a_stall():
    assert is_stalled_turn(stalled_reply()) is True


def test_a_client_side_tool_use_is_not_a_stall():
    # That one has a plan in it; extract_plan_text reads it out.
    data = {"stop_reason": "tool_use", "content": [
        {"type": "server_tool_use", "input": {}},
        {"type": "tool_use", "name": "create_note", "input": {"title": "T"}},
    ]}
    assert is_stalled_turn(data) is False


@pytest.mark.parametrize("data", [None, {}, {"stop_reason": "end_turn", "content": []}])
def test_an_ordinary_reply_is_not_a_stall(data):
    assert is_stalled_turn(data) is False


def test_the_stalled_turn_replays_as_text_not_as_raw_blocks():
    # A compatible-but-not-identical gateway validates thinking signatures and
    # tool_use pairing differently, and a rejected continuation would turn a
    # recoverable stall into a hard error.
    text = stalled_turn_as_text(stalled_reply())
    assert "I'll create the note now…" in text
    assert "Search “geckos”" in text
    assert "https://a.dev/1" in text


def test_a_stall_with_no_text_at_all_still_produces_a_turn():
    # An assistant turn may not be empty.
    assert stalled_turn_as_text({"stop_reason": "tool_use", "content": []}) == "(searching)"


def test_the_continuation_withholds_the_search_tool():
    # Or the round that stalled starts again.
    body = {"messages": [{"role": "user", "content": "go"}], "tools": [{"type": "web_search"}]}
    nxt = continuation_body(body, stalled_reply())

    assert "tools" not in nxt
    assert "tools" in body, "the original body must not be mutated"


def test_the_continuation_only_appends_so_the_cached_prefix_still_hits():
    body = {
        "system": [{"type": "text", "text": "instructions"}],
        "messages": [{"role": "user", "content": "go"}],
    }
    before = json.dumps(body, sort_keys=True)

    nxt = continuation_body(body, stalled_reply())

    assert json.dumps(body, sort_keys=True) == before
    assert nxt["system"] == body["system"]
    assert nxt["messages"][0] == body["messages"][0]
    assert nxt["messages"][-1]["content"] == FINISH_TURN_REQUEST


# ─── reading the reply ───────────────────────────────────────────────────────


def test_a_plan_misfired_as_a_tool_use_block_is_recovered():
    # Claude sometimes emits a described action as a native tool call instead of the
    # JSON envelope. Without this the turn looks empty.
    data = {"stop_reason": "tool_use", "content": [
        {"type": "text", "text": "Making that note."},
        {"type": "tool_use", "name": "create_note", "input": {"title": "T", "content": "C"}},
    ]}
    recovered = json.loads(extract_plan_text(data))
    assert recovered["actions"] == [{"title": "T", "content": "C", "type": "create_note"}]


def test_a_gap_where_a_tool_call_ran_becomes_a_paragraph_break():
    # Without it the commentary from either side runs together mid-word.
    data = {"content": [
        {"type": "text", "text": "…as a new note."},
        {"type": "server_tool_use", "input": {}},
        {"type": "text", "text": "I have everything I need"},
    ]}
    assert extract_plan_text(data) == "…as a new note.\n\nI have everything I need"


def test_hitting_the_output_cap_is_said_out_loud():
    data = {"stop_reason": "max_tokens", "content": [{"type": "text", "text": "Cut off"}]}
    assert finalize_plan_text(data) == "Cut off" + TRUNCATION_NOTICE


def test_an_ordinary_reply_gets_no_notice():
    data = {"stop_reason": "end_turn", "content": [{"type": "text", "text": "Done"}]}
    assert finalize_plan_text(data) == "Done"
