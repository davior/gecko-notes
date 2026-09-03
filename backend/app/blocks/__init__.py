"""BlockNote document helpers.

The note body is BlockNote JSON, and until now the only code that could *build* it
lived in the browser (the editor's own Markdown parser). Reading it server-side was
already spread across `routers/notes.py` and `video/segmenter.py`; this package is
the writing half, so a background worker can put generated prose into a note without
a browser being open.

`block_markdown` is the other direction, added when planning moved to the server: a
worker that discovers notes mid-turn has to put their bodies in front of the model,
with their headings intact so it can still target sections in them.
"""

from app.blocks.block_markdown import blocks_to_markdown, note_to_markdown
from app.blocks.markdown_blocks import markdown_to_blocks

__all__ = ["markdown_to_blocks", "blocks_to_markdown", "note_to_markdown"]
