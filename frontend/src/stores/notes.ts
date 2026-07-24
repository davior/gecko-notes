import { create } from 'zustand'
import { notesApi, type Note, type NoteListItem, type ListNotesParams } from '@/api/notes'

const LIMIT = 50

function extractContentPreview(content: string, maxChars = 120): string {
  try {
    const blocks = JSON.parse(content) as Array<Record<string, unknown>>
    const texts: string[] = []
    const visitBlock = (block: Record<string, unknown>) => {
      const blockContent = block.content
      if (Array.isArray(blockContent)) {
        for (const item of blockContent) {
          if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
            texts.push(String((item as Record<string, unknown>).text ?? ''))
          }
        }
      }
      if (Array.isArray(block.children)) {
        for (const child of block.children) visitBlock(child as Record<string, unknown>)
      }
    }
    for (const block of blocks) visitBlock(block)
    return texts.join(' ').trim().slice(0, maxChars)
  } catch {
    return content.slice(0, maxChars)
  }
}

interface NotesState {
  notes: NoteListItem[]
  currentNote: Note | null
  total: number
  loading: boolean
  hasMore: boolean
  loadNotes: (params?: ListNotesParams, reset?: boolean) => Promise<void>
  loadMore: (params?: ListNotesParams) => Promise<void>
  loadNote: (id: string) => Promise<Note>
  createNote: (payload: { title: string; content?: string; category_id: string; folder_id?: string | null; tags?: string[] }) => Promise<Note>
  updateNote: (id: string, payload: { title?: string; content?: string; category_id?: string; folder_id?: string | null; tags?: string[]; summary?: string | null }) => Promise<Note>
  pinNote: (id: string) => Promise<Note>
  shareNote: (id: string) => Promise<Note>
  unshareNote: (id: string) => Promise<Note>
  archiveNote: (id: string) => Promise<void>
  deleteNote: (id: string) => Promise<void>
  clearCurrentNote: () => void
  reset: () => void
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  currentNote: null,
  total: 0,
  loading: false,
  hasMore: true,

  async loadNotes(params = {}, reset = true) {
    if (get().loading) return
    set({ loading: true })
    try {
      const response = await notesApi.list({
        limit: LIMIT,
        offset: reset ? 0 : get().notes.length,
        ...params,
      })
      set((s) => ({
        notes: reset ? response.data : [...s.notes, ...response.data],
        total: response.total,
        hasMore: (reset ? response.data.length : s.notes.length + response.data.length) < response.total,
      }))
    } finally {
      set({ loading: false })
    }
  },

  async loadMore(params = {}) {
    const { hasMore, loading } = get()
    if (!hasMore || loading) return
    await get().loadNotes(params, false)
  },

  async loadNote(id) {
    const response = await notesApi.get(id)
    set({ currentNote: response.data })
    return response.data
  },

  async createNote(payload) {
    const response = await notesApi.create(payload)
    set((s) => ({
      currentNote: response.data,
      notes: [
        {
          id: response.data.id,
          title: response.data.title,
          content_preview: extractContentPreview(response.data.content),
          first_image_url: null,
          thumbnail_url: null,
          category_id: response.data.category_id,
          folder_id: response.data.folder_id,
          parent_note_id: response.data.parent_note_id,
          tags: response.data.tags,
          is_pinned: response.data.is_pinned,
          is_shared: response.data.is_shared,
          created_at: response.data.created_at,
          modified_at: response.data.modified_at,
        },
        ...s.notes.filter((note) => note.id !== response.data.id),
      ],
      total: s.total + (s.notes.some((note) => note.id === response.data.id) ? 0 : 1),
    }))
    return response.data
  },

  async updateNote(id, payload) {
    const response = await notesApi.update(id, payload)
    set((s) => ({
      currentNote: response.data,
      notes: s.notes.map((n) =>
        n.id === id
          ? { ...n, title: response.data.title, category_id: response.data.category_id, tags: response.data.tags, modified_at: response.data.modified_at }
          : n,
      ),
    }))
    return response.data
  },

  async pinNote(id) {
    const response = await notesApi.pin(id)
    set((s) => ({
      currentNote: s.currentNote?.id === id ? response.data : s.currentNote,
      notes: s.notes
        .map((n) => n.id === id ? { ...n, is_pinned: response.data.is_pinned } : n)
        .sort((a, b) => {
          if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
          return new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
        }),
    }))
    return response.data
  },

  async shareNote(id) {
    const response = await notesApi.share(id)
    set((s) => ({
      currentNote: s.currentNote?.id === id ? response.data : s.currentNote,
      notes: s.notes.map((n) => n.id === id ? { ...n, is_shared: true } : n),
    }))
    return response.data
  },

  async unshareNote(id) {
    const response = await notesApi.unshare(id)
    set((s) => ({
      currentNote: s.currentNote?.id === id ? response.data : s.currentNote,
      notes: s.notes.map((n) => n.id === id ? { ...n, is_shared: false } : n),
    }))
    return response.data
  },

  // Soft delete: move the note into the Archive Bin. Drops it from the current
  // list just like a delete; the caller refreshes the folder tree so a freshly
  // created Bin appears.
  async archiveNote(id) {
    await notesApi.archive(id)
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      currentNote: s.currentNote?.id === id ? null : s.currentNote,
    }))
  },

  async deleteNote(id) {
    await notesApi.delete(id)
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      currentNote: s.currentNote?.id === id ? null : s.currentNote,
    }))
  },

  clearCurrentNote() {
    set({ currentNote: null })
  },

  reset() {
    set({ notes: [], currentNote: null, total: 0, loading: false, hasMore: true })
  },
}))
