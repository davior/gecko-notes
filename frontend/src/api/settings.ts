import client from './client'

export interface SystemPrompt {
  id: string
  name: string
  content: string
  is_active: boolean
  sort_order: number
}

export interface SystemPromptCreate {
  name: string
  content: string
  is_active?: boolean
  sort_order?: number
}

export interface SystemPromptUpdate {
  name?: string
  content?: string
  is_active?: boolean
  sort_order?: number
}

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
  provider_id?: string
  provider_type: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model: string
}

export interface Theme {
  id: string
  name: string
  user_id: string | null
  is_global: boolean
  mode: 'light' | 'dark'
  bg_type: 'flat' | 'gradient' | 'image'
  bg_color1: string
  bg_color2: string | null
  bg_image_url: string | null
  bg_image_mode: 'repeat' | 'stretch' | 'fill'
  bg_blur: number
  glass_opacity: number
  glass_blur: number
  shadow_size: number
  shadow_blur: number
  created_at: string
}

export interface ThemeCreate {
  name: string
  is_global?: boolean
  mode?: 'light' | 'dark'
  bg_type?: 'flat' | 'gradient' | 'image'
  bg_color1?: string
  bg_color2?: string | null
  bg_image_url?: string | null
  bg_image_mode?: 'repeat' | 'stretch' | 'fill'
  bg_blur?: number
  glass_opacity?: number
  glass_blur?: number
  shadow_size?: number
  shadow_blur?: number
}

export interface ThemeUpdate {
  name?: string
  is_global?: boolean
  mode?: 'light' | 'dark'
  bg_type?: 'flat' | 'gradient' | 'image'
  bg_color1?: string
  bg_color2?: string | null
  bg_image_url?: string | null
  bg_image_mode?: 'repeat' | 'stretch' | 'fill'
  bg_blur?: number
  glass_opacity?: number
  glass_blur?: number
  shadow_size?: number
  shadow_blur?: number
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

  listSystemPrompts(): Promise<{ data: SystemPrompt[]; total: number; limit: number; offset: number }> {
    return client.get('/settings/system-prompts').then((r) => r.data)
  },

  createSystemPrompt(payload: SystemPromptCreate): Promise<{ data: SystemPrompt }> {
    return client.post('/settings/system-prompts', payload).then((r) => r.data)
  },

  updateSystemPrompt(id: string, payload: SystemPromptUpdate): Promise<{ data: SystemPrompt }> {
    return client.put(`/settings/system-prompts/${id}`, payload).then((r) => r.data)
  },

  deleteSystemPrompt(id: string): Promise<void> {
    return client.delete(`/settings/system-prompts/${id}`).then(() => undefined)
  },

  activateSystemPrompt(id: string): Promise<{ data: SystemPrompt }> {
    return client.post(`/settings/system-prompts/${id}/activate`).then((r) => r.data)
  },

  listThemes(): Promise<{ data: Theme[]; total: number; limit: number; offset: number }> {
    return client.get('/settings/themes').then((r) => r.data)
  },

  createTheme(payload: ThemeCreate): Promise<{ data: Theme }> {
    return client.post('/settings/themes', payload).then((r) => r.data)
  },

  updateTheme(id: string, payload: ThemeUpdate): Promise<{ data: Theme }> {
    return client.put(`/settings/themes/${id}`, payload).then((r) => r.data)
  },

  deleteTheme(id: string): Promise<void> {
    return client.delete(`/settings/themes/${id}`).then(() => undefined)
  },

  activateTheme(id: string): Promise<{ data: Theme }> {
    return client.post(`/settings/themes/${id}/activate`).then((r) => r.data)
  },

  deactivateTheme(): Promise<void> {
    return client.delete('/settings/themes/activate').then(() => undefined)
  },

  transcribeAudio(providerId: string, blob: Blob): Promise<string> {
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'
    const form = new FormData()
    form.append('provider_id', providerId)
    form.append('file', blob, `recording.${ext}`)
    return client.post('/settings/ai-providers/proxy/whisper', form).then((r) => r.data.text as string)
  },
}
