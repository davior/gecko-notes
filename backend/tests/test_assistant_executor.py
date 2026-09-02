"""The plan executor, ported from the browser.

`planExecutor.ts` shipped with no tests at all, so these are the first this logic has
had. They lean on the parts that encode something learned from real model output
rather than the parts that are obvious:

  * a section heading has three forms, because models emit all three
  * an unknown note id is refused, except in the one case where it cannot be ambiguous
  * a section rewrite must not delete the embeds Markdown cannot express
  * one snapshot per note per run — the undo point, and the thing that makes
    cancelling survivable
  * one bad action never abandons the rest of the plan
"""

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.assistant.executor import (
    ActionResult, Cancelled, ExecContext, PlanExecutor,
    build_result_summary, collect_embeds, find_section_index, normalize_heading,
    section_heading,
)
from app.models import Annotation, Category, Folder, Note, NoteVersion, Recipe

USER = "user-1"
OTHER = "user-2"
CATEGORY = "cat-1"


# ─── fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Category(id=CATEGORY, label="Notes", emoji="📝", color="#000"))
        s.commit()
        yield s


def para(text: str, block_id: str = "b1") -> dict:
    return {
        "id": block_id, "type": "paragraph", "props": {},
        "content": [{"type": "text", "text": text, "styles": {}}], "children": [],
    }


def heading(text: str, level: int = 2, block_id: str = "h1") -> dict:
    return {
        "id": block_id, "type": "heading", "props": {"level": level},
        "content": [{"type": "text", "text": text, "styles": {}}], "children": [],
    }


def make_note(session, *, note_id="note-1", title="A note", blocks=None, user_id=USER, **fields):
    now = datetime.now(timezone.utc)
    note = Note(
        id=note_id, title=title,
        content=json.dumps(blocks if blocks is not None else [para("Body.")]),
        category_id=CATEGORY, tags="[]",
        created_at=now, modified_at=now, user_id=user_id, **fields,
    )
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


def executor(session, **ctx_fields):
    defaults = dict(
        user_id=USER, current_note_id="note-1", default_category_id=CATEGORY,
        valid_note_ids={"note-1"}, valid_category_ids={CATEGORY},
    )
    defaults.update(ctx_fields)
    return PlanExecutor(session, ExecContext(**defaults))


def blocks_of(session, note_id) -> list:
    session.expire_all()
    return json.loads(session.get(Note, note_id).content)


def texts_of(session, note_id) -> list:
    return [
        "".join(c.get("text", "") for c in (b.get("content") or []))
        for b in blocks_of(session, note_id)
    ]


# ─── heading matching ────────────────────────────────────────────────────────


def test_normalize_heading_strips_the_decorations_models_add():
    for decorated in ["## Chapter 1", "**Chapter 1**", "Chapter 1.", "chapter  1", "## Chapter 1 ##"]:
        assert normalize_heading(decorated) == "chapter 1"


def test_curly_quotes_fold_to_straight_ones():
    # The planner is told to prefer typographic quotes, so both forms must match.
    assert normalize_heading("The “Big” Idea") == normalize_heading('The "Big" Idea')


def test_a_real_heading_block_reports_its_level():
    assert section_heading(heading("Intro", level=3)) == (3, "Intro")


def test_a_literal_markdown_line_in_a_paragraph_counts_as_a_heading():
    # Markdown pasted into a paragraph that was never parsed into a heading block.
    assert section_heading(para("### Notes")) == (3, "### Notes")


def test_a_short_all_bold_paragraph_is_a_pseudo_heading_below_every_real_one():
    bold = {
        "id": "b", "type": "paragraph", "props": {},
        "content": [{"type": "text", "text": "Findings", "styles": {"bold": True}}],
        "children": [],
    }
    assert section_heading(bold) == (7, "Findings")


def test_a_long_bold_paragraph_is_prose_not_a_heading():
    # Otherwise a bold sentence inside a section would cut that section short.
    long_bold = {
        "id": "b", "type": "paragraph", "props": {},
        "content": [{"type": "text", "text": "x" * 200, "styles": {"bold": True}}],
        "children": [],
    }
    assert section_heading(long_bold) is None


def test_a_partly_bold_paragraph_is_not_a_pseudo_heading():
    mixed = {
        "id": "b", "type": "paragraph", "props": {},
        "content": [
            {"type": "text", "text": "Bold", "styles": {"bold": True}},
            {"type": "text", "text": " and plain", "styles": {}},
        ],
        "children": [],
    }
    assert section_heading(mixed) is None


def test_find_section_prefers_an_exact_match_over_a_substring():
    blocks = [heading("Results and discussion", block_id="h1"), heading("Results", block_id="h2")]
    assert find_section_index(blocks, "Results") == 1


def test_find_section_falls_back_to_a_substring():
    assert find_section_index([heading("Detailed Results")], "Results") == 0


