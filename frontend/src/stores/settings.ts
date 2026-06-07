import { create } from 'zustand'
import { settingsApi, type AIProvider, type SystemPrompt, type SystemPromptCreate, type SystemPromptUpdate, type Theme, type ThemeCreate, type ThemeUpdate } from '@/api/settings'
import { createAIService, type AIService, DEFAULT_SUMMARY_PROMPT } from '@/services/ai'

interface SettingsState {
  appSettings: Record<string, unknown>
  aiProviders: AIProvider[]
  aiService: AIService | null
  loading: boolean
  activeProvider: AIProvider | null
  defaultSortOrder: string
  theme: 'light' | 'dark'
  systemPrompts: SystemPrompt[]
  activeSystemPrompt: SystemPrompt | null
  aiTemperature: number
  aiPrefill: string
  summaryPrompt: string
  themes: Theme[]
  activeThemeId: string | null
  sharedThemeId: string | null
  deepgramApiKey: string
  loadSettings: () => Promise<void>
  updateSpeechSettings: (apiKey: string) => Promise<void>
  updateAppSettings: (settings: Record<string, unknown>) => Promise<void>
  loadAIProviders: () => Promise<void>
  createAIProvider: (payload: Parameters<typeof settingsApi.createAIProvider>[0]) => Promise<AIProvider>
  updateAIProvider: (id: string, payload: Parameters<typeof settingsApi.updateAIProvider>[1]) => Promise<AIProvider>
  deleteAIProvider: (id: string) => Promise<void>
  activateAIProvider: (id: string) => Promise<AIProvider>
  refreshAIService: () => void
  toggleTheme: () => void
  loadSystemPrompts: () => Promise<void>
  createSystemPrompt: (payload: SystemPromptCreate) => Promise<SystemPrompt>
  updateSystemPrompt: (id: string, payload: SystemPromptUpdate) => Promise<SystemPrompt>
  deleteSystemPrompt: (id: string) => Promise<void>
  activateSystemPrompt: (id: string) => Promise<SystemPrompt>
  loadThemes: () => Promise<void>
  createTheme: (payload: ThemeCreate) => Promise<Theme>
  updateTheme: (id: string, payload: ThemeUpdate) => Promise<Theme>
  deleteTheme: (id: string) => Promise<void>
  activateTheme: (id: string) => Promise<Theme>
  deactivateTheme: () => Promise<void>
  setSharedTheme: (id: string | null) => Promise<void>
  applyTheme: (theme: Theme | null) => void
  reset: () => void
}

function deriveActiveProvider(providers: AIProvider[]): AIProvider | null {
  return providers.find((p) => p.is_active && p.enabled) ?? null
}

function deriveActiveSystemPrompt(prompts: SystemPrompt[]): SystemPrompt | null {
  return prompts.find((p) => p.is_active) ?? null
}

const storedTheme = (localStorage.getItem('theme') as 'light' | 'dark') ?? 'light'

function deriveAIService(providers: AIProvider[]): AIService | null {
  const active = deriveActiveProvider(providers)
  return active ? createAIService(active) : null
}

