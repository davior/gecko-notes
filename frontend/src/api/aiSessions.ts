import client from './client'

export interface AISession {
  id: string
  // null = a "global" session (list-view AI Assistant), not tied to a note.
  note_id: string | null
  name: string
  messages: string
  context_scope: string
  use_summaries: boolean
  include_linked_files: boolean
  plan_mode: boolean
  created_at: string
  updated_at: string
}

export interface AISessionCreate {
  name: string
  messages?: string
  context_scope?: string
  use_summaries?: boolean
  include_linked_files?: boolean
  plan_mode?: boolean
}

export interface AISessionUpdate {
  name?: string
  messages?: string
  context_scope?: string
  use_summaries?: boolean
  include_linked_files?: boolean
  plan_mode?: boolean
}

// A null noteId targets the global (note-less) session endpoints; otherwise the
// note-scoped ones. This keeps a single call site working for both the editor
// (note-scoped) and the list view (global) AI Assistants.
const base = (noteId: string | null) => (noteId ? `/notes/${noteId}/ai-sessions` : '/ai-sessions')

export const aiSessionsApi = {
  list(noteId: string | null): Promise<AISession[]> {
    return client.get(base(noteId)).then((r) => r.data.data)
  },
  create(noteId: string | null, data: AISessionCreate): Promise<AISession> {
    return client.post(base(noteId), data).then((r) => r.data.data)
  },
  update(noteId: string | null, sessionId: string, data: AISessionUpdate): Promise<AISession> {
    return client.patch(`${base(noteId)}/${sessionId}`, data).then((r) => r.data.data)
  },
  remove(noteId: string | null, sessionId: string): Promise<void> {
    return client.delete(`${base(noteId)}/${sessionId}`).then(() => undefined)
  },
}
