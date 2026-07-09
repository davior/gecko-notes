import client from './client'

export type CatalogKind = 'image' | 'tts' | 'stt'

export interface ModelCatalogEntry {
  id: string
  kind: CatalogKind
  model_id: string
  label: string
  maker_note: string | null
  sort_order: number
  is_active: boolean
  voices: string[] | null
  text_field: string | null
  voice_field: string | null
  extra_params: Record<string, unknown> | null
  created_at: string
}

export interface ModelCatalogEntryCreate {
  kind: CatalogKind
  model_id: string
  label: string
  maker_note?: string | null
  sort_order?: number
  is_active?: boolean
  voices?: string[] | null
  text_field?: string | null
  voice_field?: string | null
  extra_params?: Record<string, unknown> | null
}

export type ModelCatalogEntryUpdate = Partial<Omit<ModelCatalogEntryCreate, 'kind' | 'model_id'>>

export const modelCatalogApi = {
  list(kind?: CatalogKind): Promise<{ data: ModelCatalogEntry[] }> {
    return client.get('/settings/model-catalog', { params: kind ? { kind } : {} }).then((r) => r.data)
  },
  create(payload: ModelCatalogEntryCreate): Promise<{ data: ModelCatalogEntry }> {
    return client.post('/settings/model-catalog', payload).then((r) => r.data)
  },
  update(id: string, payload: ModelCatalogEntryUpdate): Promise<{ data: ModelCatalogEntry }> {
    return client.put(`/settings/model-catalog/${id}`, payload).then((r) => r.data)
  },
  remove(id: string): Promise<void> {
    return client.delete(`/settings/model-catalog/${id}`).then(() => undefined)
  },
}