def test_find_section_matches_across_the_decorated_forms():
    assert find_section_index([heading("Chapter 1")], "## Chapter 1") == 0
    assert find_section_index([para("### Chapter 1")], "Chapter 1") == 0


# ─── resolving targets ───────────────────────────────────────────────────────


def test_a_note_in_context_resolves(session):
    make_note(session)
    result = executor(session).run({"actions": [
        {"type": "rename_note", "noteId": "note-1", "title": "Renamed"},
    ]})
    assert result[0].ok
    assert session.get(Note, "note-1").title == "Renamed"


def test_the_current_sentinel_resolves_to_the_open_note(session):
    make_note(session)
    result = executor(session).run({"actions": [
        {"type": "rename_note", "noteId": "current", "title": "Renamed"},
    ]})
    assert result[0].ok
    assert session.get(Note, "note-1").title == "Renamed"


def test_an_unknown_id_falls_back_when_exactly_one_note_is_in_context(session):
    # Models copy stale ids out of earlier turns; with one note in context that can
    # only sensibly mean this note.
    make_note(session)
    result = executor(session).run({"actions": [
        {"type": "rename_note", "noteId": "some-stale-id", "title": "Renamed"},
    ]})
    assert result[0].ok
    assert session.get(Note, "note-1").title == "Renamed"


def test_an_unknown_id_is_refused_when_the_context_is_ambiguous(session):
    make_note(session, note_id="note-1")
    make_note(session, note_id="note-2", title="Other")
    ex = executor(session, valid_note_ids={"note-1", "note-2"})
    result = ex.run({"actions": [{"type": "rename_note", "noteId": "stale", "title": "X"}]})
    assert result[0].ok is False
    assert "not in context" in result[0].message
    assert session.get(Note, "note-1").title == "A note"


def test_another_users_note_is_never_written(session):
    make_note(session, note_id="theirs", title="Theirs", user_id=OTHER)
    ex = executor(session, valid_note_ids={"theirs"}, current_note_id=None)
    result = ex.run({"actions": [{"type": "rename_note", "noteId": "theirs", "title": "Hacked"}]})
    assert result[0].ok is False
    assert session.get(Note, "theirs").title == "Theirs"


# ─── writing notes ───────────────────────────────────────────────────────────


def test_create_note_converts_markdown_to_blocks(session):
    result = executor(session).run({"actions": [
        {"type": "create_note", "title": "Essay", "content": "# Title\n\nSome **prose**."},
    ]})
    assert result[0].ok
    note = session.exec(select(Note).where(Note.title == "Essay")).one()
    blocks = json.loads(note.content)
    assert [b["type"] for b in blocks] == ["heading", "paragraph"]


def test_a_forward_ref_lets_a_later_step_target_what_an_earlier_one_created(session):
    ex = executor(session, current_note_id=None, valid_note_ids=set())
    result = ex.run({"actions": [
        {"type": "create_note", "title": "New", "content": "Body", "ref": "n1"},
        {"type": "rename_note", "noteId": "n1", "title": "Renamed by ref"},
    ]})
    assert all(r.ok for r in result), [r.message for r in result]
    assert session.exec(select(Note).where(Note.title == "Renamed by ref")).one()


def test_edit_note_replaces_and_amend_appends(session):
    make_note(session, blocks=[para("Original.")])
    executor(session).run({"actions": [
        {"type": "edit_note", "noteId": "note-1", "mode": "amend", "content": "Added."},
    ]})
    assert texts_of(session, "note-1") == ["Original.", "Added."]

    executor(session).run({"actions": [
        {"type": "edit_note", "noteId": "note-1", "mode": "replace", "content": "Fresh."},
    ]})
    assert texts_of(session, "note-1") == ["Fresh."]


def test_append_note_adds_to_the_end(session):
    make_note(session, blocks=[para("First.")])
    executor(session).run({"actions": [
        {"type": "append_note", "noteId": "note-1", "content": "Second."},
    ]})
    assert texts_of(session, "note-1") == ["First.", "Second."]


# ─── sections ────────────────────────────────────────────────────────────────


def test_edit_section_replaces_only_that_section(session):
    make_note(session, blocks=[
        heading("One", block_id="h1"), para("First body.", "b1"),
        heading("Two", block_id="h2"), para("Second body.", "b2"),
    ])
    executor(session).run({"actions": [
        {"type": "edit_section", "noteId": "note-1", "section": "One", "content": "Rewritten."},
    ]})
    assert texts_of(session, "note-1") == ["Rewritten.", "Two", "Second body."]