export function applyThemeToDom(theme: Theme | null) {
  const root = document.documentElement
  if (!theme) {
    root.removeAttribute('data-glass')
    root.classList.remove('dark')
    ;[
      '--theme-bg', '--theme-bg-size', '--theme-bg-filter',
      '--glass-opacity', '--glass-blur', '--glass-rgb',
      '--shadow-size', '--shadow-blur', '--shadow-color',
    ].forEach((v) => root.style.removeProperty(v))
    return
  }

  // Background
  let bg = theme.bg_color1
  if (theme.bg_type === 'gradient' && theme.bg_color2) {
    bg = `linear-gradient(135deg, ${theme.bg_color1}, ${theme.bg_color2})`
  } else if (theme.bg_type === 'image' && theme.bg_image_url) {
    bg = `url(${theme.bg_image_url})`
  }
  const bgSize = theme.bg_image_mode === 'repeat' ? 'auto' : theme.bg_image_mode === 'stretch' ? '100% 100%' : 'cover'

  root.style.setProperty('--theme-bg', bg)
  root.style.setProperty('--theme-bg-size', bgSize)
  root.style.setProperty('--theme-bg-filter', theme.bg_blur > 0 ? `blur(${theme.bg_blur}px)` : 'none')
  root.style.setProperty('--glass-opacity', String(theme.glass_opacity))
  root.style.setProperty('--glass-blur', `${theme.glass_blur}px`)
  root.style.setProperty('--glass-rgb', theme.mode === 'dark' ? '0,0,0' : '255,255,255')
  root.style.setProperty('--shadow-size', `${theme.shadow_size}px`)
  root.style.setProperty('--shadow-blur', `${theme.shadow_blur}px`)
  root.style.setProperty('--shadow-color', theme.mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.25)')

  root.setAttribute('data-glass', theme.mode)
  if (theme.mode === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appSettings: {},
  aiProviders: [],
  aiService: null,
  loading: false,
  activeProvider: null,
  defaultSortOrder: 'modified_at',
  theme: storedTheme,
  systemPrompts: [],
  activeSystemPrompt: null,
  aiTemperature: 0.8,
  aiPrefill: '',
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  themes: [],
  activeThemeId: null,
  sharedThemeId: null,
  deepgramApiKey: '',

  async loadSettings() {
    set({ loading: true })
    try {
      const [settings, providers, prompts, themesResp] = await Promise.all([
        settingsApi.getAll(),
        settingsApi.listAIProviders(),
        settingsApi.listSystemPrompts(),
        settingsApi.listThemes(),
      ])
      const activeThemeId = (settings['active_theme_id'] as string) ?? null
      const sharedThemeId = (settings['shared_theme_id'] as string) ?? null
      const activeTheme = activeThemeId ? themesResp.data.find((t) => t.id === activeThemeId) ?? null : null
      applyThemeToDom(activeTheme)
      set({
        appSettings: settings,
        aiProviders: providers.data,
        activeProvider: deriveActiveProvider(providers.data),
        aiService: deriveAIService(providers.data),
        defaultSortOrder: (settings['default_sort_order'] as string) ?? 'modified_at',
        systemPrompts: prompts.data,
        activeSystemPrompt: deriveActiveSystemPrompt(prompts.data),
        aiTemperature: (settings['ai_temperature'] as number) ?? 0.8,
        aiPrefill: (settings['ai_prefill'] as string) ?? '',
        summaryPrompt: (settings['summary_prompt'] as string) || DEFAULT_SUMMARY_PROMPT,
        themes: themesResp.data,
        activeThemeId,
        sharedThemeId,
      })
    } finally {
      set({ loading: false })
    }
    // Speech settings are loaded separately so a missing endpoint never
    // breaks the rest of the settings load (e.g. old backend in dev).
    try {
      const speechSettings = await settingsApi.getSpeechSettings()
      set({ deepgramApiKey: speechSettings.deepgram_api_key })
    } catch { /* no speech endpoint — deepgramApiKey stays '' */ }
  },

  async updateSpeechSettings(apiKey) {
    await settingsApi.updateSpeechSettings({ deepgram_api_key: apiKey })
    set({ deepgramApiKey: apiKey ? '***' : '' })
  },

  async updateAppSettings(settings) {
    const updated = await settingsApi.update(settings)
    set({
      appSettings: updated,
      defaultSortOrder: (updated['default_sort_order'] as string) ?? 'modified_at',
      aiTemperature: (updated['ai_temperature'] as number) ?? 0.8,
      aiPrefill: (updated['ai_prefill'] as string) ?? '',
      summaryPrompt: (updated['summary_prompt'] as string) || DEFAULT_SUMMARY_PROMPT,
    })
  },

  async loadAIProviders() {
    const response = await settingsApi.listAIProviders()
    set({
      aiProviders: response.data,
      activeProvider: deriveActiveProvider(response.data),
      aiService: deriveAIService(response.data),
    })
  },

  async createAIProvider(payload) {
    const response = await settingsApi.createAIProvider(payload)
    set((s) => {
      const providers = [...s.aiProviders, response.data]
      return { aiProviders: providers, activeProvider: deriveActiveProvider(providers), aiService: deriveAIService(providers) }
    })
    return response.data
  },

  async updateAIProvider(id, payload) {
    const response = await settingsApi.updateAIProvider(id, payload)
    set((s) => {
      const providers = s.aiProviders.map((p) => (p.id === id ? response.data : p))
      return { aiProviders: providers, activeProvider: deriveActiveProvider(providers), aiService: deriveAIService(providers) }
    })
    return response.data
  },

  async deleteAIProvider(id) {
    await settingsApi.deleteAIProvider(id)
    set((s) => {
      const providers = s.aiProviders.filter((p) => p.id !== id)
      return { aiProviders: providers, activeProvider: deriveActiveProvider(providers), aiService: deriveAIService(providers) }
    })
  },

  async activateAIProvider(id) {
    const response = await settingsApi.activateAIProvider(id)
    set((s) => {
      const providers = s.aiProviders.map((p) => ({ ...p, is_active: p.id === id }))
      return { aiProviders: providers, activeProvider: deriveActiveProvider(providers), aiService: deriveAIService(providers) }
    })
    return response.data
  },

  refreshAIService() {
    const { aiProviders } = get()
    set({ activeProvider: deriveActiveProvider(aiProviders), aiService: deriveAIService(aiProviders) })
  },

  toggleTheme() {
    const next = get().theme === 'light' ? 'dark' : 'light'
    localStorage.setItem('theme', next)
    set({ theme: next })
  },

  async loadSystemPrompts() {
    const response = await settingsApi.listSystemPrompts()
    set({
      systemPrompts: response.data,
      activeSystemPrompt: deriveActiveSystemPrompt(response.data),
    })
  },

  async createSystemPrompt(payload) {
    const response = await settingsApi.createSystemPrompt(payload)
    set((s) => {
      const prompts = [...s.systemPrompts, response.data]
      return { systemPrompts: prompts, activeSystemPrompt: deriveActiveSystemPrompt(prompts) }
    })
    return response.data
  },

  async updateSystemPrompt(id, payload) {
    const response = await settingsApi.updateSystemPrompt(id, payload)
    set((s) => {
      const prompts = s.systemPrompts.map((p) => (p.id === id ? response.data : p))
      return { systemPrompts: prompts, activeSystemPrompt: deriveActiveSystemPrompt(prompts) }
    })
    return response.data
  },

  async deleteSystemPrompt(id) {
    await settingsApi.deleteSystemPrompt(id)
    set((s) => {
      const prompts = s.systemPrompts.filter((p) => p.id !== id)
      return { systemPrompts: prompts, activeSystemPrompt: deriveActiveSystemPrompt(prompts) }
    })
  },

  async activateSystemPrompt(id) {
    const response = await settingsApi.activateSystemPrompt(id)
    set((s) => {
      const prompts = s.systemPrompts.map((p) => ({ ...p, is_active: p.id === id }))
      return { systemPrompts: prompts, activeSystemPrompt: deriveActiveSystemPrompt(prompts) }
    })
    return response.data
  },

  async loadThemes() {
    const response = await settingsApi.listThemes()
    set({ themes: response.data })
  },

  async createTheme(payload) {
    const response = await settingsApi.createTheme(payload)
    set((s) => ({ themes: [...s.themes, response.data] }))
    return response.data
  },

  async updateTheme(id, payload) {
    const response = await settingsApi.updateTheme(id, payload)
    set((s) => ({ themes: s.themes.map((t) => (t.id === id ? response.data : t)) }))
    const { activeThemeId } = get()
    if (activeThemeId === id) applyThemeToDom(response.data)
    return response.data
  },

  async deleteTheme(id) {
    await settingsApi.deleteTheme(id)
    set((s) => ({ themes: s.themes.filter((t) => t.id !== id) }))
  },

  async activateTheme(id) {
    const response = await settingsApi.activateTheme(id)
    set({ activeThemeId: id })
    applyThemeToDom(response.data)
    return response.data
  },

  async deactivateTheme() {
    await settingsApi.deactivateTheme()
    set({ activeThemeId: null })
    applyThemeToDom(null)
  },

  async setSharedTheme(id) {
    await settingsApi.update({ shared_theme_id: id })
    set({ sharedThemeId: id })
  },

  applyTheme(theme) {
    applyThemeToDom(theme)
  },

  reset() {
    applyThemeToDom(null)
    set({
      appSettings: {},
      aiProviders: [],
      aiService: null,
      loading: false,
      activeProvider: null,
      defaultSortOrder: 'modified_at',
      systemPrompts: [],
      activeSystemPrompt: null,
      aiTemperature: 0.8,
      aiPrefill: '',
      summaryPrompt: DEFAULT_SUMMARY_PROMPT,
      themes: [],
      activeThemeId: null,
      sharedThemeId: null,
      deepgramApiKey: '',
      // theme is intentionally not reset — it is device-level, stored in localStorage
    })
  },
}))
