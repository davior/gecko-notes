import client from './client'
import type { ListResponse } from './notes'

export interface Annotation {
  id: string
  note_id: string
  block_id: string
  text: string
  created_at: string
  modified_at: string
}

export const annotationsApi = {
  list(noteId: string): Promise<ListResponse<Annotation>> {
    return client.get(`/notes/${noteId}/annotations`).then((r) => r.data)
  },

  create(noteId: string, payload: { block_id: string; text?: string }): Promise<{ data: Annotation }> {
    return client.post(`/notes/${noteId}/annotations`, payload).then((r) => r.data)
  },

  update(noteId: string, id: string, payload: { text?: string; block_id?: string }): Promise<{ data: Annotation }> {
    return client.put(`/notes/${noteId}/annotations/${id}`, payload).then((r) => r.data)
  },

  delete(noteId: string, id: string): Promise<void> {
    return client.delete(`/notes/${noteId}/annotations/${id}`).then(() => undefined)
  },
}
