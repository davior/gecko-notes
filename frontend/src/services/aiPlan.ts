// Turns a natural-language request into a structured PLAN of sequential actions
// the notes app can execute. The model returns a single JSON object; we parse it
// here (reusing the fence-stripping approach from parseTagsFromAI in ai.ts) and
// degrade gracefully to a plain "respond" action when the output isn't valid JSON.

import { detectMermaidKind, DIAGRAM_KIND_LABELS } from '@/utils/diagram'

export interface ContextNote { id: string; title: string; createdAt?: string; modifiedAt?: string }
export interface ContextFolder { id: string; name: string }
export interface ContextCategory { id: string; label: string }
export interface ContextRecipe { id: string; name: string; tags: string[]; prompt: string }


// All note `content` is MARKDOWN — converted to BlockNote blocks by the executor
// via the live editor's tryParseMarkdownToBlocks(). The model never emits BlockNote JSON.
// `spec` (optional, content-bearing actions) defers the body: the planner describes what the
// body should contain and leaves `content` empty; the body is written in a later per-step call.
export type PlanAction =
  | { type: 'respond'; text: string; description?: string }
  // Retrieval step (list-view AI Assistant): search the note library for `query`
  // and/or scope to a folder. Resolved inside the panel — NOT by planExecutor —
  // so results can be fed back into a follow-up planning round and reflected in
  // the list view. `folderId`: absent = no folder scope (global query search);
  // null = the root; a real id, or the literal "current" = the folder currently
  // being viewed (resolved at execution time). `recursive` includes descendant
  // folders — ignored when `folderId` is absent. At least one of `query`/`folderId`
  // must be set (enforced by validateAction).
  | { type: 'find_notes'; query?: string; folderId?: string | null; recursive?: boolean; description?: string }
  | { type: 'create_note'; title: string; content: string; spec?: string; ref?: string; description?: string }
  | { type: 'edit_note'; noteId: string; mode: 'replace' | 'amend'; content: string; spec?: string; description?: string }
  | { type: 'edit_section'; noteId: string; section: string; content: string; spec?: string; description?: string }
  | { type: 'append_note'; noteId: string; content: string; spec?: string; description?: string }
  | { type: 'rename_note'; noteId: string; title: string; description?: string }
  | { type: 'create_child_note'; parentId: string; title: string; content: string; spec?: string; ref?: string; description?: string }
  | { type: 'move_note'; noteId: string; folderId: string | null; description?: string }
  | { type: 'set_tags'; noteId: string; tags: string[]; mode: 'replace' | 'add'; description?: string }
  | { type: 'set_category'; noteId: string; categoryId: string; description?: string }
  | { type: 'create_folder'; name: string; parentFolderId?: string | null; ref?: string; description?: string }
  | { type: 'add_reference'; noteId: string; referenceNoteId: string; referenceTitle: string; insertAfterSection?: string; description?: string }
  | { type: 'add_annotation'; noteId: string; anchorText: string; text: string; description?: string }
  | { type: 'edit_annotation'; noteId: string; annotationId: string; text: string; description?: string }
  | { type: 'delete_annotation'; noteId: string; annotationId: string; description?: string }
  // Diagrams are custom blocks that can't be expressed in Markdown, so they use their own
  // actions carrying raw Mermaid diagram source text (not `content`).
  | { type: 'create_diagram'; noteId: string; source: string; description?: string }
  | { type: 'edit_diagram'; noteId: string; diagramId: string; source: string; description?: string }
  // Generates an image via fal.ai from `prompt` and inserts it into the note. `section`
  // (optional): a heading to place the image directly beneath (else appended at the end).
  // `alt` (optional): a short caption for the image block. The prompt is authored by the
  // model from the article content — it is NOT the user's raw request.
  | { type: 'generate_image'; noteId: string; prompt: string; section?: string; alt?: string; description?: string }
  // Recipes: saved, reusable prompts the user runs later from the composer's picker or by
  // voice ("run the summary recipe") instead of retyping them — see the "Recipes" rule below.
  | { type: 'create_recipe'; name: string; prompt: string; tags?: string[]; description?: string }
  | { type: 'update_recipe'; recipeId: string; name?: string; prompt?: string; tags?: string[]; description?: string }
  | { type: 'delete_recipe'; recipeId: string; description?: string }

export interface Plan { actions: PlanAction[] }

// Defensive ceiling so a runaway model can't queue thousands of mutations.
export const MAX_PLAN_ACTIONS = 50

interface BuildReferenceOpts {
  // Bodies of the *other* in-context notes (folder/children scopes). The currently
  // open note is NOT here — its live body is sent in the latest user message so edits
  // to it don't invalidate the cached prefix this block lives in.
  referenceContextText: string
  targetNotes: ContextNote[]
  folders: ContextFolder[]
  categories: ContextCategory[]
  // The user's saved Recipes, for update_recipe/delete_recipe targeting and so
  // create_recipe can be written with awareness of what already exists.
  recipes: ContextRecipe[]
  // The folder the user is currently viewing (list view) or whose note is open (editor).
  // null = the root / top level. Lets the model resolve "here"/"this folder".
  currentFolderId?: string | null
  currentFolderName?: string | null
}

// Compact rendering of a note's timestamps for the context lists. Both dates are the
// ISO-8601 UTC strings the API returns; returns '' when neither is available so notes
// without dates (e.g. a freshly created, unsaved note) render unchanged.
export function formatNoteMeta(createdAt?: string | null, modifiedAt?: string | null): string {
  const parts: string[] = []
  if (createdAt) parts.push(`created ${createdAt}`)
  if (modifiedAt) parts.push(`modified ${modifiedAt}`)
  return parts.length ? ` (${parts.join(', ')})` : ''
}

