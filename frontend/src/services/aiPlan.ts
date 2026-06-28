// Turns a natural-language request into a structured PLAN of sequential actions
// the notes app can execute. The model returns a single JSON object; we parse it
// here (reusing the fence-stripping approach from parseTagsFromAI in ai.ts) and
// degrade gracefully to a plain "respond" action when the output isn't valid JSON.

export interface ContextNote { id: string; title: string }
export interface ContextFolder { id: string; name: string }
export interface ContextCategory { id: string; label: string }

// All note `content` is MARKDOWN — converted to BlockNote blocks by the executor
// via the live editor's tryParseMarkdownToBlocks(). The model never emits BlockNote JSON.
// `spec` (optional, content-bearing actions) defers the body: the planner describes what the
// body should contain and leaves `content` empty; the body is written in a later per-step call.
export type PlanAction =
  | { type: 'respond'; text: string; description?: string }
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
}

// Static, never-changing instruction block. Kept separate (and a module constant) so
// it can be marked as a stable Anthropic prompt-cache prefix on every request: it is
// byte-identical across every turn, note, and session, so it should always be a cache
// hit. Everything that varies (note lists, note bodies, the conversation) lives after
// the cache breakpoint, in buildPlanReferenceBlock and the message array.
export const PLAN_INSTRUCTIONS = `You are an AI assistant and research helper for a note-taking app. You help the user in two ways: (1) by ANSWERING questions and discussing their notes in conversation, and (2) ONLY when the user explicitly asks for it, by making changes to their notes (creating, editing, organising, tagging, annotating, etc.). You turn the user's request into a PLAN of sequential actions executed against their notes. You have access to a web_search tool — use it whenever you need current information, facts, or research to fulfill the request. After completing any searches, you MUST output a single JSON object as your final response and NOTHING else.

Output format (JSON only — no prose, no markdown code fences):
{ "actions": [ <action>, ... ] }

Action types (every action MAY also include an optional "description": one short plain sentence summarising it for a confirmation preview):
- respond:           { "type":"respond", "text":"<markdown>" }
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

Rules:
- ANSWER BY DEFAULT — do NOT modify notes unless explicitly asked. If the user asks a question, asks you to explain, research, or summarise something in the chat, or otherwise just wants information, return ONLY a single "respond" action containing your answer. NEVER create, edit, append, rename, move, tag, annotate, or otherwise change a note unless the user EXPLICITLY tells you to change their notes (e.g. "create a note…", "add this to the note", "rename…", "tag…", "organise…"). When a request is ambiguous, or could be satisfied with a conversational answer, prefer a "respond" action over modifying notes.
- All note "content" is MARKDOWN. Never output BlockNote or raw JSON as a note body. The note bodies given to you — both in the "Context (note bodies)" section and in the latest "Current note — live" message — are Markdown; preserve their existing formatting (headings, bold, lists, links) when editing.
- Deferred body generation (IMPORTANT for long or multiple bodies): For create_note, create_child_note, edit_note, edit_section and append_note you may EITHER write the body inline in "content", OR set "spec" to a precise description of what the body must contain and leave "content" empty (""). When a body would be long, or you are creating/rewriting MULTIPLE notes, PREFER "spec" and leave "content" empty — each spec'd body is written in a separate follow-up step that sees this same plan and context, which avoids truncation. Use inline "content" only for short, simple bodies. Never set both for the same action.
- "noteId", "parentId", "folderId" and "categoryId" MUST be an id taken from the lists below, OR a "ref" label you assigned to an entity created earlier in THIS plan. NEVER invent an id.
- For the note the user currently has open ("this note", "this article", …), use its id from the list below, or the literal "current". Its live, up-to-date content is provided in the most recent user message (labelled "Current note — live"); other in-context notes appear in the "Context (note bodies)" section. Ids that appear only earlier in the conversation may be stale — do not reuse an id unless it is listed below.
- Note references: "referenceNoteId" and "referenceTitle" for add_reference actions must come from the notes listed below. If a note to reference is not in context, return a respond action explaining which note to add to the context.
- Forward references: a create_note / create_child_note / create_folder action may set "ref" to a short label (e.g. "f1"); a later action may use that label anywhere an id is expected (e.g. move a note into "folderId":"f1"). This lets you, for example, create a folder and then move notes into it within one plan.
- Choosing how to edit (IMPORTANT — preserve formatting and embedded blocks):
  - To ADD content, use append_note or edit_note "amend". These keep ALL existing content, including embedded child notes, note references, links and images.
  - To CHANGE an existing section, use edit_section: set "section" to that section's heading text and "content" to the new Markdown for the whole section (include the heading). Only that section is rewritten; every other section is preserved untouched.
  - Use edit_note "replace" ONLY when the user explicitly asks to rewrite the ENTIRE note. It discards all other sections, formatting and embedded blocks, so avoid it for section-level changes.
- Annotations: a note's existing annotations are listed under it as "Annotations on this note" with an "[annotation <id>]" and the snippet of the block they are anchored to. To edit/delete one, use its "<id>" as "annotationId". To add one, set "anchorText" to a short verbatim snippet of the block the annotation should attach to (it is matched against the note's block text). When asked to "read the annotations and revise the note", read these annotation texts and apply the implied edits with edit_section / edit_note / append_note actions.
- If the request targets a note that is not listed below, or you otherwise lack the context to fulfil it, return ONLY a single respond action that explains what the user needs to add to the context. Do not guess or fabricate.
- Output ONLY the JSON object. No explanations and no code fences around it.`

