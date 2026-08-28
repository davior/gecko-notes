import client from './client'

export interface TTSVoice {
  id: string
  label: string
}

// Curated fal.ai (ElevenLabs) TTS voices (mirrors backend `FAL_TTS_VOICES`).
export const DEFAULT_TTS_VOICE = 'Aria'
// Mirrors backend `DEFAULT_TTS_MODEL` — used before speech settings finish loading.
export const DEFAULT_TTS_MODEL = 'fal-ai/elevenlabs/tts/eleven-v3'
// Mirrors backend `DEFAULT_STT_MODEL` — used before speech settings finish loading.
export const DEFAULT_STT_MODEL = 'fal-ai/wizper'
// Mirrors backend `DEFAULT_DEEPGRAM_MODEL` — used before speech settings finish loading.
export const DEFAULT_DEEPGRAM_MODEL = 'nova-3'
// Mirrors backend `DEFAULT_DEEPGRAM_TTS_MODEL` — the default Deepgram Flux read-aloud voice.
export const DEFAULT_DEEPGRAM_TTS_MODEL = 'flux-haley-en'
// Mirrors backend `DEFAULT_DEEPGRAM_TTS_EXPRESSIVITY` — calm (-2) to animated (2).
export const DEFAULT_DEEPGRAM_TTS_EXPRESSIVITY = 0
// Mirrors backend `DEFAULT_DEEPGRAM_TTS_SPEED`/`DEEPGRAM_TTS_SPEED_MIN/MAX`.
export const DEFAULT_DEEPGRAM_TTS_SPEED = 1.0
export const DEEPGRAM_TTS_SPEED_MIN = 0.85
export const DEEPGRAM_TTS_SPEED_MAX = 1.15
export const TTS_VOICES: TTSVoice[] = [
  'Aria', 'Roger', 'Sarah', 'Laura', 'Charlie', 'George', 'Callum', 'River',
  'Liam', 'Charlotte', 'Alice', 'Matilda', 'Will', 'Jessica', 'Eric', 'Chris',
  'Brian', 'Daniel', 'Lily', 'Bill',
].map((name) => ({ id: name, label: name }))

export interface TTSModel {
  id: string
  label: string
  maker_note?: string | null
  voices: string[]
}

export interface STTModel {
  id: string
  label: string
  maker_note?: string | null
}

export interface CustomTTSModel {
  id: string
  voices: string[]
}

export type SttProvider = 'auto' | 'deepgram' | 'fal'
export type TtsProvider = 'auto' | 'deepgram' | 'fal'

export interface SpeechSettings {
  has_fal_key: boolean
  tts_models: TTSModel[]
  custom_tts_models: CustomTTSModel[]
  tts_model: string
  voices: string[]
  default_voice: string
  stt_models: STTModel[]
  stt_model: string
  has_deepgram_key: boolean
  stt_provider: SttProvider
  deepgram_model: string
  deepgram_models: STTModel[]
  // Read-aloud (TTS) provider: Deepgram Flux streaming with fal.ai as fallback.
  tts_provider: TtsProvider
  deepgram_tts_model: string
  deepgram_tts_models: STTModel[]
  // Calm (-2) to animated (2); Flux-only register offset from the voice's tuned default.
  deepgram_tts_expressivity: number
  // Playback-rate multiplier (0.85-1.15); Flux-only.
  deepgram_tts_speed: number
  // Per-user opt-in for Flux voice mode (also gated by the instance flag + a Deepgram key).
  voice_mode_enabled: boolean
}

export interface SpeechConfigUpdate {
  tts_model?: string
  custom_tts_models?: CustomTTSModel[]
  stt_model?: string
  stt_provider?: SttProvider
  deepgram_model?: string
  tts_provider?: TtsProvider
  deepgram_tts_model?: string
  deepgram_tts_expressivity?: number
  deepgram_tts_speed?: number
  voice_mode_enabled?: boolean
  // Tri-state, same convention as the fal.ai key elsewhere: omitted leaves the
  // stored key untouched, "" clears it, a non-empty value replaces it.
  deepgram_api_key?: string
}

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
  count: number
  units: number
  cost: number
}

export interface UsageProvider {
  provider: string
  count: number
  units: number
  cost: number
  currency?: string
  estimated: boolean
}

export interface UsageEvent {
  kind: string
  provider?: string | null
  model: string
  units: number
  unit_type: string
  cost?: number | null
  currency?: string | null
  cost_estimated?: boolean | null
  created_at: string
}

export interface UsageSummary {
  days: number
  totals_by_kind: UsageTotal[]
  by_provider: UsageProvider[]
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
  provider_type: 'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'custom'
  api_key: string
  base_url: string | null
  model: string
  max_tokens: number
  supports_images: boolean
  // Talk to this provider over the Anthropic Messages protocol rather than its default
  // one. Set on a DeepSeek provider it points at api.deepseek.com/anthropic, whose
  // server-side web_search tool DeepSeek runs itself — so the assistant searches the
  // web natively, with no third-party search backend.
  use_anthropic_api: boolean
  extra_params: Record<string, unknown> | null
  enabled: boolean
  is_active: boolean
}

