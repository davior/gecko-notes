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
  createNote: (payload: { title: string; content?: string; category_id: string; tags?: string[] }) => Promise<Note>
  updateNote: (id: string, payload: { title?: string; content?: string; category_id?: string; tags?: string[] }) => Promise<Note>
  deleteNote: (id: string) => Promise<void>
  clearCurrentNote: () => void
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
          category_id: response.data.category_id,
          tags: response.data.tags,
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
}))
