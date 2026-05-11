import client from './client'

export interface MediaUploadResponse {
  url: string
  filename: string
  mime_type: string
  size: number
}

export const mediaApi = {
  upload(file: File): Promise<{ data: MediaUploadResponse }> {
    const formData = new FormData()
    formData.append('file', file)
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