def test_a_section_runs_until_a_heading_of_the_same_or_higher_level(session):
    make_note(session, blocks=[
        heading("Top", level=1, block_id="h1"),
        heading("Sub", level=2, block_id="h2"), para("Sub body.", "b1"),
        heading("Next top", level=1, block_id="h3"), para("Kept.", "b2"),
    ])
    executor(session).run({"actions": [
        {"type": "edit_section", "noteId": "note-1", "section": "Top", "content": "New."},
    ]})
    # Everything under Top, including its subsection, is replaced; Next top survives.
    assert texts_of(session, "note-1") == ["New.", "Next top", "Kept."]


def test_a_missing_section_is_appended_rather_than_failing(session):
    make_note(session, blocks=[para("Body.")])
    result = executor(session).run({"actions": [
        {"type": "edit_section", "noteId": "note-1", "section": "Nowhere", "content": "New bit."},
    ]})
    assert result[0].ok
    assert "added as a new section" in result[0].message
    assert texts_of(session, "note-1") == ["Body.", "New bit."]


def test_a_section_rewrite_keeps_embeds_markdown_cannot_express(session):
    embed = {"id": "e1", "type": "childNote", "props": {"childNoteId": "c1", "title": "Child"}, "children": []}
    make_note(session, blocks=[heading("One", block_id="h1"), para("Old.", "b1"), embed])
    result = executor(session).run({"actions": [
        {"type": "edit_section", "noteId": "note-1", "section": "One", "content": "New."},
    ]})
    kinds = [b["type"] for b in blocks_of(session, "note-1")]
    assert "childNote" in kinds
    assert "Kept 1 embedded reference" in result[0].message


def test_collect_embeds_finds_nested_ones():
    nested = {"type": "paragraph", "children": [
        {"type": "diagram", "props": {"diagramId": "d1"}, "children": []},
    ]}
    assert [b["type"] for b in collect_embeds([nested])] == ["diagram"]


# ─── versions ────────────────────────────────────────────────────────────────


def test_one_snapshot_per_note_however_many_steps_touch_it(session):
    make_note(session, blocks=[heading("One", block_id="h1"), para("Body.", "b1")])
    executor(session).run({"actions": [
        {"type": "edit_section", "noteId": "note-1", "section": "One", "content": "A."},
        {"type": "append_note", "noteId": "note-1", "content": "B."},
        {"type": "edit_note", "noteId": "note-1", "mode": "amend", "content": "C."},
    ]})
    versions = session.exec(select(NoteVersion).where(NoteVersion.note_id == "note-1")).all()
    assert len(versions) == 1


def test_the_snapshot_holds_the_pre_run_content(session):
    make_note(session, blocks=[para("Before the run.")])
    executor(session).run({"actions": [
        {"type": "edit_note", "noteId": "note-1", "mode": "replace", "content": "After."},
    ]})
    version = session.exec(select(NoteVersion).where(NoteVersion.note_id == "note-1")).one()
    assert "Before the run." in version.content


# ─── other actions ───────────────────────────────────────────────────────────


def test_set_tags_replaces_or_merges(session):
    make_note(session)
    executor(session).run({"actions": [
        {"type": "set_tags", "noteId": "note-1", "tags": ["a", "b"], "mode": "replace"},
    ]})
    assert json.loads(session.get(Note, "note-1").tags) == ["a", "b"]

    executor(session).run({"actions": [
        {"type": "set_tags", "noteId": "note-1", "tags": ["b", "c"], "mode": "add"},
    ]})
    session.expire_all()
    assert json.loads(session.get(Note, "note-1").tags) == ["a", "b", "c"]


def test_set_category_refuses_one_not_in_context(session):
    make_note(session)
    result = executor(session).run({"actions": [
        {"type": "set_category", "noteId": "note-1", "categoryId": "not-offered"},
    ]})
    assert result[0].ok is False
    assert session.get(Note, "note-1").category_id == CATEGORY


def test_create_child_note_links_it_from_the_parent(session):
    make_note(session, blocks=[para("Parent body.")])
    result = executor(session).run({"actions": [
        {"type": "create_child_note", "parentId": "note-1", "title": "Child", "content": "Hi"},
    ]})
    assert result[0].ok
    child = session.exec(select(Note).where(Note.title == "Child")).one()
    assert child.parent_note_id == "note-1"
    # The children endpoint only sets the link; the parent needs the block too or the
    # child is invisible in the UI.
    kinds = [b["type"] for b in blocks_of(session, "note-1")]
    assert "childNote" in kinds


def test_add_reference_lands_under_a_named_section(session):
    make_note(session, blocks=[heading("One", block_id="h1"), para("Body.", "b1")])
    ex = executor(session, valid_note_ids={"note-1", "note-2"})
    make_note(session, note_id="note-2", title="Target")
    result = ex.run({"actions": [{
        "type": "add_reference", "noteId": "note-1",
        "referenceNoteId": "note-2", "referenceTitle": "Target",
        "insertAfterSection": "One",
    }]})
    assert result[0].ok
    kinds = [b["type"] for b in blocks_of(session, "note-1")]
    assert kinds[1] == "noteReference"


