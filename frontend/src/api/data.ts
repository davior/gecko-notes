import client from './client'

export interface ExportManifest {
  total_parts: number
}

export interface ImportUploadResult {
  session_id: string
  has_data_json: boolean
  media_count: number
}

export interface ImportApplyResult {
  imported_notes: number
  imported_categories: number
  imported_media: number
}

const dataApi = {
  async getExportManifest(): Promise<ExportManifest> {
    const res = await client.get<{ data: ExportManifest }>('/data/export/manifest')
    return res.data.data
  },

  async downloadExportPart(partNum: number): Promise<{ blob: Blob; filename: string }> {
    const res = await client.get(`/data/export/part/${partNum}`, {
      responseType: 'blob',
    })
    const disposition: string = res.headers['content-disposition'] ?? ''
    const match = disposition.match(/filename="?([^"]+)"?/)
    const filename = match ? match[1] : `gecko-notes-export-part${partNum + 1}.zip`
    return { blob: res.data as Blob, filename }
  },

  async uploadImportPart(file: File, sessionId?: string): Promise<ImportUploadResult> {
    const form = new FormData()
    form.append('file', file)
    if (sessionId) {
      form.append('session_id', sessionId)
    }
    const res = await client.post<{ data: ImportUploadResult }>('/data/import/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return res.data.data
  },

  async applyImport(sessionId: string): Promise<ImportApplyResult> {
    const res = await client.post<{ data: ImportApplyResult }>('/data/import/apply', {
      session_id: sessionId,
    })
    return res.data.data
  },
}

export default dataApi
