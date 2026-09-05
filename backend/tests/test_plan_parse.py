"""Turning a model reply into a plan.

The browser has always done this; the server does it too now, because a worker with no
tab open has to know whether the reply is an answer, a search request, or a set of
edits it may start applying. Two implementations of one contract drift, so the real
guard is `tools/plan_parse_diff/`, which runs a corpus through both and diffs them.
That needs Node, so it is not part of this run.

What is here is the contract itself, written down: the shapes models actually emit,
and — more importantly — the promise that a reply is never lost. Every failure path
below still returns something sayable, because the alternative is a user watching
their question vanish.
"""

import json

import pytest

from app.assistant.plan_parse import (
    MAX_PLAN_ACTIONS,
    is_respond_only,
    normalize_action_tags,
    parse_plan,
    respond_text,
    split_retrieval,
    validate_action,
)


def envelope(*actions) -> str:
    return json.dumps({"actions": list(actions)})


def types(plan) -> list:
    return [a["type"] for a in plan["actions"]]


def texts(plan) -> list:
    return [a["text"] for a in plan["actions"] if a["type"] == "respond"]


# ─── the shapes models emit ──────────────────────────────────────────────────


def test_the_documented_envelope_parses():
    plan = parse_plan(envelope({"type": "respond", "text": "Hello."}))
    assert plan == {"actions": [{"type": "respond", "text": "Hello."}]}


def test_a_bare_action_is_wrapped_rather_than_shown_as_json():
    # Models drop the envelope often enough that rendering the raw object would be a
    # visible bug rather than an edge case.
    plan = parse_plan('{"type":"respond","text":"Just answering."}')
    assert plan["actions"] == [{"type": "respond", "text": "Just answering."}]


def test_a_json_fence_is_unwrapped():
    raw = 'Here you go:\n```json\n' + envelope({"type": "respond", "text": "Fenced."}) + '\n```'
    assert texts(parse_plan(raw)) == ["Here you go:", "Fenced."]


def test_prose_around_the_envelope_leads_the_plan():
    # The prose is frequently the real answer, with only a meta-summary in respond —
    # so it goes first, where it reads above the mutation list and survives a cancel.
    raw = "Short answer: yes.\n" + envelope(
        {"type": "append_note", "noteId": "n1", "content": "x"}
    ) + "\nHope that helps."
    plan = parse_plan(raw)
    assert types(plan) == ["respond", "append_note"]
    assert plan["actions"][0]["text"] == "Short answer: yes.\n\nHope that helps."


def test_a_stray_brace_in_prose_does_not_hijack_the_parse():
    # A first-brace-to-last-brace span would swallow the example and find no plan.
    raw = "Use the set {a, b} as your key.\n" + envelope({"type": "respond", "text": "Done."})
    assert texts(parse_plan(raw)) == ["Use the set {a, b} as your key.", "Done."]


def test_braces_inside_a_string_value_do_not_confuse_brace_matching():
    plan = parse_plan(envelope({"type": "respond", "text": "the set {a, b} and }{ too"}))
    assert texts(plan) == ["the set {a, b} and }{ too"]


# ─── the quote repair ────────────────────────────────────────────────────────


def test_an_unescaped_quote_inside_a_body_is_repaired_rather_than_lost():
    # Straight ASCII quotes in a note body end the JSON string early. Before the
    # repair pass the whole plan was discarded and the raw reply shown as text.
    raw = '{"actions":[{"type":"create_note","title":"T","content":"He said "hello" loudly."}]}'
    plan = parse_plan(raw)
    assert types(plan) == ["create_note"]
    assert plan["actions"][0]["content"] == 'He said "hello" loudly.'


def test_a_quoted_phrase_followed_by_a_comma_stays_inside_the_string():
    # The ambiguous case: in an object a real value-close is followed by the next
    # KEY, so a comma that isn't is interior prose.
    raw = '{"actions":[{"type":"create_note","title":"T","content":"She wrote "one", then left."}]}'
    assert parse_plan(raw)["actions"][0]["content"] == 'She wrote "one", then left.'


def test_a_plan_that_already_parses_is_never_touched_by_the_repair():
    raw = envelope({"type": "respond", "text": 'He said "hi".'})
    assert texts(parse_plan(raw)) == ['He said "hi".']


# ─── the wrappers models invent ──────────────────────────────────────────────