// Dynamic context block: the id/title/folder/category lists plus the bodies of the
// *other* in-context notes. Stable within a conversation (it changes only when notes
// are added/renamed or the scope changes), so it sits behind its own cache breakpoint —
// after PLAN_INSTRUCTIONS, before the volatile current-note body and the new request.
export function buildPlanReferenceBlock({ referenceContextText, targetNotes, folders, categories }: BuildReferenceOpts): string {
  const noteList = targetNotes.length
    ? targetNotes.map((n) => `- ${n.id} — ${n.title || 'Untitled'}`).join('\n')
    : '(none)'
  const folderList = folders.length
    ? folders.map((f) => `- ${f.id} — ${f.name}`).join('\n')
    : '(none)'
  const categoryList = categories.length
    ? categories.map((c) => `- ${c.id} — ${c.label}`).join('\n')
    : '(none)'

  return `Notes in context (id — title):
${noteList}

Folders (id — name):
${folderList}

Categories (id — label):
${categoryList}

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
    default:
      return null
  }
}

export function parsePlan(raw: string): Plan {
  const fallback = (): Plan => ({ actions: [{ type: 'respond', text: (raw ?? '').trim() || '(no response)' }] })
  if (!raw || !raw.trim()) return { actions: [{ type: 'respond', text: '(no response)' }] }

  try {
    // Strip a leading ```json / ``` fence and a trailing fence, then isolate the
    // JSON object so any preamble or the "response cut off" suffix is ignored.
    let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const first = s.indexOf('{')
    const last = s.lastIndexOf('}')
    if (first === -1 || last === -1 || last < first) return fallback()
    s = s.slice(first, last + 1)

    const parsed = JSON.parse(s) as unknown
    // The model sometimes returns a bare action object (e.g. {"type":"respond",...})
    // instead of the {"actions":[...]} envelope — wrap it so it's validated and
    // rendered as a normal reply rather than shown as raw JSON.
    const isBareAction = parsed !== null && typeof parsed === 'object' && 'type' in parsed
    const actionsRaw = isBareAction ? [parsed] : (parsed as { actions?: unknown }).actions
    if (!Array.isArray(actionsRaw)) return fallback()

    const actions: PlanAction[] = []
    for (const a of actionsRaw.slice(0, MAX_PLAN_ACTIONS)) {
      const valid = validateAction(a)
      if (valid) actions.push(valid)
    }
    if (actions.length === 0) return fallback()
    if (actionsRaw.length > MAX_PLAN_ACTIONS) {
      actions.push({ type: 'respond', text: `_(Plan truncated to the first ${MAX_PLAN_ACTIONS} actions.)_` })
    }
    return { actions }
  } catch {
    return fallback()
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
    hint = `\n\nBegin with the section's heading line (e.g. "## ${action.section}") and rewrite that whole section.`
  } else if (action.type === 'edit_note' && action.mode === 'replace') {
    hint = `\n\nThis is the FULL replacement body for the note.`
  }
  return `Write the Markdown body for step ${index + 1} — ${defaultActionLabel(action, labelMap)}.${
    spec ? `\n\nWhat the body must contain:\n${spec}` : ''
  }${hint}\n\nOutput ONLY the Markdown body for this one item — no JSON, no code fences, no preamble, no commentary.`
}
