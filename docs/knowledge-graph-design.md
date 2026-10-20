# Knowledge Graph for Notes — Design Proposal

Status: **proposal / not yet implemented**

Goal: let notes link to each other as a navigable graph, in the style of
[TheBrain](https://www.thebrain.com/). You should be able to start from any note, see
what it connects to, and move through related notes and entities. Links must stay correct
on their own when notes are renamed, moved, edited, archived or deleted.

> Note on sources: the TheBrain 14 user guide PDF could not be fetched from this
> environment (its host is blocked by the network policy). The TheBrain concepts below
> come from general knowledge of the product, so check them against the guide.

---

## 1. TheBrain's model, in brief

| TheBrain concept | Meaning |
|---|---|
| **Thought** | A node. It has a name, an optional note body, attachments and tags/types. |
| **Parent / Child link** | A hierarchical link. A thought may have **several parents**, so the structure is a graph, not a tree. |
| **Jump link** | A lateral, non-hierarchical association ("related to"). |
| **Siblings** | Derived rather than stored: thoughts that share a parent. |
| **Plex** | The main view. It is centred on the *active thought*: parents above, children below, jumps to the side and siblings beside it. Clicking any node makes it the new centre, and that click is how you navigate. |
| **Link labels / types / direction** | A link can carry a label ("authored by", "depends on") and a type with its own colour. |
| **Thought types & tags** | A thought can have a type (Person, Project, Concept) and tags, used for grouping and filtering. |
| **`[[ ]]` links in notes** | Typing a thought's name in a note body links to it and creates a graph link. |
| **Mentions / backlinks** | Other places that link to or mention this thought. Unlinked mentions can be turned into links with one click. |
| **Pins / Past thoughts** | Bookmarks, plus a trail of recently visited thoughts. |
| **Outline / Mind-map views** | Other layouts of the same graph. |

The key point: **TheBrain's layout is deterministic and centred on one node, not a
force-directed hairball.** That is what makes it easy to navigate. Obsidian-style global
graphs look impressive, but they are much less useful for moving around.

---

## 2. What gecko-notes already has

Much of the groundwork already exists:

| Existing piece | Where | Graph meaning |
|---|---|---|
| `Note.parent_note_id` | `backend/app/models.py` | Parent → child edge, but only **one** parent per note |
| `childNote` block | `frontend/src/blocks/childNoteBlock.tsx` | Parent → child edge, embedded |
| `noteReference` block | `frontend/src/blocks/noteReferenceBlock.tsx` | Jump link, as a block-level chip |
| Diagram `click … href "/notes/<id>"` | `frontend/src/utils/diagram.ts` | Jump link from a diagram node |
| `extract_linked_note_ids()` | `backend/app/routers/notes.py:121` | Already walks content and collects all three link kinds |
| Referrer state ("back to …") | `frontend/src/blocks/noteReferrerState.ts` | A one-step "Past thoughts" trail |
| Tags, categories, folders | `Note.tags`, `Category`, `Folder` | Can act as thought *types* and as filters |
| Version history | `NoteVersion` | A safety net for bulk auto-linking |
| AI assistant `find_notes` | `backend/app/assistant/retrieve.py` | Can suggest links |

**What's missing:**

1. **There is no persistent link index.** Links are only extracted on the fly (today just
   for the shared view), so nothing answers "what links *to* this note?" cheaply.
2. **There are no backlinks.**
3. **There are no inline links.** You can't link a word or phrase inside a paragraph to a
   note. Links are whole blocks only.
4. **A note can have only one parent.**
5. **There is no graph or Plex view.**

---

## 3. Recommended architecture

### 3.1 Core principle: content is the source of truth, and the index is a cache

Links that come from content (inline links, reference blocks, child blocks, diagram links)
live **in the note's BlockNote JSON**, as they do today. A separate `notelink` table holds
an **index** of them that is rebuilt from content on every save. This approach:

- maintains links automatically, because saving a note re-derives its outgoing edges;
- lets the index be rebuilt from scratch at any time, which is also how existing notes
  get converted (see §5);
- leaves exports, sharing and versions unchanged, because the links stay in the content.

Only links created *outside* any note body are stored in the index alone: links drawn
directly in the graph view, and accepted AI suggestions.

### 3.2 Data model

```python
class NoteLink(SQLModel, table=True):
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    source_note_id: str = Field(foreign_key="note.id", index=True)
    target_note_id: str = Field(foreign_key="note.id", index=True)
    kind: str = Field(index=True)      # "child" | "jump"
    origin: str = Field(index=True)    # "content" | "manual" | "suggested"
    via: str = Field(default="")       # "inline" | "reference" | "childNote" | "diagram" | ""
    label: str = Field(default="")     # optional link label ("cites", "contradicts", …)
    block_id: Optional[str] = None     # block the link lives in (scroll-to-context)
    created_at: datetime = Field(default_factory=datetime.utcnow)
```

Mapping to TheBrain:

- **Parent/child**: `parent_note_id` stays the note's *primary* parent, which drives the
  breadcrumb and the children list. Extra parents are `kind="child"` edges, which gives
  multiple parents without changing the existing tree UI.
- **Jump**: `noteReference` blocks, inline links, diagram links and manual links.
- **Siblings**: computed at query time (other children of any parent). Never stored.
- **Thought types**: use the existing `Category`, or add an optional `note_type`
  (`concept` / `person` / `place` / `source` …) if categories are already used for
  something else.

### 3.3 Keeping the index correct automatically

Note content is written from several places: create and update in `routers/notes.py`,
version restore, data import in `routers/data.py`, URL import, and the AI assistant's
edits. Calling an indexer from each of them is easy to miss, so attach it **once**, as a
SQLAlchemy `before_flush` / `after_flush` session event on `Note`:

```
on Note insert/update where content changed:
    new = extract_links(note.content)          # extended extract_linked_note_ids()
    drop targets the user doesn't own / that don't exist
    delete NoteLink where source = note.id and origin = "content"
    insert new rows
```

This is cheap: one note's links per save, in SQLite, with autosave. Skip the rewrite when
the extracted set hasn't changed.

Lifecycle rules:

| Event | Behaviour |
|---|---|
| **Rename** | Nothing to do. Links store the **note id**, and chips show the *current* title, so a rename never breaks a link. (This is the main advantage over Obsidian's title-based `[[links]]`.) |
| **Move folder / re-parent** | Nothing to do for content links. `parent_note_id` updates the primary parent edge. |
| **Archive** | Links stay. Chips render as "archived", and the graph shows the note dimmed. |
| **Delete** | Remove all edges where the note is the source or target. Inline links to it in other notes render as a "missing note" chip. Offer "remove link" or "relink to…". |
| **Version restore** | It's a content write, so the hook re-indexes it. |
| **Ownership** | Index only targets the user owns, so a link can never expose another user's note. |

### 3.4 Inline links (`[[` linking)

Add a BlockNote **custom inline content** type, `noteLink`, with props `{ noteId }`. It
renders as an inline chip or underlined text showing the target's *current* title, and
clicking it navigates there with the existing referrer state.

- **Trigger:** BlockNote's `SuggestionMenuController` (already used for `/` in
  `EditorView.tsx`) takes a single trigger character. Use `[` (the menu opens on the
  second `[`, or filtering starts immediately), or add a small input rule for `[[`. The
  menu searches note titles and ends with **"Create new note '…'"**. That last option
  matters: in TheBrain you create a thought by linking to it, and the same flow here lets
  you build entity notes while you write.
- Also support pasting `/notes/<id>` URLs: they convert into `noteLink` automatically.
- Extend `extract_linked_note_ids()` to walk inline content arrays for `noteLink` items,
  and teach `export.ts`, `findReplace.ts` and the shared view about the new type. The
  export and shared-view code already handle note links for the existing blocks, so
  follow those patterns.

### 3.5 API

```
GET  /api/notes/{id}/neighbourhood   → { center, parents[], children[], jumps[], siblings[], backlinks[] }
GET  /api/notes/{id}/backlinks       → [{ note, via, block_id, snippet }]
GET  /api/notes/{id}/mentions        → unlinked mentions (see §4)
GET  /api/graph?folder=&tag=&type=&depth=&limit=   → { nodes[], edges[] }  (capped)
POST /api/links                      → manual link { source, target, kind, label }
DELETE /api/links/{id}               → manual / suggested links only
POST /api/admin/links/rebuild        → full re-index (idempotent)
```

The shared view needs a share-aware variant that only returns shared notes. Reuse the
`SharedLinkContext` / `share_token` mapping already in `routers/shared.py`.

### 3.6 UI, in order of value per effort

1. **Linked-notes panel** at the foot of the editor, or as a `MetaFlyout` tab, with
   sections for Parents, Children, Jumps (outgoing), Backlinks (incoming, with a snippet
   of the surrounding text) and Unlinked mentions. On its own this delivers most of the
   "navigate by association" value.
2. **Plex view**, a TheBrain-style local graph. It is a panel or route centred on the
   current note, with a **deterministic** layout: parents in an arc above, children in a
   row below, jumps to the left, siblings to the right. Clicking a node re-centres the
   view with an animated transition and opens that note. Keyboard: ↑ parent, ↓ child,
   ←/→ jumps and siblings, Enter to open. The layout is simple geometry, so it can be
   hand-rolled in SVG with no dependency.
3. **History trail**: generalise the one-step referrer state into a session "past notes"
   breadcrumb (the last ~20 notes visited), plus pins (`is_pinned` already exists).
4. **Global graph**: an exploratory, force-directed overview filtered by folder, tag,
   type or depth from the current note. Use `react-force-graph-2d` (canvas, fine into the
   low thousands of nodes), or `sigma` + `graphology` if your libraries get much larger.
   Colour nodes by category or type, and hover to highlight a node's neighbours.
5. **Outline mode**: the same neighbourhood shown as an indented, expandable tree. It's
   cheap once the API exists and works better on mobile.

---

## 4. Discovering links you didn't write (the "automatic" part)

Links you write by hand stay in sync on their own (§3.3). To surface links that *should*
exist, there are three tiers, cheapest first:

1. **Unlinked mentions.** Notes whose plain text contains this note's title (or an alias)
   but don't link to it. Add an SQLite **FTS5** table over title + plain text (reuse
   `extract_plain_text()`), kept current by the same save hook. Each mention offers a
   **Link** button, which rewrites that text span into a `noteLink`. Add an optional
   `aliases` field on notes ("JFK" → "John F. Kennedy").
