import client from './client'

export interface TTSVoice {
  id: string
  label: string
}

// Curated Deepgram Aura / Aura-2 English voices (mirrors backend `_TTS_VOICES`).
export const TTS_VOICES: TTSVoice[] = [
  { id: 'aura-2-thalia-en', label: 'Thalia (Aura-2, female)' },
  { id: 'aura-2-andromeda-en', label: 'Andromeda (Aura-2, female)' },
  { id: 'aura-2-apollo-en', label: 'Apollo (Aura-2, male)' },
  { id: 'aura-2-arcas-en', label: 'Arcas (Aura-2, male)' },
  { id: 'aura-2-aries-en', label: 'Aries (Aura-2, male)' },
  { id: 'aura-asteria-en', label: 'Asteria (Aura, female)' },
  { id: 'aura-luna-en', label: 'Luna (Aura, female)' },
  { id: 'aura-stella-en', label: 'Stella (Aura, female)' },
  { id: 'aura-orion-en', label: 'Orion (Aura, male)' },
  { id: 'aura-zeus-en', label: 'Zeus (Aura, male)' },
]

export interface UsageTotal {
  kind: string
  count: number
  units: number
  unit_type: string
  cost?: number
  currency?: string
}

export interface UsageByDay {
  date: string
  kind: string
  units: number
}

export interface UsageEvent {
  kind: string
  model: string
  units: number
  unit_type: string
  cost?: number | null
  currency?: string | null
  created_at: string
}

export interface UsageSummary {
  days: number
  totals_by_kind: UsageTotal[]
  by_day: UsageByDay[]
  recent: UsageEvent[]
}

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
  max_tokens: number
  enabled: boolean
  is_active: boolean
}

export interface AIProviderCreate {
  name: string
  provider_type: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model: string
  max_tokens?: number
  enabled?: boolean
  is_active?: boolean
}

export interface AIProviderUpdate {
  name?: string
  provider_type?: 'anthropic' | 'openai' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model?: string
  max_tokens?: number
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

export interface FalModel {
  id: string
  label: string
}

export interface ImageSettings {
  has_api_key: boolean
  has_admin_key: boolean
  curated_models: FalModel[]
  image_sizes: string[]
  custom_models: string[]
  default_model: string
  image_size: string
}

export interface ImageSettingsUpdate {
  api_key?: string
  admin_api_key?: string
  default_model?: string
  custom_models?: string[]
  image_size?: string
}

export interface FalPrice {
  unit?: string | null
  unit_price: number
  currency?: string | null
}

export interface ImageEndpointSpend {
  endpoint_id: string
  cost?: number | null
  unit?: string | null
  unit_price?: number | null
  quantity?: number | null
  currency?: string | null
}

// fal.ai account billing/usage. `available:false` (+ note) when the account/usage API
// can't be read (no admin-scoped key or fal unreachable) — fall back to local totals.
export interface ImageUsage {
  available: boolean
  has_admin_key?: boolean
  days?: number
  currency?: string
  total_spend?: number
  by_endpoint?: ImageEndpointSpend[]
  prices?: Record<string, FalPrice>
  balance?: number
  balance_currency?: string
  note?: string
}

export interface ImagePricing {
  prices: Record<string, FalPrice>
  fetched_at?: string | null
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

  getSpeechSettings(): Promise<{ deepgram_api_key: string }> {
    return client.get('/settings/speech').then((r) => r.data)
  },

  updateSpeechSettings(payload: { deepgram_api_key: string }): Promise<void> {
    return client.put('/settings/speech', payload).then(() => undefined)
  },

  transcribeAudio(blob: Blob, model = 'nova-2'): Promise<string> {
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'
    const form = new FormData()
    form.append('file', blob, `recording.${ext}`)
    form.append('model', model)
    return client.post('/settings/speech/transcribe', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data.text as string)
  },

  synthesizeSpeech(text: string, model = 'aura-2-thalia-en', speed = 1): Promise<Blob> {
    return client.post('/settings/speech/tts', { text, model, speed }, {
      responseType: 'arraybuffer',
    }).then((r) => new Blob([r.data as ArrayBuffer], { type: 'audio/mpeg' }))
  },

  getUsage(days = 30): Promise<UsageSummary> {
    return client.get('/settings/usage', { params: { days } }).then((r) => r.data)
  },

  getImageSettings(): Promise<ImageSettings> {
    return client.get('/settings/images').then((r) => r.data)
  },

  updateImageSettings(payload: ImageSettingsUpdate): Promise<ImageSettings> {
    return client.put('/settings/images', payload).then((r) => r.data)
  },

  getImageUsage(days = 30): Promise<ImageUsage> {
    return client.get('/settings/images/usage', { params: { days } }).then((r) => r.data)
  },

  getImagePricing(): Promise<ImagePricing> {
    return client.get('/settings/images/pricing').then((r) => r.data)
  },
}
