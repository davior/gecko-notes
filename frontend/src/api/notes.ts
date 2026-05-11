import client from './client'

export interface NoteListItem {
  id: string
  title: string
  content_preview: string
  category_id: string
  tags: string[]
  created_at: string
  modified_at: string
}

export interface Note {
  id: string
  title: string
  content: string
  category_id: string
  tags: string[]
  created_at: string
  modified_at: string
}

export interface NoteCreate {
  title: string
  content?: string
  category_id: string
  tags?: string[]
}

export interface NoteUpdate {
  title?: string
  content?: string
  category_id?: string
  tags?: string[]
}

export interface ListNotesParams {
  sort?: 'modified_at' | 'created_at'
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
  category_id?: string
  search?: string
}

export interface ListResponse<T> {
  data: T[]
  total: number
  limit: number
  offset: number
}

export const notesApi = {
  list(params: ListNotesParams = {}): Promise<ListResponse<NoteListItem>> {
    return client.get('/notes', { params }).then((r) => r.data)
  },

  get(id: string): Promise<{ data: Note }> {
    return client.get(`/notes/${id}`).then((r) => r.data)
  },

  create(payload: NoteCreate): Promise<{ data: Note }> {
    return client.post('/notes', payload).then((r) => r.data)
  },

  update(id: string, payload: NoteUpdate): Promise<{ data: Note }> {
    return client.put(`/notes/${id}`, payload).then((r) => r.data)
  },

  delete(id: string): Promise<void> {
    return client.delete(`/notes/${id}`).then(() => undefined)
  },
}