2. **Entity notes.** Treat people, places, organisations and concepts as first-class notes
   of a `note_type`. Linking to an entity (or creating it from `[[`) gives TheBrain's
   "associated entities" navigation: open an entity and its backlinks list every note
   that mentions it.
3. **AI-suggested links.** The assistant (`find_notes` and the existing providers) reads a
   note and proposes (a) links to existing notes and (b) new entity notes to create, each
   with a reason. Suggestions go to a review queue as `origin="suggested"` edges, shown
   dashed in the graph. Accepting one makes it `manual`, or inserts an inline link.
   **Never** rewrite note content without approval, and snapshot a `NoteVersion` before
   any bulk change.

Optional, later: embedding-based similarity ("notes like this") as another kind of
suggestion. This needs an embeddings provider and a vector column, so it should wait.

---

## 5. Converting existing notes

1. **Migration:** `_run_migrations()` creates the `notelink` table (and the FTS5 table),
   following the existing pattern in `database.py`.
2. **Backfill on startup** (or through the admin rebuild endpoint): run the indexer over
   every note. This recovers every link that already exists today, with no content
   changes: `parent_note_id`, `childNote` blocks, `noteReference` blocks and diagram
   links. Record a schema flag so it runs only once.
3. **Suggested links pass** (opt-in, per folder or for all notes): compute unlinked
   mentions and exact title matches across the corpus, and present them as a reviewable
   list ("42 notes mention *Project Atlas*"). Accept per item or in bulk. Each accepted
   item becomes an inline link, with a version snapshot taken first.
