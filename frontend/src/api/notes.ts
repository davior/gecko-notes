import client from './client'

export interface NoteListItem {
  id: string
  title: string
  content_preview: string
  first_image_url: string | null
  category_id: string
  folder_id: string | null
  parent_note_id: string | null
  tags: string[]
  is_pinned: boolean
  is_shared: boolean
  share_token?: string | null
  created_at: string
  modified_at: string
}

export interface Note {
  id: string
  title: string
  content: string
  category_id: string
  folder_id: string | null
  parent_note_id: string | null
  tags: string[]
  is_pinned: boolean
  is_shared: boolean
  share_token?: string | null
  summary?: string | null
  conversation?: string | null
  created_at: string
  modified_at: string
}

export interface NoteCreate {
  title: string
  content?: string
  category_id: string
  folder_id?: string | null
  tags?: string[]
}

export interface NoteUpdate {
  title?: string
  content?: string
  category_id?: string
  folder_id?: string | null
  parent_note_id?: string | null
  tags?: string[]
  is_pinned?: boolean
  summary?: string | null
  conversation?: string | null
}

export interface NoteVersion {
  id: string
  note_id: string
  title: string
  content: string
  tags: string[]
  category_id: string
  created_at: string
}

export interface NoteVersionListItem {
  id: string
  title: string
  content_preview: string
  created_at: string
}

export type RestoreMode = 'in_place' | 'new_note'

export interface ListNotesParams {
  sort?: 'modified_at' | 'created_at'
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
  category_id?: string
  folder_id?: string
  in_folder?: boolean
  search?: string
  recursive?: boolean
  include_children?: boolean
}

export interface ListResponse<T> {
  data: T[]
  total: number
  limit: number
  offset: number
}

// A recurring month/day window matched in any year (e.g. "first week of January").
export interface AnnualRange {
  start_month: number
  start_day: number
  end_month: number
  end_day: number
}

// The structured filter the AI generates from a natural-language / advanced-syntax
// search query. Matches `backend/app/schemas.py`'s NoteSearchFilter — the model never
// emits SQL, only this validated shape, which POST /notes/search executes.
export interface NoteSearchFilter {
  text_all?: string[]
  text_any?: string[]
  tags?: string[]
  category_ids?: string[]
  date_field?: 'created_at' | 'modified_at'
  date_from?: string   // 'YYYY-MM-DD'
  date_to?: string     // 'YYYY-MM-DD'
  annual_ranges?: AnnualRange[]
  is_pinned?: boolean
  limit?: number
  offset?: number
}

export const notesApi = {
  list(params: ListNotesParams = {}): Promise<ListResponse<NoteListItem>> {
    return client.get('/notes', { params }).then((r) => r.data)
  },

  // Executes an AI-generated structured filter across all of the user's notes
  // (no folder scoping) — the "deep search" path triggered by Enter in the list view.
  smartSearch(filter: NoteSearchFilter): Promise<ListResponse<NoteListItem>> {
    return client.post('/notes/search', filter).then((r) => r.data)
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

  pin(id: string): Promise<{ data: Note }> {
    return client.patch(`/notes/${id}/pin`).then((r) => r.data)
  },

  move(id: string, folderId: string | null): Promise<{ data: Note }> {
    return client.patch(`/notes/${id}/move`, { folder_id: folderId }).then((r) => r.data)
  },

  // Child notes
  listChildren(parentId: string): Promise<ListResponse<NoteListItem>> {
    return client.get(`/notes/${parentId}/children`).then((r) => r.data)
  },

  createChild(parentId: string, payload: { title?: string; content?: string }): Promise<{ data: Note }> {
    return client.post(`/notes/${parentId}/children`, payload).then((r) => r.data)
  },

  orphanChild(childId: string): Promise<{ data: Note }> {
    return client.put(`/notes/${childId}`, { parent_note_id: null }).then((r) => r.data)
  },

  delete(id: string): Promise<void> {
    return client.delete(`/notes/${id}`).then(() => undefined)
  },

  share(id: string): Promise<{ data: Note }> {
    return client.post(`/notes/${id}/share`).then((r) => r.data)
  },

  unshare(id: string): Promise<{ data: Note }> {
    return client.delete(`/notes/${id}/share`).then((r) => r.data)
  },

  // Version history
  createVersion(id: string): Promise<{ data: NoteVersion } | null> {
    return client.post(`/notes/${id}/versions`).then((r) => (r.status === 204 ? null : r.data))
  },

  listVersions(id: string): Promise<ListResponse<NoteVersionListItem>> {
    return client.get(`/notes/${id}/versions`).then((r) => r.data)
  },

  getVersion(id: string, versionId: string): Promise<{ data: NoteVersion }> {
    return client.get(`/notes/${id}/versions/${versionId}`).then((r) => r.data)
  },

  restoreVersion(id: string, versionId: string, mode: RestoreMode): Promise<{ data: Note }> {
    return client.post(`/notes/${id}/versions/${versionId}/restore`, { mode }).then((r) => r.data)
  },
}

export interface AppConfig {
  note_version_interval_minutes: number
  note_version_max_count: number
}

export const configApi = {
  get(): Promise<AppConfig> {
    return client.get('/config').then((r) => r.data)
  },
}