def test_an_annotation_anchors_to_the_block_holding_the_quoted_snippet(session):
    make_note(session, blocks=[para("Alpha line.", "b1"), para("Beta line.", "b2")])
    result = executor(session).run({"actions": [
        {"type": "add_annotation", "noteId": "note-1", "anchorText": "Beta", "text": "A note about beta"},
    ]})
    assert result[0].ok
    row = session.exec(select(Annotation)).one()
    assert row.block_id == "b2"


def test_an_annotation_whose_anchor_is_absent_is_reported_not_guessed(session):
    make_note(session, blocks=[para("Alpha line.", "b1")])
    result = executor(session).run({"actions": [
        {"type": "add_annotation", "noteId": "note-1", "anchorText": "nothing like this", "text": "x"},
    ]})
    assert result[0].ok is False
    assert session.exec(select(Annotation)).all() == []


def test_create_folder_and_target_it_by_ref(session):
    ex = executor(session)
    make_note(session)
    result = ex.run({"actions": [
        {"type": "create_folder", "name": "Archive", "ref": "f1"},
        {"type": "move_note", "noteId": "note-1", "folderId": "f1"},
    ]})
    assert all(r.ok for r in result), [r.message for r in result]
    folder = session.exec(select(Folder).where(Folder.name == "Archive")).one()
    assert session.get(Note, "note-1").folder_id == folder.id


def test_recipes_are_only_touched_when_offered(session):
    now = datetime.now(timezone.utc)
    session.add(Recipe(id="r1", user_id=USER, name="Old", prompt="p", tags="[]",
                       created_at=now, updated_at=now))
    session.commit()

    refused = executor(session).run({"actions": [
        {"type": "update_recipe", "recipeId": "r1", "name": "New"},
    ]})
    assert refused[0].ok is False

    allowed = executor(session, valid_recipe_ids={"r1"}).run({"actions": [
        {"type": "update_recipe", "recipeId": "r1", "name": "New"},
    ]})
    assert allowed[0].ok
    assert session.get(Recipe, "r1").name == "New"


# ─── failure and cancellation ────────────────────────────────────────────────


def test_one_failing_action_does_not_abandon_the_rest(session):
    make_note(session, blocks=[para("Body.")])
    results = executor(session).run({"actions": [
        {"type": "set_category", "noteId": "note-1", "categoryId": "nope"},   # fails
        {"type": "append_note", "noteId": "note-1", "content": "Still ran."},  # must run
    ]})
    assert [r.ok for r in results] == [False, True]
    assert texts_of(session, "note-1")[-1] == "Still ran."


def test_an_unknown_action_type_is_reported_rather_than_raising(session):
    results = executor(session).run({"actions": [{"type": "teleport_note"}]})
    assert results[0].ok is False
    assert "Unknown action" in results[0].message


def test_cancelling_stops_before_the_next_action_and_keeps_what_ran(session):
    make_note(session, blocks=[para("Body.")])
    calls = {"n": 0}

    def check():
        calls["n"] += 1
        if calls["n"] > 2:      # let the first action through, stop at the second
            raise Cancelled()

    ex = PlanExecutor(
        session,
        ExecContext(user_id=USER, current_note_id="note-1", default_category_id=CATEGORY,
                    valid_note_ids={"note-1"}, valid_category_ids={CATEGORY}),
        check_cancelled=check,
    )
    with pytest.raises(Cancelled):
        ex.run({"actions": [
            {"type": "append_note", "noteId": "note-1", "content": "Applied."},
            {"type": "append_note", "noteId": "note-1", "content": "Never."},
        ]})

    texts = texts_of(session, "note-1")
    assert "Applied." in texts
    assert "Never." not in texts


# ─── the summary written back into the chat ──────────────────────────────────


def test_the_summary_is_a_table_of_rows_with_note_pills():
    summary = build_result_summary([
        ActionResult(ok=True, message="Created note “Essay”.", note_id="n1", note_title="Essay"),
        ActionResult(ok=False, message="Category not available."),
    ])
    assert "| ✅ | Created note “Essay”. [Essay](/notes/n1) |" in summary
    assert "| ❌ | Category not available. |" in summary
    assert "_(1 action could not be completed.)_" in summary


def test_respond_text_sits_above_the_table():
    summary = build_result_summary([
        ActionResult(ok=True, message="Here is what I found.", kind="respond"),
        ActionResult(ok=True, message="Renamed note."),
    ])
    assert summary.index("Here is what I found.") < summary.index("| ✅ |")


def test_a_clean_run_says_nothing_about_failures():
    summary = build_result_summary([ActionResult(ok=True, message="Renamed note.")])
    assert "could not be completed" not in summary
