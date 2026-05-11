import client from './client'

export interface AIProvider {
  id: string
  name: string
  provider_type: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key: string
  base_url: string | null
  model: string
  enabled: boolean
  is_active: boolean
}

export interface AIProviderCreate {
  name: string
  provider_type: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model: string
  enabled?: boolean
  is_active?: boolean
}

export interface AIProviderUpdate {
  name?: string
  provider_type?: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model?: string
  enabled?: boolean
  is_active?: boolean
}

export interface AIProviderTest {
  provider_type: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model: string
}

export const settingsApi = {
  getAll(): Promise<Record<string, unknown>> {
    return client.get('/settings').then((r) => r.data)
  },

  update(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    return client.put('/settings', { settings }).then((r) => r.data)
  },

  listAIProviders(): Promise<{
    data: AIProvider[]
    total: number
    limit: number
    offset: number
  }> {
    return client.get('/settings/ai-providers').then((r) => r.data)
  },

  createAIProvider(payload: AIProviderCreate): Promise<{ data: AIProvider }> {
    return client.post('/settings/ai-providers', payload).then((r) => r.data)
  },

  updateAIProvider(id: string, payload: AIProviderUpdate): Promise<{ data: AIProvider }> {
    return client.put(`/settings/ai-providers/${id}`, payload).then((r) => r.data)
  },

  deleteAIProvider(id: string): Promise<void> {
    return client.delete(`/settings/ai-providers/${id}`).then(() => undefined)
  },

  activateAIProvider(id: string): Promise<{ data: AIProvider }> {
    return client.post(`/settings/ai-providers/${id}/activate`).then((r) => r.data)
  },

  testAIProvider(payload: AIProviderTest): Promise<{ success: boolean; message: string }> {
    return client.post('/settings/ai-providers/test', payload).then((r) => r.data)
  },
}