// Static, never-changing instruction block. Kept separate (and a module constant) so
// it can be marked as a stable Anthropic prompt-cache prefix on every request: it is
// byte-identical across every turn, note, and session, so it should always be a cache
// hit. Everything that varies (note lists, note bodies, the conversation) lives after
// the cache breakpoint, in buildPlanReferenceBlock and the message array.
export const PLAN_INSTRUCTIONS = `You are an AI assistant and research helper for a note-taking app. You help the user in two ways: (1) by ANSWERING questions and discussing their notes in conversation, and (2) ONLY when the user explicitly asks for it, by making changes to their notes (creating, editing, organising, tagging, annotating, etc.). You turn the user's request into a PLAN of sequential actions executed against their notes.

Output format (JSON only — no prose, no markdown code fences):
{ "actions": [ <action>, ... ] }

Action types (every action MAY also include an optional "description": one short plain sentence summarising it for a confirmation preview):
- respond:           { "type":"respond", "text":"<markdown>" }
- find_notes:        { "type":"find_notes", "query":"<search text>" } — or/also scope by folder: add "folderId":"<id>"|"current"|null and optionally "recursive":true (see "Finding notes" rule below)
- create_note:       { "type":"create_note", "title":"<title>", "content":"<markdown>", "ref":"<optional local label>" }
- edit_note:         { "type":"edit_note", "noteId":"<id>", "mode":"replace"|"amend", "content":"<markdown>" }
- edit_section:       { "type":"edit_section", "noteId":"<id>", "section":"<heading text>", "content":"<markdown incl. the section heading>" }
- append_note:       { "type":"append_note", "noteId":"<id>", "content":"<markdown>" }
- rename_note:       { "type":"rename_note", "noteId":"<id>", "title":"<new title>" }
- create_child_note: { "type":"create_child_note", "parentId":"<id>", "title":"<title>", "content":"<markdown>", "ref":"<optional local label>" }
- move_note:         { "type":"move_note", "noteId":"<id>", "folderId":"<id>"|null }
- set_tags:          { "type":"set_tags", "noteId":"<id>", "tags":["..."], "mode":"replace"|"add" }
- set_category:      { "type":"set_category", "noteId":"<id>", "categoryId":"<id>" }
- create_folder:     { "type":"create_folder", "name":"<name>", "parentFolderId":"<id>"|null, "ref":"<optional local label>" }
- add_reference:     { "type":"add_reference", "noteId":"<id>", "referenceNoteId":"<id>", "referenceTitle":"<title>", "insertAfterSection":"<optional heading>" }
- add_annotation:    { "type":"add_annotation", "noteId":"<id>", "anchorText":"<verbatim snippet of the block to attach to>", "text":"<markdown annotation>" }
- edit_annotation:   { "type":"edit_annotation", "noteId":"<id>", "annotationId":"<id>", "text":"<new markdown annotation>" }
- delete_annotation: { "type":"delete_annotation", "noteId":"<id>", "annotationId":"<id>" }
- create_diagram:    { "type":"create_diagram", "noteId":"<id>", "source":"<complete Mermaid diagram source>" }
- edit_diagram:      { "type":"edit_diagram", "noteId":"<id>", "diagramId":"<id>", "source":"<complete replacement Mermaid diagram source>" }
- generate_image:    { "type":"generate_image", "noteId":"<id>", "prompt":"<detailed text-to-image prompt>", "section":"<optional heading to insert under>", "alt":"<optional caption>" }
- create_recipe:     { "type":"create_recipe", "name":"<short name>", "prompt":"<self-contained prompt text>", "tags":["optional", "lowercase", "tags"] }
- update_recipe:     { "type":"update_recipe", "recipeId":"<id>", "name":"<optional new name>", "prompt":"<optional new prompt>", "tags":["optional new tags"] }
- delete_recipe:     { "type":"delete_recipe", "recipeId":"<id>" }

Rules:
- Valid JSON only (IMPORTANT): your entire output must be a single, strictly-valid JSON object that JSON.parse accepts. Inside every string value — above all a note "content" — escape each double quote as \\" and each newline as \\n. Safer still, use typographic quotes (“ ” ‘ ’) for any quotation marks you write in prose, since those never need escaping — reserve the straight " for JSON's own delimiters. A SINGLE unescaped straight quote inside a string breaks the entire plan, so it is silently shown to the user as raw text instead of running. For a long note body, or when creating/rewriting several notes, this is a strong extra reason to defer the body with "spec" (see "Deferred body generation" below): a deferred body is written as plain text in a later step and needs no JSON escaping at all.
- Finding notes (find_notes): Use this ONLY when no notes are listed in context below and you need to locate notes to fulfil the request. Scope a find_notes action by free text, by folder, or both:
  - "query": a concise search string — matched as a substring over note titles AND bodies, so it may return extra notes; pick the right ones yourself by their titles/bodies (e.g. for "title starting with 'Testimony'", keep only notes whose title actually starts with "Testimony").
  - "folderId": scope to one folder — a folder id from the "Folders" list below, "current" (the folder currently being viewed — see the reference block header), or null (the root). Add "recursive":true to also include every folder nested beneath it, however deep — you do NOT need to know the folder hierarchy yourself. Examples: "find the notes in this folder" → {"type":"find_notes","folderId":"current"}; "find all notes in the sub-folders of this folder" → {"type":"find_notes","folderId":"current","recursive":true}; "notes about invoices in this folder" → {"type":"find_notes","folderId":"current","query":"invoices"}.
  At least one of "query" or "folderId" is required. Return a plan whose ONLY action(s) are find_notes (usually one, but you may emit more than one, e.g. to search two different folders — the hits are merged). The matching notes are then added to your context and you are asked to continue: at that point either return a "respond" action (for a pure "find" request — the results are already shown to the user) or emit mutation actions targeting the found note ids (for a "find and act" request, e.g. find the sub-folder notes, then move_note each into the current folder). Do NOT use find_notes when notes are already listed in context, or when the request only creates brand-new notes.
- ANSWER BY DEFAULT — do NOT modify notes unless explicitly asked. If the user asks a question, asks you to explain, research, or summarise something in the chat, or otherwise just wants information, return ONLY a single "respond" action containing your answer. NEVER create, edit, append, rename, move, tag, annotate, or otherwise change a note unless the user EXPLICITLY tells you to change their notes (e.g. "create a note…", "add this to the note", "rename…", "tag…", "organise…"). When a request is ambiguous, or could be satisfied with a conversational answer, prefer a "respond" action over modifying notes.
- All note "content" is MARKDOWN. Never output BlockNote or raw JSON as a note body. The note bodies given to you — both in the "Context (note bodies)" section and in the latest "Current note — live" message — are Markdown; preserve their existing formatting (headings, bold, lists, links) when editing.
- Deferred body generation (IMPORTANT for long or multiple bodies): For create_note, create_child_note, edit_note, edit_section and append_note you may EITHER write the body inline in "content", OR set "spec" to a precise description of what the body must contain and leave "content" empty (""). When a body would be long, or you are creating/rewriting MULTIPLE notes, PREFER "spec" and leave "content" empty — each spec'd body is written in a separate follow-up step that sees this same plan and context, which avoids truncation. Use inline "content" only for short, simple bodies. Never set both for the same action.
- "noteId", "parentId", "folderId" and "categoryId" MUST be an id taken from the lists below, OR a "ref" label you assigned to an entity created earlier in THIS plan. NEVER invent an id. (Exception: find_notes's "folderId" may also be "current" or null — see "Finding notes" above.)
- For the note the user currently has open ("this note", "this article", …), use its id from the list below, or the literal "current". Its live, up-to-date content is provided in the most recent user message (labelled "Current note — live"); other in-context notes appear in the "Context (note bodies)" section. Ids that appear only earlier in the conversation may be stale — do not reuse an id unless it is listed below.
- Dates and the current folder: every note in "Notes in context" is annotated with its creation and last-modified timestamps in ISO-8601 UTC (e.g. "(created 2026-07-01T…Z, modified 2026-07-03T…Z)"). The reference block header also states the current date and the folder the user is currently viewing. Use these to satisfy date-based requests — e.g. "created more than 3 days ago", "modified this week", "the oldest notes", "sort by date" — computing any relative dates against the stated current date. When the user says "here", "this folder", or "in here", it means the folder currently being viewed: use its id as "parentFolderId" for create_folder and as "folderId" for move_note (a null current folder means the root). Newly created notes are automatically placed in the current folder, so create_note needs no folder id.
- Note references: "referenceNoteId" and "referenceTitle" for add_reference actions must come from the notes listed below. If a note to reference is not in context, return a respond action explaining which note to add to the context.
- Forward references: a create_note / create_child_note / create_folder action may set "ref" to a short label (e.g. "f1"); a later action may use that label anywhere an id is expected (e.g. move a note into "folderId":"f1"). This lets you, for example, create a folder and then move notes into it within one plan.
- Choosing how to edit (IMPORTANT — preserve formatting and embedded blocks):
  - To ADD content, use append_note or edit_note "amend". These keep ALL existing content, including embedded child notes, note references, links and images.
  - To CHANGE an existing section, use edit_section: set "section" to that section's heading text and "content" to the new Markdown for the whole section (include the heading). Only that section is rewritten; every other section is preserved untouched.
  - Use edit_note "replace" ONLY when the user explicitly asks to rewrite the ENTIRE note. It discards all other sections, formatting and embedded blocks, so avoid it for section-level changes.
- Annotations: a note's existing annotations are listed under it as "Annotations on this note" with an "[annotation <id>]" and the snippet of the block they are anchored to. To edit/delete one, use its "<id>" as "annotationId". To add one, set "anchorText" to a short verbatim snippet of the block the annotation should attach to (it is matched against the note's block text). When asked to "read the annotations and revise the note", read these annotation texts and apply the implied edits with edit_section / edit_note / append_note actions.
- Diagrams: use create_diagram to ADD a new diagram to a note, and edit_diagram to change an existing one. A note's existing diagrams are listed under it as "Diagrams on this note" with a "[diagram <id>]" tag and their current Mermaid source — use that "<id>" as "diagramId" for edit_diagram (which REPLACES the whole diagram, so "source" must be the complete new diagram, not a fragment). "source" must be complete, valid Mermaid syntax starting with the right header keyword for the kind: "flowchart TD" (or LR/BT/RL) for flow charts, "mindmap" for mind maps, "sequenceDiagram" for sequence diagrams, "classDiagram" for class diagrams, "stateDiagram-v2" for state diagrams, "erDiagram" for entity-relationship diagrams, "gantt" for Gantt charts, "pie" for pie charts, "timeline" for timelines. Node linking: in flowchart, classDiagram and stateDiagram-v2 ONLY, a node can link to another note or a URL by adding a line "click <nodeId> href \"/notes/<id>\"" (linking to a note id from the lists below) or "click <nodeId> href \"<url>\" \"_blank\"" (linking to the web) — do NOT add click/href lines for mindmap, sequenceDiagram, erDiagram, gantt, pie or timeline diagrams, since Mermaid does not support node links on those kinds (mindmap link support is a currently open Mermaid limitation). Only create or edit a diagram when the user explicitly asks for one (e.g. "make a mind map of this note", "add a step to the flow chart").
- Images (generate_image): Use ONLY when the user explicitly asks to create/generate/add an image, picture, illustration or photo (e.g. "make an image for this article", "add a picture", "create an image for each chapter and put it under each title"). YOU author the "prompt": write a vivid, self-contained text-to-image prompt derived from the relevant article content (describe subject, setting, style, mood, composition) — do NOT just copy the user's request verbatim. Set "section" to a section/chapter heading's text to insert the image directly beneath that heading; omit "section" to append the image at the end of the note. For "an image for each chapter/section", emit ONE generate_image action per chapter — each with that chapter's heading text as "section" and its own prompt tailored to that chapter. Optionally set "alt" to a short caption. Generating images costs money, so create only the images the user asked for and no more.
- Recipes (create_recipe / update_recipe / delete_recipe): a Recipe is a saved, reusable prompt the user can run later — from a picker in the AI composer, or by voice ("run the summary recipe") — instead of retyping it each time. The user's existing recipes are listed below under "Recipes". Only create, update or delete a recipe when the user EXPLICITLY asks you to (e.g. "make a recipe that…", "save this as a recipe called…", "create a recipe for X", "rename/update/delete the X recipe") — never as a side effect of an unrelated request, and never in place of simply explaining how recipes work (use a "respond" action for that). When authoring "prompt": it will be sent later as a brand-new message with NO memory of the current conversation, so write it fully self-contained — never reference "this", "what we just discussed", or anything specific to the current chat. Use the placeholders {{title}} (the note open when the recipe is later run), {{selected text}} (the user's text selection at that time) and {{date}} (that day's date) so the recipe adapts to whatever it's run against, instead of hard-coding today's specifics. Give it a short, descriptive "name" and 0+ short lowercase "tags" for grouping (e.g. ["summary"]); omit "tags" if none apply. For update_recipe/delete_recipe, "recipeId" MUST be an id from the "Recipes" list below — never invent one — and update_recipe should omit any field the user isn't changing.
- If the request targets a note that is not listed below, or you otherwise lack the context to fulfil it, return ONLY a single respond action that explains what the user needs to add to the context. Do not guess or fabricate.
- Output ONLY the JSON object. No explanations and no code fences around it.`