4. **Optional AI entity pass:** for notes you choose, ask the assistant for entities.
   Review the proposed entity notes and links before anything is written.

Nothing in steps 1–2 changes note content. Steps 3–4 change content only with approval
and are reversible through version history.

---

## 6. Suggested phases

| Phase | Scope | Result |
|---|---|---|
| **1** | `NoteLink` table, flush-hook indexer, backfill, `/backlinks` + `/neighbourhood`, Linked-notes panel | Backlinks and association navigation over existing links, with no content changes |
| **2** | `noteLink` inline content and `[[`-style picker with "create new note", plus export/share/find-replace support | Linking while you write, and links that survive renames |
| **3** | Plex view, keyboard navigation, past-notes trail | TheBrain-style navigation |
| **4** | FTS5 unlinked mentions, aliases, bulk "suggested links" conversion | Automatic discovery and conversion of existing notes |
| **5** | Global graph, link labels/types, multiple parents in the UI, AI entity/link suggestions | Full knowledge-graph features |

Phase 1 is small: one table, one hook, two endpoints and one panel. It's the right first
step, because every later phase builds on it.

---

## 7. Open questions

1. **Folders vs graph.** Should the graph sit alongside folders (recommended), or should
   folders eventually become parent thoughts?
2. **Multiple parents.** Are they needed in the first version, or is "one primary parent
   plus jump links" enough to start with?
3. **Entities.** Should people, places and concepts be a new `note_type`, or reuse
   categories?
4. **Sharing.** Should shared pages show a (share-filtered) graph, or only backlinks?
5. **AI suggestions.** Should they run on demand only, or also on a background job after
   saving?
