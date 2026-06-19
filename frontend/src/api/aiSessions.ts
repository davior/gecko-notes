import client from './client'

export interface AISession {
  id: string
  note_id: string
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

export const aiSessionsApi = {
  list(noteId: string): Promise<AISession[]> {
    return client.get(`/notes/${noteId}/ai-sessions`).then((r) => r.data.data)
  },
  create(noteId: string, data: AISessionCreate): Promise<AISession> {
    return client.post(`/notes/${noteId}/ai-sessions`, data).then((r) => r.data.data)
  },
  update(noteId: string, sessionId: string, data: AISessionUpdate): Promise<AISession> {
    return client.patch(`/notes/${noteId}/ai-sessions/${sessionId}`, data).then((r) => r.data.data)
  },
  remove(noteId: string, sessionId: string): Promise<void> {
    return client.delete(`/notes/${noteId}/ai-sessions/${sessionId}`).then(() => undefined)
  },
}