// Extra guidance appended to the instructions ONLY for providers whose API actually wires
// up a native web_search tool — currently just Anthropic (see AnthropicProvider in ai.ts,
// which attaches the web_search_20250305 server tool). It is deliberately kept OUT of the
// base PLAN_INSTRUCTIONS: a provider that is TOLD it has a web_search tool but is given no
// such tool "calls" it the only way it can — by emitting Claude's text tool-call markup
// (<tool_calls><invoke name="web_search"><parameter …>…) as ordinary output, which then
// shows up verbatim in the chat instead of running a search. So the promise of the tool and
// the tool itself are gated together, on the same provider check (see supportsWebSearch).
export const WEB_SEARCH_INSTRUCTIONS = `You have access to a web_search tool — use it whenever you need current information, facts, or research to fulfil the request. After completing any searches, you MUST output a single JSON object as your final response and NOTHING else, exactly as specified above.`

// Extra guidance appended to PLAN_INSTRUCTIONS only when the request comes from voice
// mode. The user is speaking and will HEAR the "respond" text via text-to-speech, so
// it must sound like natural conversation rather than a written, Markdown-formatted
// answer. This deliberately constrains ONLY the spoken "respond" text — note bodies
// (a note action's "content"/"spec") are saved to the user's notes, read on screen,
// and must stay well-structured Markdown exactly as the rules above require.
export const VOICE_REPLY_INSTRUCTIONS = `VOICE MODE — the user is talking to you out loud and will HEAR your "respond" text read aloud by text-to-speech. Make every "respond" action sound like a natural spoken reply:
- Be brief and get to the point: usually 1-3 short sentences. Give the answer first, then offer to say more ("want me to go into detail?") instead of delivering everything at once.
- Write plain spoken prose, NOT Markdown. In "respond" text do not use headings, bullet or numbered lists, tables, code blocks, links, asterisks, backticks, or emoji. If you need to enumerate, weave it into a sentence ("a couple of things — first…, and then…").
- Word it the way you'd say it aloud: spell out or skip URLs, file paths, long ids and symbol-heavy strings, use words for small numbers, and keep sentences short and easy to follow by ear.
- Sound warm, direct and conversational, like a helpful person speaking — not a written report.
This applies ONLY to spoken "respond" text. Any note "content" or "spec" you write must still be well-structured Markdown exactly as instructed above — those are saved to the user's notes, not read aloud. The JSON plan format and every other rule above are unchanged.`

