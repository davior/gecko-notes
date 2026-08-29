import client from './client'

export interface MediaUploadResponse {
  url: string
  filename: string
  mime_type: string
  size: number
  note_id?: string | null
}

export const mediaApi = {
  // noteId registers the file in that note's assets, which is also the only chance to
  // keep the original filename — the file is stored under a UUID and the name is not
  // recoverable afterwards. An unknown or absent id is not an error: the server picks
  // the file up when the note is next saved.
  upload(file: File, noteId?: string | null): Promise<{ data: MediaUploadResponse }> {
    const formData = new FormData()
    formData.append('file', file)
    if (noteId) formData.append('note_id', noteId)
    return client
      .post('/media/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data)
  },

  delete(filename: string): Promise<void> {
    return client.delete(`/media/${filename}`).then(() => undefined)
  },
}
