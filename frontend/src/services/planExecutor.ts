// Executes a parsed Plan sequentially against the notes API. Each action runs in
// its own try/catch so a single failure is reported but never aborts the rest
// (partial-failure reporting). Forward references (a `ref` declared on a create_*
// action) are resolved through `refMap` as creations happen.

import { notesApi } from '@/api/notes'
import { foldersApi } from '@/api/folders'
import { annotationsApi } from '@/api/annotations'
import { imageGenApi } from '@/api/imageGen'
import { extractBlockTexts } from '@/utils/blocks'
import { newDiagramId, validateMermaidSource } from '@/utils/diagram'
import type { Plan, PlanAction } from './aiPlan'

// Minimal structural view of the BlockNote editor — we use it to convert the model's
// markdown into BlockNote blocks, and (for AI context) blocks back into markdown. The
// same instance powers the open editor.
export interface PlanEditor {
  // Method signatures (not arrow properties) so the real editor's more specifically
  // typed block params remain assignable to this structural view.
  tryParseMarkdownToBlocks(markdown: string): unknown[]
  blocksToMarkdownLossy(blocks?: unknown[]): string
}

export interface PlanExecContext {
  editor: PlanEditor
  currentNoteId: string | null
  defaultCategoryId: string
  currentFolderId: string | null
  validNoteIds: Set<string>
  validFolderIds: Set<string>
  validCategoryIds: Set<string>
  validAnnotationIds?: Set<string>
}

export interface ActionResult {
  ok: boolean
  message: string
  kind?: 'respond'
  notesChanged?: boolean
  touchedCurrentNote?: boolean
  annotationsChanged?: boolean  // true when this action touched the current note's annotations
  noteId?: string    // the note this action created/affected, for a result-summary link
  noteTitle?: string // display title for the pill link (omitted where title isn't fetched)
}

function errMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const ax = e as { response?: { data?: { detail?: unknown } } }
    const detail = ax.response?.data?.detail
    if (typeof detail === 'string') return detail
  }
  return e instanceof Error ? e.message : 'unknown error'
}

function parseBlocks(content: string): unknown[] {
  try {
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// Reduce a heading (from either the model's `section` field or a stored block) to a
// canonical form for matching. Heading blocks store only the plain text — the level
// lives in props, so "## Chapter 1" is stored as "Chapter 1" — but the model is given
// note bodies as Markdown and routinely copies a decorated form into `section`:
// "## Chapter 1", "**Chapter 1**", or "Chapter 1." with trailing punctuation. Normalise
// both sides so any of those forms matches the stored text:
//  - leading ATX "#" markers (and a trailing run, for closed ATX headings)
//  - Markdown emphasis markers (* and _) — so "**Fixes**" matches a plain "Fixes"
//    heading, and a plain section matches a bold pseudo-heading (see sectionHeading)
//  - typographic quotes folded to straight (the planner is told to prefer “ ” ‘ ’,
//    so a heading stored with a straight ' / " still matches the model's curly form)
//  - collapsed internal whitespace and a stripped trailing sentence punctuation mark
//    (?, :, ., …) — so "Which route is most likely?" matches "Which route is most likely"
function normalizeHeading(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_]+/g, '')
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+#+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,:;!?]+$/, '')
    .trim()
    .toLowerCase()
}

// A block's concatenated top-level inline text — used to match a section by its
// heading text.
function blockText(b: unknown): string {
  const content = (b as Record<string, unknown>)?.content
  return Array.isArray(content)
    ? content.map((c) => String((c as Record<string, unknown>)?.text ?? '')).join('')
    : ''
}