// Dynamic context block: the id/title/folder/category lists plus the bodies of the
// *other* in-context notes. Stable within a conversation (it changes only when notes
// are added/renamed or the scope changes), so it sits behind its own cache breakpoint —
// after PLAN_INSTRUCTIONS, before the volatile current-note body and the new request.
export function buildPlanReferenceBlock({ referenceContextText, targetNotes, folders, categories, recipes, currentFolderId, currentFolderName }: BuildReferenceOpts): string {
  const noteList = targetNotes.length
    ? targetNotes.map((n) => `- ${n.id} — ${n.title || 'Untitled'}${formatNoteMeta(n.createdAt, n.modifiedAt)}`).join('\n')
    : '(none)'
  const folderList = folders.length
    ? folders.map((f) => `- ${f.id} — ${f.name}`).join('\n')
    : '(none)'
  const categoryList = categories.length
    ? categories.map((c) => `- ${c.id} — ${c.label}`).join('\n')
    : '(none)'
  const recipeList = recipes.length
    ? recipes.map((r) => `- ${r.id} — ${r.name}${r.tags.length ? ` [${r.tags.join(', ')}]` : ''} — ${truncate(r.prompt, 100)}`).join('\n')
    : '(none)'

  // Day precision (not a full timestamp) keeps this cacheable reference block byte-stable
  // within a session, preserving the Anthropic prompt-cache prefix, while still letting the
  // model resolve relative queries like "created more than 3 days ago".
  const currentDate = new Date().toISOString().slice(0, 10)
  const viewing = currentFolderId
    ? `${currentFolderId} — ${currentFolderName || 'Untitled folder'}`
    : 'the root (top level)'

  return `Current date (UTC): ${currentDate}
Currently viewing folder: ${viewing}

Notes in context (id — title):
${noteList}

Folders (id — name):
${folderList}

Categories (id — label):
${categoryList}

Recipes (id — name [tags] — prompt preview):
${recipeList}

Context (note bodies):
${referenceContextText || '(the currently open note is provided in the latest message; no other notes are in context)'}`
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function validateAction(raw: unknown): PlanAction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const a = raw as Record<string, unknown>
  // Returning object literals directly lets the function's PlanAction return type
  // contextually type the `type` discriminant (a generic helper would widen it to string).
  const desc = asString(a.description)
  const d = desc ? { description: desc } : {}
  const ref = asString(a.ref)
  const r = ref ? { ref } : {}
  // Optional deferred-body description on content-bearing actions (see PlanAction `spec`).
  const specVal = asString(a.spec)
  const sp = specVal ? { spec: specVal } : {}

  switch (a.type) {
    case 'respond': {
      const text = asString(a.text)
      if (text === undefined) return null
      return { type: 'respond', text, ...d }
    }
    case 'find_notes': {
      const query = asString(a.query)
      // Distinguish "absent" (no folder scope) from an explicit `null` (root) —
      // asString(undefined) also yields undefined, so this can't reuse that helper.
      const folderIdGiven = a.folderId === null || typeof a.folderId === 'string'
      if (!query && !folderIdGiven) return null
      const folderId = folderIdGiven ? (a.folderId === null ? null : (a.folderId as string)) : undefined
      return {
        type: 'find_notes',
        ...(query ? { query } : {}),
        ...(folderIdGiven ? { folderId } : {}),
        ...(a.recursive === true ? { recursive: true } : {}),
        ...d,
      }
    }
    case 'create_note': {
      const title = asString(a.title)
      if (title === undefined) return null
      return { type: 'create_note', title, content: asString(a.content) ?? '', ...sp, ...r, ...d }
    }
    case 'edit_note': {
      const noteId = asString(a.noteId)
      if (!noteId) return null
      return { type: 'edit_note', noteId, mode: a.mode === 'replace' ? 'replace' : 'amend', content: asString(a.content) ?? '', ...sp, ...d }
    }
    case 'edit_section': {
      const noteId = asString(a.noteId)
      const section = asString(a.section)
      if (!noteId || !section) return null
      return { type: 'edit_section', noteId, section, content: asString(a.content) ?? '', ...sp, ...d }
    }
    case 'append_note': {
      const noteId = asString(a.noteId)
      if (!noteId) return null
      return { type: 'append_note', noteId, content: asString(a.content) ?? '', ...sp, ...d }
    }
    case 'rename_note': {
      const noteId = asString(a.noteId)
      const title = asString(a.title)
      if (!noteId || title === undefined) return null
      return { type: 'rename_note', noteId, title, ...d }
    }
    case 'create_child_note': {
      const parentId = asString(a.parentId)
      const title = asString(a.title)
      if (!parentId || title === undefined) return null
      return { type: 'create_child_note', parentId, title, content: asString(a.content) ?? '', ...sp, ...r, ...d }
    }
    case 'move_note': {
      const noteId = asString(a.noteId)
      if (!noteId) return null
      return { type: 'move_note', noteId, folderId: a.folderId === null ? null : asString(a.folderId) ?? null, ...d }
    }
    case 'set_tags': {
      const noteId = asString(a.noteId)
      if (!noteId || !Array.isArray(a.tags)) return null
      return { type: 'set_tags', noteId, tags: a.tags.map(String), mode: a.mode === 'add' ? 'add' : 'replace', ...d }
    }
    case 'set_category': {
      const noteId = asString(a.noteId)
      const categoryId = asString(a.categoryId)
      if (!noteId || !categoryId) return null
      return { type: 'set_category', noteId, categoryId, ...d }
    }
    case 'create_folder': {
      const name = asString(a.name)
      if (!name) return null
      return { type: 'create_folder', name, parentFolderId: a.parentFolderId === null ? null : asString(a.parentFolderId) ?? null, ...r, ...d }
    }
    case 'add_reference': {
      const noteId = asString(a.noteId)
      const referenceNoteId = asString(a.referenceNoteId)
      const referenceTitle = asString(a.referenceTitle)
      if (!noteId || !referenceNoteId || referenceTitle === undefined) return null
      const insertAfterSection = asString(a.insertAfterSection)
      return { type: 'add_reference', noteId, referenceNoteId, referenceTitle, insertAfterSection, ...d }
    }
    case 'add_annotation': {
      const noteId = asString(a.noteId)
      const anchorText = asString(a.anchorText)
      if (!noteId || !anchorText) return null
      return { type: 'add_annotation', noteId, anchorText, text: asString(a.text) ?? '', ...d }
    }
    case 'edit_annotation': {
      const noteId = asString(a.noteId)
      const annotationId = asString(a.annotationId)
      if (!noteId || !annotationId) return null
      return { type: 'edit_annotation', noteId, annotationId, text: asString(a.text) ?? '', ...d }
    }
    case 'delete_annotation': {
      const noteId = asString(a.noteId)
      const annotationId = asString(a.annotationId)
      if (!noteId || !annotationId) return null
      return { type: 'delete_annotation', noteId, annotationId, ...d }
    }
    case 'create_diagram': {
      const noteId = asString(a.noteId)
      const source = asString(a.source)
      if (!noteId || !source?.trim()) return null
      return { type: 'create_diagram', noteId, source, ...d }
    }
    case 'edit_diagram': {
      const noteId = asString(a.noteId)
      const diagramId = asString(a.diagramId)
      const source = asString(a.source)
      if (!noteId || !diagramId || !source?.trim()) return null
      return { type: 'edit_diagram', noteId, diagramId, source, ...d }
    }
    case 'generate_image': {
      const noteId = asString(a.noteId)
      const prompt = asString(a.prompt)
      if (!noteId || !prompt?.trim()) return null
      const section = asString(a.section)
      const alt = asString(a.alt)
      return { type: 'generate_image', noteId, prompt, ...(section ? { section } : {}), ...(alt ? { alt } : {}), ...d }
    }
    case 'create_recipe': {
      const name = asString(a.name)
      const prompt = asString(a.prompt)
      if (!name || !prompt?.trim()) return null
      const tags = Array.isArray(a.tags) ? { tags: a.tags.map(String) } : {}
      return { type: 'create_recipe', name, prompt, ...tags, ...d }
    }
    case 'update_recipe': {
      const recipeId = asString(a.recipeId)
      if (!recipeId) return null
      const name = asString(a.name)
      const prompt = asString(a.prompt)
      const tags = Array.isArray(a.tags) ? { tags: a.tags.map(String) } : {}
      return { type: 'update_recipe', recipeId, ...(name ? { name } : {}), ...(prompt ? { prompt } : {}), ...tags, ...d }
    }
    case 'delete_recipe': {
      const recipeId = asString(a.recipeId)
      if (!recipeId) return null
      return { type: 'delete_recipe', recipeId, ...d }
    }
    default:
      return null
  }
}

