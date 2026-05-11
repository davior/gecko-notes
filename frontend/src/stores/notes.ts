import { defineStore } from 'pinia'
import { ref } from 'vue'
import { notesApi, type Note, type NoteListItem, type ListNotesParams } from '@/api/notes'

export const useNotesStore = defineStore('notes', () => {
  const notes = ref<NoteListItem[]>([])
  const currentNote = ref<Note | null>(null)
  const total = ref(0)
  const loading = ref(false)
  const hasMore = ref(true)

  const LIMIT = 50

  async function loadNotes(params: ListNotesParams = {}, reset = true) {
    if (loading.value) return
    loading.value = true
    try {
      const response = await notesApi.list({
        limit: LIMIT,
        offset: reset ? 0 : notes.value.length,
        ...params,
      })
      if (reset) {
        notes.value = response.data
      } else {
        notes.value.push(...response.data)
      }
      total.value = response.total
      hasMore.value = notes.value.length < response.total
    } finally {
      loading.value = false
    }
  }

  async function loadMore(params: ListNotesParams = {}) {
    if (!hasMore.value || loading.value) return
    await loadNotes(params, false)
  }

  async function loadNote(id: string) {
    const response = await notesApi.get(id)
    currentNote.value = response.data
    return response.data
  }

  async function createNote(payload: { title: string; content?: string; category_id: string; tags?: string[] }) {
    const response = await notesApi.create(payload)
    currentNote.value = response.data
    return response.data
  }

  async function updateNote(id: string, payload: { title?: string; content?: string; category_id?: string; tags?: string[] }) {
    const response = await notesApi.update(id, payload)
    currentNote.value = response.data
    // Update in list if present
    const idx = notes.value.findIndex((n) => n.id === id)
    if (idx !== -1) {
      notes.value[idx] = {
        ...notes.value[idx],
        title: response.data.title,
        category_id: response.data.category_id,
        tags: response.data.tags,
        modified_at: response.data.modified_at,
      }
    }
    return response.data
  }

  async function deleteNote(id: string) {
    await notesApi.delete(id)
    notes.value = notes.value.filter((n) => n.id !== id)
    if (currentNote.value?.id === id) {
      currentNote.value = null
    }
  }

  function clearCurrentNote() {
    currentNote.value = null
  }

  return {
    notes,
    currentNote,
    total,
    loading,
    hasMore,
    loadNotes,
    loadMore,
    loadNote,
    createNote,
    updateNote,
    deleteNote,
    clearCurrentNote,
  }
})