def test_an_actions_tag_around_an_array_becomes_an_envelope():
    raw = '<actions>[{"type":"respond","text":"Tagged."}]</actions>'
    assert texts(parse_plan(raw)) == ["Tagged."]


def test_an_empty_actions_tag_leaves_the_prose_as_the_reply():
    # DeepSeek appends an empty container to ordinary conversational replies; without
    # this the tags render verbatim in the chat.
    assert texts(parse_plan("I'll look into that.\n<actions>\n</actions>")) == [
        "I'll look into that."
    ]


def test_an_orphan_actions_opener_is_container_noise():
    assert texts(parse_plan("Working on it.\n<actions>")) == ["Working on it."]


def test_text_tool_call_markup_is_dropped_but_its_prose_is_kept():
    # A model told it has a tool its provider never wired up "calls" it by emitting
    # this as ordinary output. It is never valid plan JSON.
    raw = (
        'Let me search.\n<function_calls>\n<invoke name="web_search">'
        '\n<parameter name="query">x</parameter>\n</invoke>\n</function_calls>'
    )
    assert texts(parse_plan(raw)) == ["Let me search."]


def test_normalize_action_tags_is_a_no_op_on_a_well_formed_reply():
    raw = envelope({"type": "respond", "text": "clean"})
    assert normalize_action_tags(raw) == raw


# ─── never losing the reply ──────────────────────────────────────────────────


@pytest.mark.parametrize("raw", ["", "   \n\t  ", None])
def test_an_empty_reply_still_says_something(raw):
    assert texts(parse_plan(raw)) == ["(no response)"]


def test_prose_with_no_json_is_the_reply():
    raw = "I don't think that's something I can help with."
    assert texts(parse_plan(raw)) == [raw]


def test_unparseable_json_degrades_to_showing_the_reply():
    raw = '{"actions": [ {"type": '
    assert texts(parse_plan(raw)) == [raw.strip()]


def test_an_envelope_with_no_usable_action_shows_its_prose_not_its_json():
    raw = "Here you go.\n" + envelope({"type": "find_notes"}) + "\nHope that helps."
    plan = parse_plan(raw)
    assert types(plan) == ["respond"]
    assert "find_notes" not in plan["actions"][0]["text"]
    assert plan["actions"][0]["text"] == "Here you go.\n\nHope that helps."


def test_an_envelope_with_no_usable_action_and_no_prose_apologises():
    plan = parse_plan(envelope({"type": "find_notes"}, {"type": "nonsense"}))
    assert types(plan) == ["respond"]
    assert "rephrase" in plan["actions"][0]["text"]


def test_junk_entries_in_the_actions_array_are_dropped_not_fatal():
    raw = '{"actions":["nope",null,42,{"type":"respond","text":"survivor"}]}'
    assert texts(parse_plan(raw)) == ["survivor"]


def test_nan_is_rejected_the_way_javascript_rejects_it():
    # Python's json accepts NaN by default and JavaScript's does not; a slice that
    # only parses because of that leniency is not a plan.
    raw = '{"actions":[{"type":"web_search","query":"x","maxResults":NaN}]}'
    assert types(parse_plan(raw)) == ["respond"]


# ─── validation ──────────────────────────────────────────────────────────────


def test_the_action_cap_truncates_and_says_so():
    raw = envelope(*[{"type": "respond", "text": f"m{i}"} for i in range(MAX_PLAN_ACTIONS + 5)])
    plan = parse_plan(raw)
    assert len(plan["actions"]) == MAX_PLAN_ACTIONS + 1
    assert "truncated" in plan["actions"][-1]["text"]


def test_exactly_the_cap_is_not_truncated():
    raw = envelope(*[{"type": "respond", "text": f"m{i}"} for i in range(MAX_PLAN_ACTIONS)])
    plan = parse_plan(raw)
    assert len(plan["actions"]) == MAX_PLAN_ACTIONS
    assert "truncated" not in plan["actions"][-1]["text"]


def test_find_notes_tells_an_absent_folder_from_an_explicit_null():
    # Absent means "no folder scope"; null means the root. Collapsing them silently
    # rescopes the search.
    assert "folderId" not in validate_action({"type": "find_notes", "query": "q"})
    assert validate_action({"type": "find_notes", "folderId": None})["folderId"] is None
    assert validate_action({"type": "find_notes", "folderId": "f1"})["folderId"] == "f1"