export interface AIProviderCreate {
  name: string
  provider_type: 'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model: string
  max_tokens?: number
  supports_images?: boolean
  use_anthropic_api?: boolean
  extra_params?: Record<string, unknown> | null
  enabled?: boolean
  is_active?: boolean
}

export interface AIProviderUpdate {
  name?: string
  provider_type?: 'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model?: string
  max_tokens?: number
  supports_images?: boolean
  use_anthropic_api?: boolean
  extra_params?: Record<string, unknown> | null
  enabled?: boolean
  is_active?: boolean
}

export interface AIProviderTest {
  provider_id?: string
  provider_type: 'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'custom'
  api_key?: string
  base_url?: string | null
  model: string
  // Tests the Anthropic-compatible endpoint instead of the provider type's default one.
  use_anthropic_api?: boolean
}

export interface FalModel {
  id: string
  label: string
  maker_note?: string | null
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

export interface SubstackSettings {
  publication_url: string
  has_cookie: boolean
  configured: boolean
}

export interface SubstackSettingsUpdate {
  publication_url?: string
  // Tri-state, same convention as the fal/Deepgram keys: omitted leaves the stored
  // cookie untouched, "" clears it, a non-empty value replaces it.
  cookie?: string
}

export interface SubstackPublishResult {
  draft_id: string
  draft_url: string
}

// Which backend the assistant searches the web with (see api/search.ts). The
// available backends travel with the settings so the picker can't drift from the
// server's list.
export interface WebSearchProviderInfo {
  id: string
  label: string
  needs_api_key: boolean
  needs_base_url: boolean
}

export interface WebSearchSettings {
  provider: string
  base_url: string
  has_api_key: boolean
  // Whether the chosen backend has everything it needs to run a search.
  configured: boolean
  providers: WebSearchProviderInfo[]
}

export interface WebSearchSettingsUpdate {
  provider?: string
  base_url?: string
  // Tri-state, same convention as the fal/Deepgram keys: omitted leaves the stored
  // key untouched, "" clears it, a non-empty value replaces it.
  api_key?: string
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

  // Speech uses the shared fal.ai key (configured on the Providers tab, under
  // Media Provider); this reports whether that key is present so the UI can gate
  // read-aloud / dictation.
  getSpeechSettings(): Promise<SpeechSettings> {
    return client.get('/settings/speech').then((r) => r.data)
  },

  updateSpeechConfig(payload: SpeechConfigUpdate): Promise<{
    tts_model: string
    custom_tts_models: CustomTTSModel[]
    stt_model: string
    stt_provider: SttProvider
    deepgram_model: string
    tts_provider: TtsProvider
    deepgram_tts_model: string
    deepgram_tts_expressivity: number
    deepgram_tts_speed: number
    voice_mode_enabled: boolean
    has_deepgram_key: boolean
  }> {
    return client.put('/settings/speech/config', payload).then((r) => r.data)
  },

  transcribeAudio(blob: Blob): Promise<string> {
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'
    const form = new FormData()
    form.append('file', blob, `recording.${ext}`)
    return client.post('/settings/speech/transcribe', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data.text as string)
  },

  synthesizeSpeech(text: string, model = DEFAULT_TTS_VOICE): Promise<Blob> {
    return client.post('/settings/speech/tts', { text, model }, {
      responseType: 'arraybuffer',
    }).then((r) => new Blob([r.data as ArrayBuffer], { type: 'audio/mpeg' }))
  },

  // A whole passage as one MP3, with its pauses held as real silence between
  // the chunks. Only the backend can do that — it has ffmpeg — which is why
  // this exists alongside synthesizeSpeech's single-chunk request. It splits
  // the text exactly as chunkText does, so anything already played is served
  // from the server's TTS cache rather than synthesised again.
  narrateSpeech(text: string, model = DEFAULT_TTS_VOICE): Promise<Blob> {
    return client.post('/settings/speech/narrate', { text, model }, {
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

  getSubstackSettings(): Promise<SubstackSettings> {
    return client.get('/settings/substack').then((r) => r.data)
  },

  updateSubstackSettings(payload: SubstackSettingsUpdate): Promise<SubstackSettings> {
    return client.put('/settings/substack', payload).then((r) => r.data)
  },

  publishToSubstack(payload: { title: string; markdown: string; subtitle?: string; tags?: string[] }): Promise<SubstackPublishResult> {
    return client.post('/settings/substack/publish', payload).then((r) => r.data)
  },

  testSubstackConnection(payload: { publication_url?: string; cookie?: string }): Promise<{ success: boolean; message: string }> {
    return client.post('/settings/substack/test', payload).then((r) => r.data)
  },

  getWebSearchSettings(): Promise<WebSearchSettings> {
    return client.get('/settings/web-search').then((r) => r.data)
  },

  updateWebSearchSettings(payload: WebSearchSettingsUpdate): Promise<WebSearchSettings> {
    return client.put('/settings/web-search', payload).then((r) => r.data)
  },

  testWebSearch(payload: { provider?: string; api_key?: string; base_url?: string }): Promise<{ success: boolean; message: string }> {
    return client.post('/settings/web-search/test', payload).then((r) => r.data)
  },
}
