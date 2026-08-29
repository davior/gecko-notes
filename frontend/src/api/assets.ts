import client from './client'

/** A file belonging to a note — in its body, alongside it, or produced from it. */
export interface NoteAsset {
  id: string
  note_id: string
  url: string
  filename: string
  /** Resolved server-side: title > original_name > filename. */
  display_name: string
  original_name: string | null
  title: string | null
  description: string | null
  mime_type: string | null
  /** categorize_extension(): images | video | audio | documents | archives | data | other */
  kind: string
  /** How the file came to belong to the note: embedded | reference | export */
  origin: string
  size_bytes: number | null
  /** Set only when a thumbnail sidecar exists on disk. */
  thumb_url: string | null
  /** Whether the note's current content references this file. */
  in_note: boolean
  role: AssetRole
  /** Registered, but no longer on disk. */
  missing: boolean
  ai_context: boolean
  /** False for files no model can read (video, audio, archives). */
  ai_eligible: boolean
  created_at: string
}

export type AssetRole = 'in_note' | 'reference' | 'export' | 'detached'

export interface NoteAssetUpdate {
  title?: string | null
  description?: string | null
  origin?: string
  ai_context?: boolean
}

/** A file on disk that nothing references any more. */
export interface UnlinkedFile {
  filename: string
  url: string
  kind: string
  size_bytes: number
  modified_at: string
}

export interface UnlinkedScan {
  files: UnlinkedFile[]
  total_bytes: number
}

export const assetsApi = {
  list(noteId: string): Promise<{ data: NoteAsset[]; total: number }> {
    return client.get(`/notes/${noteId}/assets`).then((r) => r.data)
  },

  /**
   * Upload straight into a note's assets. Defaults to reference material on the server —
   * this does not put the file in the note body.
   */
  upload(noteId: string, file: File, origin?: string): Promise<{ data: NoteAsset }> {
    const formData = new FormData()
    formData.append('file', file)
    if (origin) formData.append('origin', origin)
    return client
      .post(`/notes/${noteId}/assets`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data)
  },

  update(noteId: string, assetId: string, payload: NoteAssetUpdate): Promise<{ data: NoteAsset }> {
    return client.patch(`/notes/${noteId}/assets/${assetId}`, payload).then((r) => r.data)
  },

  remove(noteId: string, assetId: string): Promise<void> {
    return client.delete(`/notes/${noteId}/assets/${assetId}`).then(() => undefined)
  },

  /**
   * Find media on disk that no note, note version, avatar or theme still uses.
   * Deliberately on demand — it walks every note version the user has.
   */
  scanUnlinked(): Promise<{ data: UnlinkedScan }> {
    return client.get('/assets/unlinked').then((r) => r.data)
  },

  deleteUnlinked(filename: string): Promise<void> {
    return client.delete(`/assets/unlinked/${encodeURIComponent(filename)}`).then(() => undefined)
  },

  adoptUnlinked(filename: string, noteId: string): Promise<{ data: NoteAsset }> {
    return client
      .post(`/assets/unlinked/${encodeURIComponent(filename)}/adopt`, { note_id: noteId })
      .then((r) => r.data)
  },
}

/** Pull the backend's `detail: {code, message}` out of an axios error. */
export function assetErrorMessage(e: unknown, fallback: string): string {
  const ax = e as { response?: { data?: { detail?: { message?: string } | string } } }
  const detail = ax.response?.data?.detail
  if (detail && typeof detail === 'object' && detail.message) return detail.message
  if (typeof detail === 'string') return detail
  return fallback
}