def test_find_notes_needs_a_query_or_a_folder():
    assert validate_action({"type": "find_notes"}) is None
    assert validate_action({"type": "find_notes", "query": ""}) is None


def test_max_results_is_coerced_and_capped():
    def asked(value):
        return validate_action({"type": "web_search", "query": "q", "maxResults": value})

    assert asked("5")["maxResults"] == 5           # a model that quoted the number
    assert asked(500)["maxResults"] == 10          # capped
    assert "maxResults" not in asked(0)            # falsy, so omitted
    assert "maxResults" not in asked(-3)
    assert "maxResults" not in asked("abc")
    assert asked(2.5)["maxResults"] == 3           # Math.round, not banker's rounding


def test_tags_are_stringified_the_way_javascript_would():
    # str(True) is "True" and str(2.0) is "2.0"; JavaScript disagrees on both, and a
    # tag that differs between the two sides is a different tag.
    action = validate_action(
        {"type": "set_tags", "noteId": "n1", "tags": ["a", 1, 2.0, True, None], "mode": "add"}
    )
    assert action["tags"] == ["a", "1", "2", "true", "null"]


def test_edit_note_amends_unless_replace_is_explicit():
    def mode(value):
        return validate_action({"type": "edit_note", "noteId": "n1", **value})["mode"]

    assert mode({"mode": "replace"}) == "replace"
    assert mode({"mode": "REPLACE"}) == "amend"    # the safer reading of a near-miss
    assert mode({}) == "amend"


def test_an_empty_title_is_allowed_but_a_missing_one_is_not():
    assert validate_action({"type": "create_note", "title": ""})["title"] == ""
    assert validate_action({"type": "create_note", "content": "c"}) is None


def test_blank_sources_and_prompts_are_not_usable_actions():
    assert validate_action({"type": "create_diagram", "noteId": "n1", "source": "  "}) is None
    assert validate_action({"type": "generate_image", "noteId": "n1", "prompt": " "}) is None


def test_empty_trailers_are_dropped_rather_than_carried_as_blanks():
    action = validate_action(
        {"type": "create_note", "title": "t", "spec": "", "ref": "", "description": ""}
    )
    assert action == {"type": "create_note", "title": "t", "content": ""}


def test_an_unknown_action_type_is_dropped():
    assert validate_action({"type": "teleport_note", "noteId": "n1"}) is None


# ─── reading a parsed plan ───────────────────────────────────────────────────


def test_respond_only_is_what_lets_a_turn_finish_without_executing_anything():
    assert is_respond_only(parse_plan(envelope({"type": "respond", "text": "hi"})))
    assert not is_respond_only(
        parse_plan(envelope(
            {"type": "respond", "text": "hi"},
            {"type": "rename_note", "noteId": "n1", "title": "T"},
        ))
    )
    # An empty plan is not "respond only" — there is nothing to say either.
    assert not is_respond_only({"actions": []})


def test_respond_text_joins_the_conversational_half_of_a_plan():
    plan = parse_plan(envelope(
        {"type": "respond", "text": "First."},
        {"type": "rename_note", "noteId": "n1", "title": "T"},
        {"type": "respond", "text": "Second."},
    ))
    assert respond_text(plan) == "First.\n\nSecond."


def test_split_retrieval_separates_what_is_resolved_from_what_is_executed():
    plan = parse_plan(envelope(
        {"type": "find_notes", "query": "q"},
        {"type": "web_search", "query": "w"},
        {"type": "rename_note", "noteId": "n1", "title": "T"},
    ))
    retrieval, rest = split_retrieval(plan)
    assert [a["type"] for a in retrieval] == ["find_notes", "web_search"]
    assert [a["type"] for a in rest] == ["rename_note"]


# ─── the corpus, as an invariant ─────────────────────────────────────────────


def _corpus():
    import os

    path = os.path.join(
        os.path.dirname(__file__), "..", "tools", "plan_parse_diff", "corpus.json"
    )
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


@pytest.mark.parametrize("sample", _corpus(), ids=lambda s: s["name"])
def test_every_corpus_sample_yields_something_sayable(sample):
    """The differ compares the two parsers; this asserts the one promise that holds
    whatever they agree on — a reply always comes back with at least one action, and
    parsing never raises."""
    plan = parse_plan(sample["raw"])
    assert plan["actions"], sample["name"]
    assert all(isinstance(a.get("type"), str) for a in plan["actions"])
