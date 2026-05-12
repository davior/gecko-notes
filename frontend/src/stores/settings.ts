import { create } from 'zustand'
import { settingsApi, type AIProvider } from '@/api/settings'
import { createAIService, type AIService } from '@/services/ai'

interface SettingsState {
  appSettings: Record<string, unknown>
  aiProviders: AIProvider[]
  aiService: AIService | null
  loading: boolean
  activeProvider: AIProvider | null
  defaultSortOrder: string
  theme: 'light' | 'dark'
  loadSettings: () => Promise<void>
  updateAppSettings: (settings: Record<string, unknown>) => Promise<void>
  loadAIProviders: () => Promise<void>
  createAIProvider: (payload: Parameters<typeof settingsApi.createAIProvider>[0]) => Promise<AIProvider>
  updateAIProvider: (id: string, payload: Parameters<typeof settingsApi.updateAIProvider>[1]) => Promise<AIProvider>
  deleteAIProvider: (id: string) => Promise<void>
  activateAIProvider: (id: string) => Promise<AIProvider>
  refreshAIService: () => void
  toggleTheme: () => void
}

function deriveActiveProvider(providers: AIProvider[]): AIProvider | null {
  return providers.find((p) => p.is_active && p.enabled) ?? null
}

function applyTheme(theme: 'light' | 'dark') {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
}

const storedTheme = (localStorage.getItem('theme') as 'light' | 'dark') ?? 'light'
applyTheme(storedTheme)

function deriveAIService(providers: AIProvider[]): AIService | null {
  const active = deriveActiveProvider(providers)
  return active ? createAIService(active) : null
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  appSettings: {},
  aiProviders: [],
  aiService: null,
  loading: false,
  activeProvider: null,
  defaultSortOrder: 'modified_at',
  theme: storedTheme,

  async loadSettings() {
    set({ loading: true })
    try {
      const [settings, providers] = await Promise.all([
        settingsApi.getAll(),
        settingsApi.listAIProviders(),
      ])
      set({
        appSettings: settings,
        aiProviders: providers.data,
        activeProvider: deriveActiveProvider(providers.data),
        aiService: deriveAIService(providers.data),
        defaultSortOrder: (settings['default_sort_order'] as string) ?? 'modified_at',
      })
    } finally {
      set({ loading: false })
    }
  },

  async updateAppSettings(settings) {
    const updated = await settingsApi.update(settings)
    set({
      appSettings: updated,
      defaultSortOrder: (updated['default_sort_order'] as string) ?? 'modified_at',
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
    applyTheme(next)
    set({ theme: next })
  },
}))