// A parsed JSON value that could be a plan: either the {actions:[...]} envelope or
// a bare {type:...} action (the model sometimes emits the latter).
function looksLikePlan(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') return false
  const o = parsed as Record<string, unknown>
  return Array.isArray(o.actions) || typeof o.type === 'string'
}

// Index of the '}' matching the '{' at `open`, or -1 if unbalanced. Braces inside
// JSON string literals (and their backslash escapes) are ignored, so prose like
// `the set {a, b}` embedded in a string doesn't throw off the depth count.
function matchBrace(text: string, open: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

// Best-effort repair for the one malformation the strict parser can't handle: a double
// quote left UNESCAPED inside a JSON string value — e.g. a note body that writes
// `*Note: "Many TIs report…"` with straight ASCII quotes instead of \" or typographic
// “ ”. The first such quote ends the string early and turns the rest of the object into
// a syntax error, so the whole plan is lost and the raw reply is shown as text instead.
// This walks the JSON and escapes any `"` that is clearly interior to a string rather
// than a real terminator. It runs ONLY as a fallback after strict JSON.parse fails, and
// its output is used only if it then parses to a plan — so it can rescue an unparseable
// reply but never alters one that already parsed.
function repairUnescapedQuotes(src: string): string {
  const out: string[] = []
  const stack: string[] = [] // enclosing containers ('{' / '['), tracked outside strings
  const n = src.length

  const skipWs = (j: number): number => {
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++
    return j
  }

  // Given the index just after a candidate closing quote, is that quote a real string
  // terminator (vs. a stray quote inside the string)? A terminator is followed by a
  // structural token: ':' (ends a key), '}'/']' (ends the last value/element), or a ','
  // that truly separates values. The ',' case is the ambiguous one (`"phrase",` sits
  // happily inside prose): in an object a real value-close is followed by ',' then the
  // next KEY (a string followed by ':'), so if what follows the comma isn't such a key
  // the quote was interior; array elements are always comma-separated, so there a ','
  // does close the element.
  const isRealClose = (after: number): boolean => {
    const k = skipWs(after)
    if (k >= n) return true
    const c = src[k]
    if (c === ':' || c === '}' || c === ']') return true
    if (c !== ',') return false
    let m = skipWs(k + 1)
    if (m >= n) return true
    const d = src[m]
    if (d === '}' || d === ']') return true         // tolerated trailing comma
    if (stack[stack.length - 1] !== '{') return true // array element separator
    if (d !== '"') return false                      // object value-close needs a key next
    m++                                              // scan the following (escape-aware) key
    while (m < n) {
      if (src[m] === '\\') { m += 2; continue }
      if (src[m] === '"') break
      m++
    }
    return src[skipWs(m + 1)] === ':'                // …a key is a string followed by ':'
  }

  let i = 0
  while (i < n) {
    const c = src[i]
    if (c !== '"') {
      if (c === '{' || c === '[') stack.push(c)
      else if (c === '}' || c === ']') stack.pop()
      out.push(c)
      i++
      continue
    }
    out.push('"') // opening quote — scan the body to its true end, escaping stray quotes
    i++
    while (i < n) {
      const ch = src[i]
      if (ch === '\\') { out.push(ch); if (i + 1 < n) out.push(src[i + 1]); i += 2; continue }
      if (ch === '"') {
        if (isRealClose(i + 1)) { out.push('"'); i++; break }
        out.push('\\"'); i++
        continue
      }
      out.push(ch)
      i++
    }
  }
  return out.join('')
}

// Strict JSON parse of a candidate slice, falling back to a quote-repair pass. Returns
// the JSON text to use (the original when already valid, the repaired text when repair
// makes it a valid plan) or null when neither yields a plan.
function planJsonOrRepair(candidate: string): string | null {
  try {
    if (looksLikePlan(JSON.parse(candidate))) return candidate
  } catch { /* fall through to the repair attempt */ }
  try {
    const repaired = repairUnescapedQuotes(candidate)
    if (repaired !== candidate && looksLikePlan(JSON.parse(repaired))) return repaired
  } catch { /* unrepairable — give up on this candidate */ }
  return null
}

// Locate the plan JSON inside a (possibly prose-wrapped) model response, returning
// the JSON slice plus the prose before and after it. Prefers a fenced ```json block;
// otherwise scans for the FIRST brace-balanced slice that parses to a plan — so a
// stray '{' in prose (e.g. an inline example) doesn't hijack the parse the way the
// old indexOf('{')…lastIndexOf('}') did, and prose surrounding the JSON is preserved.
// Each candidate goes through planJsonOrRepair, so a plan carrying an unescaped inner
// quote (which would otherwise fail JSON.parse and be dumped verbatim as text) is
// recovered rather than lost.
interface LocatedPlan { json: string; before: string; after: string }
function locatePlanJson(text: string): LocatedPlan | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence.index !== undefined) {
    const inner = fence[1].trim()
    if (inner.startsWith('{')) {
      const json = planJsonOrRepair(inner)
      if (json) return { json, before: text.slice(0, fence.index), after: text.slice(fence.index + fence[0].length) }
    }
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const end = matchBrace(text, i)
    if (end === -1) continue
    const json = planJsonOrRepair(text.slice(i, end + 1))
    if (json) return { json, before: text.slice(0, i), after: text.slice(end + 1) }
  }
  // Last resort: an unescaped quote can desync matchBrace's string tracking so no
  // balanced slice is found above. Try the widest {…} span with a repair pass — reached
  // only when the precise scan found nothing, so it never overrides a cleaner match.
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) {
    const json = planJsonOrRepair(text.slice(first, last + 1))
    if (json) return { json, before: text.slice(0, first), after: text.slice(last + 1) }
  }
  return null
}

