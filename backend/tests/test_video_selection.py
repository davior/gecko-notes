"""Rendering a selection of a note instead of the whole of it.

The editor sends the selected blocks as BlockNote JSON. Both halves have to see
the same thing: the estimate the dialog shows and the render it starts. An
earlier version sent Markdown, which the segmenter can't read — the estimate
quietly described the whole note and the render came out empty.
"""

import json
from datetime import datetime
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlmodel import Session, SQLModel, create_engine

from app.models import Note
from app.routers import video
from app.schemas import VideoRenderRequest

USER = "user-1"


def _block(block_id, kind, text, **props):
    return {
        "id": block_id, "type": kind, "props": props,
        "content": [{"type": "text", "text": text, "styles": {}}], "children": [],
    }


# Three sections; the selection is the middle one.
NOTE_BLOCKS = [
    block
    for n in range(3)
    for block in (
        _block(f"h{n}", "heading", f"Section {n}", level=2),
        _block(f"p{n}a", "paragraph", f"The first paragraph of section {n}."),
        _block(f"p{n}b", "paragraph", f"The second paragraph of section {n}."),
    )
]
SELECTION = NOTE_BLOCKS[3:6]  # the middle section


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        now = datetime.utcnow()
        for note_id, blocks in (("whole", NOTE_BLOCKS), ("only-selection", SELECTION)):
            s.add(Note(
                id=note_id, title="A note", content=json.dumps(blocks),
                category_id="cat-1", user_id=USER, created_at=now, modified_at=now,
            ))
        s.commit()
        yield s


def _estimate(session, note_id="whole", **fields):
    payload = VideoRenderRequest(note_id=note_id, options={"title_card": False}, **fields)
    request = SimpleNamespace(state=SimpleNamespace(user_id=USER))
    return video.estimate_render(payload, request, session).data


def test_a_selection_estimates_as_if_the_note_held_only_those_blocks(session):
    selected = _estimate(session, selected_content=json.dumps(SELECTION))
    assert selected == _estimate(session, note_id="only-selection")


def test_a_selection_is_smaller_than_the_whole_note(session):
    whole = _estimate(session)
    selected = _estimate(session, selected_content=json.dumps(SELECTION))
    assert 0 < selected.narration_chars < whole.narration_chars
    assert selected.estimated_seconds < whole.estimated_seconds


@pytest.mark.parametrize("value", [None, "", "   ", "[]"])
def test_an_empty_selection_means_the_whole_note(value):
    assert VideoRenderRequest(note_id="n", selected_content=value).selected_content is None


@pytest.mark.parametrize("value", ["# A heading\n\nSome **markdown**", '{"type": "paragraph"}'])
def test_a_selection_that_is_not_a_block_list_is_refused(value):
    with pytest.raises(ValidationError):
        VideoRenderRequest(note_id="n", selected_content=value)
