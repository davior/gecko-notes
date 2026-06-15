// Executes a parsed Plan sequentially against the notes API. Each action runs in
// its own try/catch so a single failure is reported but never aborts the rest
// (partial-failure reporting). Forward references (a `ref` declared on a create_*
// action) are resolved through `refMap` as creations happen.

import { notesApi } from '@/api/notes'
import { foldersApi } from '@/api/folders'
import type { Plan, PlanAction } from './aiPlan'

// Minimal structural view of the BlockNote editor — we only use it to convert the
// model's markdown into BlockNote blocks. The same instance powers the open editor.
export interface PlanEditor {
  tryParseMarkdownToBlocks: (markdown: string) => Promise<unknown[]>
}

export interface PlanExecContext {
  editor: PlanEditor
  currentNoteId: string | null
  defaultCategoryId: string
  currentFolderId: string | null
  validNoteIds: Set<string>
  validFolderIds: Set<string>
  validCategoryIds: Set<string>
}

export interface ActionResult {
  ok: boolean
  message: string
  kind?: 'respond'
  notesChanged?: boolean
  touchedCurrentNote?: boolean
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

export async function executePlan(plan: Plan, ctx: PlanExecContext): Promise<ActionResult[]> {
  const refMap = new Map<string, string>() // ref label -> real created id (notes & folders)
  const results: ActionResult[] = []

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
        return { ok: true, message: `Created note “${res.data.title}”.`, notesChanged: true }
      }

      case 'edit_note': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await notesApi.createVersion(r.id).catch(() => null) // snapshot for undo (dedup-safe)
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
        }
      }

      case 'append_note': {
        const r = resolveNote(action.noteId)
        if ('error' in r) return { ok: false, message: r.error }
        await notesApi.createVersion(r.id).catch(() => null)
        const cur = await notesApi.get(r.id)
        const added = await mdToBlocks(action.content)
        await notesApi.update(r.id, { content: JSON.stringify([...parseBlocks(cur.data.content), ...added]) })
        return {
          ok: true,
          message: `Appended to note “${cur.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
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
        await notesApi.createVersion(r.id).catch(() => null)
        const parent = await notesApi.get(r.id)
        const parentBlocks = parseBlocks(parent.data.content)
        parentBlocks.push({ type: 'childNote', props: { childNoteId: child.data.id, title: child.data.title } })
        await notesApi.update(r.id, { content: JSON.stringify(parentBlocks) })
        return {
          ok: true,
          message: `Created child note “${child.data.title}” under “${parent.data.title}”.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
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
        await notesApi.createVersion(r.id).catch(() => null)
        const cur = await notesApi.get(r.id)
        const blocks = parseBlocks(cur.data.content)

        // Create the reference block
        const referenceBlock = {
          type: 'noteReference',
          props: { noteId: action.referenceNoteId, noteTitle: action.referenceTitle },
        } as unknown

        // Find insertion point: after section heading if specified, else at end
        let insertIndex = blocks.length
        if (action.insertAfterSection) {
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i] as Record<string, unknown>
            // Check if this is a heading block matching the section name
            if (block.type === 'heading' && block.content) {
              const content = block.content as Array<Record<string, unknown>>
              const textContent = content.map((c) => c.text ?? '').join('')
              if (textContent.toLowerCase().includes(action.insertAfterSection.toLowerCase())) {
                insertIndex = i + 1
                break
              }
            }
          }
        }

        blocks.splice(insertIndex, 0, referenceBlock)
        await notesApi.update(r.id, { content: JSON.stringify(blocks) })

        const sectionMsg = action.insertAfterSection ? ` under “${action.insertAfterSection}”` : ''
        return {
          ok: true,
          message: `Added reference to “${action.referenceTitle}”${sectionMsg}.`,
          notesChanged: true,
          touchedCurrentNote: touchesCurrent(r.id),
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