// Prose the model wrote outside the JSON envelope, cleaned but with Markdown
// structure (paragraphs/lists) preserved. This is the real answer in the failure
// mode where the model puts its reply in prose and only a meta-summary in respond.text.
function extractOutsideProse(located: LocatedPlan): string {
  return [located.before, located.after]
    .map((s) => s.replace(/```(?:json)?/gi, '').trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Some OpenAI-compatible models — DeepSeek most notably — ignore the "JSON only"
// contract and wrap their plan in an XML-style <actions>…</actions> block instead of
// the `{ "actions": [...] }` envelope, or, for a plain conversational reply, append an
// EMPTY <actions></actions> after their prose (e.g. `I'll look into that.\n<actions>
// </actions>`). Neither is valid plan JSON, so locatePlanJson misses it and the tags
// render verbatim in the chat. Fold any such block back into the JSON the parser
// expects — an array inner becomes an `{"actions": …}` envelope, a bare object/envelope
// inner is passed through — and drop it entirely when empty, leaving the surrounding
// prose as the reply. A no-op for well-formed replies (the regex simply never matches).
export function normalizeActionTags(raw: string): string {
  let out = raw.replace(/<actions\b[^>]*>([\s\S]*?)<\/actions>|<actions\b[^>]*\/>/gi, (_m, body) => {
    const inner = (body ?? '').trim()
    if (!inner) return ''                               // empty container → strip the tags
    if (inner.startsWith('[')) return `{"actions": ${inner}}`  // bare action array → envelope
    return inner                                        // object / full envelope → hand to the JSON locator
  })
  // Remove any orphan/unclosed <actions …> or </actions> markers left behind (e.g. a
  // reply truncated mid-block, or a stray opener while still streaming) — they are
  // container noise, never content.
  out = out.replace(/<\/?actions\b[^>]*>/gi, '')

  // Strip Claude's TEXT tool-call markup — <function_calls>/<tool_calls> wrapping
  // <invoke name="…"><parameter …>…. A model that is told it has a tool but whose provider
  // wired up none "calls" it by emitting this as ordinary output; it is never valid plan
  // JSON, so without this it renders verbatim in the chat (the web-search bug). Drop the
  // whole block, preserving any prose the model wrote around it. Providers are no longer
  // told about tools they lack (see WEB_SEARCH_INSTRUCTIONS), so this is a backstop for any
  // model that emits the markup regardless — and it keeps it out of the live stream too.
  out = out.replace(/<(function_calls|tool_calls)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  // Orphan wrapper tags from a reply truncated mid-call (e.g. while still streaming).
  out = out.replace(/<\/?(?:function_calls|tool_calls)\b[^>]*>/gi, '')
  return out
}

export function parsePlan(raw: string): Plan {
  const text = normalizeActionTags(raw)
  if (!text || !text.trim()) return { actions: [{ type: 'respond', text: '(no response)' }] }
  // No parseable plan JSON → the whole message IS the reply. Never drop it.
  const proseFallback = (): Plan => ({ actions: [{ type: 'respond', text: text.trim() || '(no response)' }] })
  // A plan JSON envelope WAS located but yielded no usable action (e.g. every action
  // failed validation, as with an empty find_notes query). Show only the prose around
  // it — never the literal JSON — falling back to a generic message when there's no
  // prose at all (the model emitted ONLY invalid JSON).
  const invalidPlanFallback = (located: LocatedPlan): Plan => {
    const outside = extractOutsideProse(located)
    return { actions: [{ type: 'respond', text: outside || "I couldn't come up with a valid plan for that — could you rephrase your request?" }] }
  }

  try {
    const located = locatePlanJson(text)
    if (!located) return proseFallback()

    const parsed = JSON.parse(located.json) as unknown
    // A bare action object (e.g. {"type":"respond",...}) is wrapped so it's validated
    // and rendered as a normal reply rather than shown as raw JSON.
    const isBareAction = parsed !== null && typeof parsed === 'object' && 'type' in parsed
    const actionsRaw = isBareAction ? [parsed] : (parsed as { actions?: unknown }).actions
    if (!Array.isArray(actionsRaw)) return invalidPlanFallback(located)

    const actions: PlanAction[] = []
    for (const a of actionsRaw.slice(0, MAX_PLAN_ACTIONS)) {
      const valid = validateAction(a)
      if (valid) actions.push(valid)
    }
    if (actions.length === 0) return invalidPlanFallback(located)

    // Prepend any outside prose as a respond action so it shows first (respond-only
    // plans) or above the mutation table (mixed plans) and survives a plan cancel.
    const outside = extractOutsideProse(located)
    if (outside) actions.unshift({ type: 'respond', text: outside })

    if (actionsRaw.length > MAX_PLAN_ACTIONS) {
      actions.push({ type: 'respond', text: `_(Plan truncated to the first ${MAX_PLAN_ACTIONS} actions.)_` })
    }
    return { actions }
  } catch {
    return proseFallback()
  }
}

// ─── Preview labels ─────────────────────────────────────────────────────────

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

// Human-readable label for a plan action, used in the confirmation preview.
// `labelMap` resolves note/folder/category ids (and forward-ref labels) to names.
export function defaultActionLabel(action: PlanAction, labelMap: Map<string, string>): string {
  if (action.description) return action.description
  const name = (id: string) => labelMap.get(id) ?? id
  switch (action.type) {
    case 'respond': return `Reply: ${truncate(action.text)}`
    case 'find_notes': {
      const parts: string[] = []
      if (action.query) parts.push(`“${truncate(action.query, 60)}”`)
      if (action.folderId !== undefined) {
        const folderLabel = action.folderId === 'current' ? 'the current folder' : action.folderId === null ? 'the root' : name(action.folderId)
        parts.push(action.recursive ? `in ${folderLabel} and its subfolders` : `in ${folderLabel}`)
      }
      return `Search notes${parts.length ? ' for ' + parts.join(' ') : ''}`
    }
    case 'create_note': return `Create note “${action.title || 'Untitled'}”`
    case 'edit_note': return `${action.mode === 'amend' ? 'Amend' : 'Replace'} note “${name(action.noteId)}”`
    case 'edit_section': return `Update section “${action.section}” in “${name(action.noteId)}”`
    case 'append_note': return `Append to note “${name(action.noteId)}”`
    case 'rename_note': return `Rename “${name(action.noteId)}” → “${action.title}”`
    case 'create_child_note': return `Create child note “${action.title || 'Untitled'}” under “${name(action.parentId)}”`
    case 'move_note': return `Move “${name(action.noteId)}” to ${action.folderId ? `folder “${name(action.folderId)}”` : 'the root'}`
    case 'set_tags': return `${action.mode === 'add' ? 'Add tags to' : 'Set tags on'} “${name(action.noteId)}”: ${action.tags.join(', ')}`
    case 'set_category': return `Set category of “${name(action.noteId)}” to “${name(action.categoryId)}”`
    case 'create_folder': return `Create folder “${action.name}”`
    case 'add_reference': return `Add reference to “${action.referenceTitle}” in “${name(action.noteId)}”${action.insertAfterSection ? ` under “${action.insertAfterSection}”` : ''}`
    case 'add_annotation': return `Annotate “${truncate(action.anchorText, 40)}” in “${name(action.noteId)}”`
    case 'edit_annotation': return `Edit annotation in “${name(action.noteId)}”`
    case 'delete_annotation': return `Delete annotation in “${name(action.noteId)}”`
    case 'create_diagram': return `Create ${DIAGRAM_KIND_LABELS[detectMermaidKind(action.source)].toLowerCase()} in “${name(action.noteId)}”`
    case 'edit_diagram': return `Update diagram in “${name(action.noteId)}”`
    case 'generate_image': return `Generate image${action.section ? ` under “${action.section}”` : ''} in “${name(action.noteId)}”: ${truncate(action.prompt, 60)}`
    case 'create_recipe': return `Create recipe “${action.name}”`
    case 'update_recipe': return `Update recipe “${name(action.recipeId)}”`
    case 'delete_recipe': return `Delete recipe “${name(action.recipeId)}”`
  }
}

// ─── Two-phase content generation ─────────────────────────────────────────────

// The deferred-body description on a content-bearing action, or '' for other actions.
function actionSpec(action: PlanAction): string {
  switch (action.type) {
    case 'create_note':
    case 'create_child_note':
    case 'edit_note':
    case 'edit_section':
    case 'append_note':
      return action.spec ?? ''
    default:
      return ''
  }
}

// True when an action deferred its body — a content-bearing action with a non-empty `spec`
// and empty `content`. Such actions get their body written in a separate generation call.
export function actionNeedsGeneration(action: PlanAction): boolean {
  switch (action.type) {
    case 'create_note':
    case 'create_child_note':
    case 'edit_note':
    case 'edit_section':
    case 'append_note':
      return (action.spec ?? '').trim() !== '' && action.content.trim() === ''
    default:
      return false
  }
}

// Compact JSON of the plan with note bodies omitted — the assistant turn shown to the model
// during generation so it knows the whole plan and where the step it's writing fits.
export function buildPlanSummary(plan: Plan): string {
  const actions = plan.actions.map((a) => {
    const copy: Record<string, unknown> = { ...a }
    if (typeof copy.content === 'string' && copy.content) copy.content = '<written in a later step>'
    return copy
  })
  return JSON.stringify({ actions })
}

// The user turn for one generation call: write a single body, Markdown only. The per-type
// hint mirrors the inline-content rules in PLAN_INSTRUCTIONS so a deferred body behaves the
// same as an inline one when the executor applies it.
export function buildContentStepInstruction(action: PlanAction, index: number, labelMap: Map<string, string>): string {
  const spec = actionSpec(action)
  let hint = ''
  if (action.type === 'edit_section') {
    // action.section may already carry ATX markers (the model often copies "### Title"
    // verbatim); strip them so the example heading isn't doubled up ("## ### Title").
    const bare = action.section.replace(/^#{1,6}\s*/, '').trim()
    hint = `\n\nBegin with the section's heading line (e.g. "## ${bare}") and rewrite that whole section.`
  } else if (action.type === 'edit_note' && action.mode === 'replace') {
    hint = `\n\nThis is the FULL replacement body for the note.`
  }
  return `Write the Markdown body for step ${index + 1} — ${defaultActionLabel(action, labelMap)}.${
    spec ? `\n\nWhat the body must contain:\n${spec}` : ''
  }${hint}\n\nOutput ONLY the Markdown body for this one item — no JSON, no code fences, no preamble, no commentary.`
}