// Leading ATX heading level of a line ("### x" → 3), or 0 when it isn't one. A
// run of "#" with no following space+text (e.g. "#tag", "###") is not a heading.
function atxLevel(text: string): number {
  const m = /^(#{1,6})\s+\S/.exec(text.trim())
  return m ? m[1].length : 0
}

// A short, entirely-bold paragraph acts as a visual "heading" even though it is a
// plain paragraph, not a real heading block — a common pattern in pasted articles
// that use "**Section title**" lines instead of real headings. Return its text so
// edit_section can target it; null when the block isn't such a pseudo-heading. The
// length cap keeps a genuinely long bold sentence inside a section from being read
// as a heading (which would wrongly cut that section short).
const PSEUDO_HEADING_MAX_LEN = 100
function boldPseudoHeadingText(b: unknown): string | null {
  const rec = b as Record<string, unknown> | null
  if (!rec || rec.type !== 'paragraph' || !Array.isArray(rec.content) || rec.content.length === 0) return null
  let text = ''
  for (const c of rec.content) {
    const node = c as Record<string, unknown>
    // Any non-text run (link/mention) or any non-bold run means it isn't a bold line.
    if (node?.type !== 'text' || (node.styles as Record<string, unknown> | undefined)?.bold !== true) return null
    text += String(node.text ?? '')
  }
  const trimmed = text.trim()
  return trimmed && trimmed.length <= PSEUDO_HEADING_MAX_LEN ? trimmed : null
}

// The {level, text} of a block that acts as a section heading, or null if it
// isn't one. A section heading is normally a real `heading` block (its level lives
// in props), but a marker can also survive as a literal Markdown "### Title" line
// inside a non-heading block — e.g. Markdown pasted into a paragraph that was never
// parsed into a heading — or as a short, entirely-bold "**Title**" paragraph.
// Recognising all three forms means edit_section can target a literal "###" line or
// a bold pseudo-heading instead of silently appending a duplicate section. Bold
// pseudo-headings get a synthetic level BELOW every real heading (1–6) so a real
// heading always wins as a section boundary.
function sectionHeading(b: unknown): { level: number; text: string } | null {
  const text = blockText(b)
  if ((b as Record<string, unknown>)?.type === 'heading') {
    const level = Number(((b as Record<string, unknown>)?.props as Record<string, unknown> | undefined)?.level ?? 1)
    return { level, text }
  }
  const level = atxLevel(text)
  if (level) return { level, text }
  const bold = boldPseudoHeadingText(b)
  return bold ? { level: 7, text: bold } : null
}

// Index of the block acting as section `section` within top-level `blocks`, or -1.
// Prefers an exact (normalized) match, then a substring match — both sides run
// through normalizeHeading + sectionHeading so a Markdown ("## X"), bold ("**X**")
// or plain heading all match regardless of the decorated form the model emitted.
// Shared by edit_section, add_reference and generate_image so section targeting
// behaves identically everywhere.
function findSectionIndex(blocks: unknown[], section: string): number {
  const target = normalizeHeading(section)
  if (!target) return -1
  const match = (pred: (h: string) => boolean) =>
    blocks.findIndex((b) => {
      const info = sectionHeading(b)
      return info ? pred(normalizeHeading(info.text)) : false
    })
  const exact = match((h) => h === target)
  return exact === -1 ? match((h) => h.includes(target)) : exact
}

// Embed blocks (childNote / noteReference / diagram) can't be expressed in Markdown,
// so a section rewrite from model Markdown can't reproduce them — collect them so
// edit_section can re-insert them instead of silently dropping them.
function collectEmbeds(blocks: unknown[]): unknown[] {
  const out: unknown[] = []
  const walk = (b: unknown) => {
    const rec = b as Record<string, unknown> | null
    if (!rec || typeof rec !== 'object') return
    if (rec.type === 'childNote' || rec.type === 'noteReference' || rec.type === 'diagram') out.push(b)
    if (Array.isArray(rec.children)) rec.children.forEach(walk)
  }
  blocks.forEach(walk)
  return out
}

export async function executePlan(plan: Plan, ctx: PlanExecContext): Promise<ActionResult[]> {
  const refMap = new Map<string, string>() // ref label -> real created id (notes & folders)
  const results: ActionResult[] = []

  // Snapshot each affected note only once per plan run, capturing its pre-plan
  // state before the first mutation. Each mutating handler snapshots before it
  // writes, so the first touch of a note is its genuine pre-plan state. Without
  // this, every step re-snapshots; because each step changes the content the
  // backend's checksum dedup can't collapse them, so an N-step plan on one note
  // would leave N snapshots (the original plus N-1 mid-plan intermediates).
  const snapshotted = new Set<string>()
  const snapshotOnce = async (noteId: string) => {
    if (snapshotted.has(noteId)) return
    snapshotted.add(noteId)
    await notesApi.createVersion(noteId).catch(() => null)
  }

  const mdToBlocks = async (markdown: string): Promise<unknown[]> => {
    const blocks = await ctx.editor.tryParseMarkdownToBlocks(markdown ?? '')
    return blocks.length
      ? blocks
      : [{ type: 'paragraph', content: [{ type: 'text', text: markdown ?? '', styles: {} }] }]
  }

  // Resolve a note id field (raw in-context id or a forward ref). Returns the real
  // id or an error string if it's neither known nor created in this plan.
  const resolveNote = (idOrRef: string): { id: string } | { error: string } => {
    const mapped = refMap.get(idOrRef)
    if (mapped) return { id: mapped }
    if (ctx.validNoteIds.has(idOrRef)) return { id: idOrRef }
    // Explicit sentinel for the open note.
    if (/^(current|this|this_?note)$/i.test(idOrRef) && ctx.currentNoteId) return { id: ctx.currentNoteId }
    // Tolerant fallback: when exactly one note is in context, an unrecognised id
    // (e.g. a stale id the model copied from earlier in the conversation transcript)
    // can only sensibly mean that note — resolve to it rather than failing. Ambiguous
    // multi-note contexts still error so we never silently target the wrong note.
    if (ctx.validNoteIds.size === 1) {
      const only = ctx.validNoteIds.values().next().value
      if (only) return { id: only }
    }
    return { error: `Note "${idOrRef}" is not in context — skipped.` }
  }

  const resolveFolder = (idOrRef: string | null): { id: string | null } | { error: string } => {
    if (idOrRef === null) return { id: null }
    const mapped = refMap.get(idOrRef)
    if (mapped) return { id: mapped }
    if (ctx.validFolderIds.has(idOrRef)) return { id: idOrRef }
    return { error: `Folder "${idOrRef}" is not in context — skipped.` }
  }

  const touchesCurrent = (id: string) => id === ctx.currentNoteId

  async function runAction(action: PlanAction): Promise<ActionResult> {
    switch (action.type) {
      case 'respond':
        return { ok: true, message: action.text, kind: 'respond' }

      // find_notes is a retrieval step resolved by the AI panel before execution; it is
      // never sent here. Handled for exhaustiveness (and as a defensive no-op).
      case 'find_notes':
        return { ok: true, message: action.query ? `Searched notes for “${action.query}”.` : 'Searched notes.', kind: 'respond' }

      case 'create_note': {
        if (!ctx.defaultCategoryId) return { ok: false, message: 'Cannot create note: no category available.' }
        const blocks = await mdToBlocks(action.content)
        const res = await notesApi.create({
          title: action.title || 'Untitled',
          content: JSON.stringify(blocks),
          category_id: ctx.defaultCategoryId,
          folder_id: ctx.currentFolderId,
          tags: [],
        })
        if (action.ref) refMap.set(action.ref, res.data.id)
        return { ok: true, message: `Created note “${res.data.title}”.`, notesChanged: true, noteId: res.data.id, noteTitle: res.data.title }
      }

      case 'edit_note': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await snapshotOnce(r.id)
        const cur = await notesApi.get(r.id)
        const newBlocks = await mdToBlocks(action.content)
        const content =
          action.mode === 'amend'
            ? JSON.stringify([...parseBlocks(cur.data.content), ...newBlocks])
            : JSON.stringify(newBlocks)
        await notesApi.update(r.id, { content })
        return {
          ok: true,
          message: `${action.mode === 'amend' ? 'Amended' : 'Replaced'} note “${cur.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }

      case 'edit_section': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await snapshotOnce(r.id)
        const cur = await notesApi.get(r.id)
        const blocks = parseBlocks(cur.data.content)
        const newBlocks = await mdToBlocks(action.content)

        // Find the section heading. Matching is delegated to findSectionIndex, which
        // normalizes both the model's section value and each block's heading text so a
        // Markdown ("## X"), bold ("**X**"), literal "###" line or plain heading all
        // match — see normalizeHeading / sectionHeading.
        const startIdx = findSectionIndex(blocks, action.section)

        if (startIdx === -1) {
          // Section not found — append it as a new section rather than failing.
          blocks.push(...newBlocks)
          await notesApi.update(r.id, { content: JSON.stringify(blocks) })
          return {
            ok: true,
            message: `Section “${action.section}” not found in “${cur.data.title}” — added as a new section.`,
            notesChanged: true,
            touchedCurrentNote: touchesCurrent(r.id),
            noteId: r.id,
            noteTitle: cur.data.title,
          }
        }

        // The section runs until the next heading of the same-or-higher level (or EOF).
        const level = sectionHeading(blocks[startIdx])?.level ?? 1
        let endIdx = blocks.length
        for (let i = startIdx + 1; i < blocks.length; i++) {
          const info = sectionHeading(blocks[i])
          if (info && info.level <= level) { endIdx = i; break }
        }

        // Embedded child-notes/references can't be expressed in Markdown, so the
        // model's rewrite can't reproduce them — re-append any that were in the
        // section so a section edit never silently drops them.
        const preserved = collectEmbeds(blocks.slice(startIdx, endIdx))
        blocks.splice(startIdx, endIdx - startIdx, ...newBlocks, ...preserved)
        await notesApi.update(r.id, { content: JSON.stringify(blocks) })
        return {
          ok: true,
          message: `Updated section “${action.section}” in “${cur.data.title}”.${
            preserved.length ? ` Kept ${preserved.length} embedded reference${preserved.length === 1 ? '' : 's'}.` : ''
          }`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }

      case 'append_note': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await snapshotOnce(r.id)
        const cur = await notesApi.get(r.id)
        const added = await mdToBlocks(action.content)
        await notesApi.update(r.id, { content: JSON.stringify([...parseBlocks(cur.data.content), ...added]) })
        return {
          ok: true,
          message: `Appended to note “${cur.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }

      case 'rename_note': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await notesApi.update(r.id, { title: action.title })
        return {
          ok: true,
          message: `Renamed note to “${action.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: action.title,
        }
      }

      case 'create_child_note': {
        const r = resolveNote(action.parentId)
        if ('error' in r) return { ok: false, message: r.error }
        const blocks = await mdToBlocks(action.content)
        const child = await notesApi.createChild(r.id, {
          title: action.title || 'Untitled',
          content: JSON.stringify(blocks),
        })
        if (action.ref) refMap.set(action.ref, child.data.id)
        // Embed a childNote block in the parent so the child shows up in the UI
        // (mirrors EditorView.insertEmptyChild). The createChild endpoint only
        // sets parent_note_id; it does not touch the parent's content.
        await snapshotOnce(r.id)
        const parent = await notesApi.get(r.id)
        const parentBlocks = parseBlocks(parent.data.content)
        parentBlocks.push({ type: 'childNote', props: { childNoteId: child.data.id, title: child.data.title } })
        await notesApi.update(r.id, { content: JSON.stringify(parentBlocks) })
        return {
          ok: true,
          message: `Created child note “${child.data.title}” under “${parent.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: child.data.id,
          noteTitle: child.data.title,
        }
      }

      case 'move_note': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        const f = resolveFolder(action.folderId)
        if ('error' in f) return { ok: false, message: f.error }
        await notesApi.move(r.id, f.id)
        return {
          ok: true,
          message: `Moved note to ${f.id ? 'folder' : 'the root'}.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
        }
      }

      case 'set_tags': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        let tags = action.tags
        if (action.mode === 'add') {
          const cur = await notesApi.get(r.id)
          tags = Array.from(new Set([...cur.data.tags, ...action.tags]))
        }
        await notesApi.update(r.id, { tags })
        return {
          ok: true,
          message: `Updated tags: ${tags.join(', ') || '(none)'}.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
        }
      }

      case 'set_category': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        if (!ctx.validCategoryIds.has(action.categoryId)) {
          return { ok: false, message: `Category "${action.categoryId}" is not available — skipped.` }
        }
        await notesApi.update(r.id, { category_id: action.categoryId })
        return {
          ok: true,
          message: 'Changed category.',
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
        }
      }

      case 'create_folder': {
        const parent = resolveFolder(action.parentFolderId ?? null)
        if ('error' in parent) return { ok: false, message: parent.error }
        const res = await foldersApi.create({ name: action.name || 'New Folder', parent_folder_id: parent.id })
        if (action.ref) refMap.set(action.ref, res.data.id)
        return { ok: true, message: `Created folder “${res.data.name}”.`, notesChanged: true }
      }

      case 'add_reference': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        if (!ctx.validNoteIds.has(action.referenceNoteId)) {
          return { ok: false, message: `Note reference “${action.referenceTitle}” is not in context — skipped.` }
        }
        await snapshotOnce(r.id)
        const cur = await notesApi.get(r.id)
        const blocks = parseBlocks(cur.data.content)

        // Create the reference block
        const referenceBlock = {
          type: 'noteReference',
          props: { noteId: action.referenceNoteId, noteTitle: action.referenceTitle },
        } as unknown

        // Find insertion point: after the target section heading if specified, else at
        // the end. findSectionIndex matches Markdown/bold/literal/plain headings alike.
        const afterIdx = action.insertAfterSection ? findSectionIndex(blocks, action.insertAfterSection) : -1
        const insertIndex = afterIdx === -1 ? blocks.length : afterIdx + 1

        blocks.splice(insertIndex, 0, referenceBlock)
        await notesApi.update(r.id, { content: JSON.stringify(blocks) })

        const sectionMsg = action.insertAfterSection ? ` under “${action.insertAfterSection}”` : ''
        return {
          ok: true,
          message: `Added reference to “${action.referenceTitle}”${sectionMsg}.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }

      case 'add_annotation': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        // Anchor the annotation to a block by matching the model's snippet against
        // each block's text (block ids are stable across saves; the model only sees
        // markdown, so it targets by snippet rather than id).
        const cur = await notesApi.get(r.id)
        const needle = action.anchorText.trim().toLowerCase()
        const blockTexts = extractBlockTexts(parseBlocks(cur.data.content))
        const match =
          blockTexts.find((b) => b.text.toLowerCase() === needle) ??
          blockTexts.find((b) => b.text.toLowerCase().includes(needle))
        if (!match) {
          return { ok: false, message: `Could not find a block matching “${action.anchorText}” in “${cur.data.title}” — annotation skipped.` }
        }
        await annotationsApi.create(r.id, { block_id: match.id, text: action.text })
        return {
          ok: true,
          message: `Added annotation to “${cur.data.title}”.`,
          annotationsChanged: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }

      case 'edit_annotation': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await annotationsApi.update(r.id, action.annotationId, { text: action.text })
        return {
          ok: true,
          message: 'Edited annotation.',
          annotationsChanged: touchesCurrent(r.id),
          noteId: r.id,
        }
      }

      case 'delete_annotation': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await annotationsApi.delete(r.id, action.annotationId)
        return {
          ok: true,
          message: 'Deleted annotation.',
          annotationsChanged: touchesCurrent(r.id),
          noteId: r.id,
        }
      }

      case 'create_diagram': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        const validated = await validateMermaidSource(action.source)
        if (!validated.ok) return { ok: false, message: `Diagram not created: ${validated.error}` }
        await snapshotOnce(r.id)
        const cur = await notesApi.get(r.id)
        const blocks = parseBlocks(cur.data.content)
        blocks.push({ type: 'diagram', props: { diagramId: newDiagramId(), source: action.source } })
        await notesApi.update(r.id, { content: JSON.stringify(blocks) })
        return {
          ok: true,
          message: `Added diagram to “${cur.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }

      case 'edit_diagram': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        const validated = await validateMermaidSource(action.source)
        if (!validated.ok) return { ok: false, message: `Diagram not updated: ${validated.error}` }
        const cur = await notesApi.get(r.id)
        const blocks = parseBlocks(cur.data.content)
        let found = false
        const walk = (list: unknown[]): unknown[] =>
          list.map((b) => {
            const rec = b as Record<string, unknown>
            if (rec && rec.type === 'diagram') {
              const props = (rec.props as Record<string, unknown>) || {}
              if (props.diagramId === action.diagramId) {
                found = true
                return { ...rec, props: { ...props, source: action.source } }
              }
            }
            if (Array.isArray(rec?.children)) return { ...rec, children: walk(rec.children as unknown[]) }
            return b
          })
        const newBlocks = walk(blocks)
        if (!found) {
          return { ok: false, message: `Diagram “${action.diagramId}” not found in “${cur.data.title}” — skipped.` }
        }
        await snapshotOnce(r.id)
        await notesApi.update(r.id, { content: JSON.stringify(newBlocks) })
        return {
          ok: true,
          message: `Updated diagram in “${cur.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }

      case 'generate_image': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }

        // Generate + persist the image first (a paid, fallible call). Report a clean
        // message on failure without mutating the note; the outer loop keeps going.
        let generated
        try {
          generated = await imageGenApi.generate({ prompt: action.prompt })
        } catch (e) {
          const ax = e as { response?: { data?: { detail?: { message?: string } | string } } }
          const detail = ax.response?.data?.detail
          const msg =
            detail && typeof detail === 'object' ? detail.message ?? errMsg(e)
            : typeof detail === 'string' ? detail
            : errMsg(e)
          return { ok: false, message: `Image not generated: ${msg}` }
        }

        await snapshotOnce(r.id)
        const cur = await notesApi.get(r.id)
        const blocks = parseBlocks(cur.data.content)
        const imageBlock = { type: 'image', props: { url: generated.url, caption: action.alt ?? '' } } as unknown

        // Place the image directly under the target heading (findSectionIndex matches
        // Markdown/bold/literal/plain headings alike — mirrors edit_section), or append
        // at the end when no section is given / the heading isn't found.
        const sectionIdx = action.section ? findSectionIndex(blocks, action.section) : -1
        const placed = sectionIdx !== -1
        const insertIndex = placed ? sectionIdx + 1 : blocks.length

        blocks.splice(insertIndex, 0, imageBlock)
        await notesApi.update(r.id, { content: JSON.stringify(blocks) })
        const where = action.section
          ? placed ? ` under “${action.section}”` : ` (section “${action.section}” not found — added at the end)`
          : ''
        return {
          ok: true,
          message: `Generated image${where} in “${cur.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
          noteId: r.id,
          noteTitle: cur.data.title,
        }
      }
    }
  }

  for (const action of plan.actions) {
    try {
      results.push(await runAction(action))
    } catch (e) {
      results.push({ ok: false, message: `Action "${action.type}" failed: ${errMsg(e)}` })
    }
  }
  return results
}
